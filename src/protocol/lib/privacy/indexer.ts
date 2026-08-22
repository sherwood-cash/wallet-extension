// Client for the Robinhood mixer indexer backend. Replaces the in-browser
// eth_getLogs scan: commitments are paged by leaf index and the spent set is
// fetched in one call. Everything is namespaced by assetId, because the vault
// keeps a separate Merkle tree per registered asset.
//
// HTTP contract (backend must match; assetId is the decimal uint256 string):
//   GET /params                                 -> { merkleTreeHeight, treeCapacity, ... }
//   GET /assets/<assetId>/status                -> { lastLeafIndex: number, settledIndex: number|null }
//   GET /assets/status                          -> { assets: { <assetId>: { lastLeafIndex, settledIndex } } }
//   GET /assets/<assetId>/utxos?fromIndex&limit -> { utxos: [{ commitment, index, encryptedOutput }] }
//   GET /nullifiers                             -> { nullifiers: string[] }
import { BigNumber } from 'ethers'
import { DEPLOYMENT } from '../../config'
import { MERKLE_TREE_HEIGHT } from './utils'
import type { CommitmentEvent } from './tree'
import { loadLeaves, saveLeaves, clearAsset } from './leafCache'

const PAGE = 10000 // max rows per /utxos page (the backend clamps `limit` to 10 000)

// Configured base URL (trailing slash trimmed), or null when no indexer is set.
// VITE_INDEXER_URL env var wins; otherwise fall back to deployment.json.
function base(): string | null {
  const env = (import.meta as any).env?.VITE_INDEXER_URL as string | undefined
  const url = (env || DEPLOYMENT.indexerUrl || '').trim()
  return url ? url.replace(/\/+$/, '') : null
}

export function indexerEnabled(): boolean {
  return base() !== null
}

/** The configured indexer base URL (trailing slash trimmed), or null. */
export function indexerBaseUrl(): string | null {
  return base()
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`indexer ${res.status} ${res.statusText} for ${url}`)
  return res.json()
}

interface StatusResponse {
  lastLeafIndex: number
  /** Exclusive frontier below which a leaf is settled and safe to persist. Absent on an
   *  older indexer — which simply means nothing is cached and the scan behaves as before. */
  settledIndex?: number | null
}

interface ParamsResponse {
  chainId?: number
  vault?: string | null
  merkleTreeHeight?: number
  treeCapacity?: string
}

// The indexer splits a global leaf index into (epoch, localIndex) using ITS OWN configured
// tree height, and so do we. If the two disagree, every note is filed at the wrong local
// index — which feeds the nullifier, so the notes come out unspendable with no error
// anywhere. Verify once per session and refuse to scan on a mismatch.
let paramsCheck: Promise<void> | null = null

async function assertParamsMatch(b: string): Promise<void> {
  if (!paramsCheck) {
    paramsCheck = (async () => {
      // deployment.json carries the height the vault was deployed with; it must agree with
      // the circuit constant before we even ask the indexer.
      if (DEPLOYMENT.merkleTreeHeight !== undefined && DEPLOYMENT.merkleTreeHeight !== MERKLE_TREE_HEIGHT) {
        throw new Error(
          `deployment merkleTreeHeight=${DEPLOYMENT.merkleTreeHeight} but the circuit uses ` +
            `${MERKLE_TREE_HEIGHT} — refusing to scan (notes would be unspendable)`,
        )
      }
      const p = (await getJson(`${b}/params`)) as ParamsResponse
      if (p.merkleTreeHeight !== undefined && p.merkleTreeHeight !== MERKLE_TREE_HEIGHT) {
        throw new Error(
          `indexer merkleTreeHeight=${p.merkleTreeHeight} but the circuit uses ` +
            `${MERKLE_TREE_HEIGHT} — refusing to scan (notes would be unspendable)`,
        )
      }
      const expectedCapacity = 2 ** MERKLE_TREE_HEIGHT
      if (p.treeCapacity !== undefined && Number(p.treeCapacity) !== expectedCapacity) {
        throw new Error(
          `indexer treeCapacity=${p.treeCapacity} but the circuit uses ${expectedCapacity} ` +
            `— refusing to scan (notes would be unspendable)`,
        )
      }
      // Pointing at an indexer for another vault or chain yields an empty balance rather
      // than a corrupt one, so warn instead of blocking.
      if (p.vault && DEPLOYMENT.vault && p.vault.toLowerCase() !== DEPLOYMENT.vault.toLowerCase()) {
        console.warn(`indexer serves vault ${p.vault}, deployment expects ${DEPLOYMENT.vault}`)
      }
      if (p.chainId !== undefined && p.chainId !== DEPLOYMENT.chainId) {
        console.warn(`indexer is on chain ${p.chainId}, deployment expects ${DEPLOYMENT.chainId}`)
      }
    })().catch((e) => {
      paramsCheck = null // a transient failure must not poison the rest of the session
      throw e
    })
  }
  return paramsCheck
}


// The first page of every asset in a scan, in one request.
//
// A scan asks each asset for its leaves at the same moment, so N assets meant N GETs that
// all queued behind the browser's per-host limit for the same snapshot. GET /assets/utxos
// takes them together — with a cursor PER asset (`assetId:index`), because each tree
// resumes at its own cached frontier and forcing one cursor on all of them would
// re-download everything the others already had.
//
// Only the FIRST page is batched. A page is 10 000 rows, so an asset needing a second one
// is rare, and pretending to paginate a dozen trees in lockstep would mean holding the
// whole batch at the speed of its deepest tree. Subsequent pages use the per-asset route,
// which is also the fallback here: an indexer without this endpoint (or an asset missing
// from the answer) simply gets served the old way, so the contract holds either way.
const MAX_BULK = 32 // the backend clamps the list at 32 assets

let pageBatch: { reqs: Map<string, number>; promise: Promise<Map<string, CommitmentEvent[]>> } | null =
  null

function fetchFirstPage(b: string, id: string, fromIndex: number): Promise<CommitmentEvent[] | null> {
  // Already enlisted at a DIFFERENT cursor: two callers want different rows for one asset,
  // which one response cannot serve. Send this one down the per-asset path.
  if (pageBatch && pageBatch.reqs.has(id) && pageBatch.reqs.get(id) !== fromIndex) {
    return Promise.resolve(null)
  }

  if (!pageBatch) {
    const reqs = new Map<string, number>()
    const promise = new Promise<Map<string, CommitmentEvent[]>>((resolve) => {
      // A macrotask: long enough for every asset of one scan to enlist, short enough that
      // nothing waits on a human timescale.
      setTimeout(async () => {
        // Cleared first, so anything arriving during the fetch opens the NEXT batch rather
        // than joining one already in flight.
        pageBatch = null
        const out = new Map<string, CommitmentEvent[]>()
        const entries = [...reqs]
        for (let i = 0; i < entries.length; i += MAX_BULK) {
          const chunk = entries.slice(i, i + MAX_BULK)
          const list = chunk.map(([asset, from]) => `${asset}:${from}`).join(',')
          try {
            const data = await getJson(`${b}/assets/utxos?assets=${list}&limit=${PAGE}`)
            const assets = (data?.assets ?? {}) as Record<string, { utxos?: CommitmentEvent[] }>
            for (const [asset, payload] of Object.entries(assets)) {
              out.set(asset, payload.utxos ?? [])
            }
          } catch {
            /* endpoint missing or the call failed — every caller in this chunk falls back */
          }
        }
        resolve(out)
      }, 0)
    })
    pageBatch = { reqs, promise }
  }

  pageBatch.reqs.set(id, fromIndex)
  return pageBatch.promise.then((m) => m.get(id) ?? null)
}

// Pull every commitment for one asset, ordered by global leaf index.
//
// Paging is a CURSOR on the global index (`fromIndex`), never a scan of the index space:
// indices jump by a full tree capacity (2**26) at each epoch rotation, so walking fixed
// [start, end) windows from 0 would spend ~6 700 empty requests to cross a single
// rotation. /utxos returns the next PAGE rows with leaf_index >= fromIndex, which steps
// straight over the gap between two trees.
//
// The cursor STARTS at whatever leafCache already holds, so a warm client fetches only the
// tail instead of re-downloading every tree on every poll. The cache is public on-chain data
// and is only ever written below the indexer's settled frontier — see leafCache.ts, where the
// reasoning about what may be pinned lives.
//
// This deliberately says nothing about which epoch is LIVE — the indexer cannot know, it
// only sees leaves. That answer comes from the vault itself (see fetchLiveEpoch in tree.ts).
export async function fetchCommitmentsFromIndexer(assetId: BigNumber): Promise<CommitmentEvent[]> {
  const b = base()
  if (!b) throw new Error('indexer not configured')
  await assertParamsMatch(b)
  const id = assetId.toString()

  const status = await fetchStatus(b, id)
  const last = status.lastLeafIndex
  const settledIndex = typeof status.settledIndex === 'number' ? status.settledIndex : null

  if (last < 0) {
    // The indexer holds no leaves for this asset. It is the only source this app trusts
    // (see the note on scanNotes), so a cache that disagrees is stale by definition.
    await clearAsset(id)
    return []
  }

  let cached = await loadLeaves(id)
  // A RETREATING frontier means the indexer no longer vouches for leaves we already pinned —
  // a gap opened below the old watermark, or it lost state. Either way what we hold is no
  // longer known-good, and a wrong leaf is worse than a slow scan.
  if (settledIndex !== null && settledIndex < cached.cachedUpTo) {
    console.warn(
      `[indexer] asset ${id}: settled frontier retreated ${cached.cachedUpTo} -> ${settledIndex} — refetching`,
    )
    await clearAsset(id)
    cached = { leaves: [], cachedUpTo: 0 }
  }

  const commitments: CommitmentEvent[] = [...cached.leaves]

  let fromIndex = cached.cachedUpTo
  let firstPage = true
  while (fromIndex <= last) {
    // The opening page rides the batch with every other asset in this scan; the rest, and
    // anything the batch could not serve, go through the per-asset route.
    let page = firstPage ? await fetchFirstPage(b, id, fromIndex) : null
    firstPage = false
    if (page === null) {
      const data = await getJson(`${b}/assets/${id}/utxos?fromIndex=${fromIndex}&limit=${PAGE}`)
      page = (data.utxos ?? []) as CommitmentEvent[]
    }
    if (!page.length) break // reached the head
    for (const u of page) {
      commitments.push({
        commitment: u.commitment,
        index: u.index,
        encryptedOutput: u.encryptedOutput,
        swapAmount: u.swapAmount ?? null,
      })
    }
    // Rows come back ordered by leaf_index, so the last one is the highest. Advancing past
    // it guarantees forward progress; anything else means a broken response, and looping
    // on it would hang the scan.
    const highest = page[page.length - 1].index
    if (!(highest >= fromIndex)) break
    fromIndex = highest + 1
  }
  commitments.sort((a, b) => a.index - b.index)

  // Extend the on-disk prefix with whatever has settled since the last scan. Best-effort by
  // construction: this scan already has its answer in memory, so a write that fails only
  // costs the next scan a longer fetch.
  await saveLeaves(id, commitments, settledIndex, cached.cachedUpTo)

  return commitments
}

// A scan runs per-asset, and each asset opened with its own GET /assets/<id>/status — N
// near-simultaneous round-trips for one snapshot of the indexer. GET /assets/status returns
// every asset's status at once; coalesce the concurrent callers onto a single in-flight batch
// fetch (cleared as soon as it settles, so the next scan cycle reads fresh) and serve each
// asset from the shared map.
//
// An older indexer without the batch route — or an asset with no commitments, which is absent
// from the batch — falls back to the per-asset route, so the contract holds either way.
let statusBatchInflight: Promise<Map<string, StatusResponse>> | null = null

async function fetchAllStatuses(b: string): Promise<Map<string, StatusResponse>> {
  if (statusBatchInflight) return statusBatchInflight
  statusBatchInflight = (async () => {
    try {
      const data = await getJson(`${b}/assets/status`)
      const map = new Map<string, StatusResponse>()
      for (const [id, s] of Object.entries((data?.assets ?? {}) as Record<string, StatusResponse>)) {
        map.set(id, s)
      }
      return map
    } finally {
      statusBatchInflight = null
    }
  })()
  return statusBatchInflight
}

async function fetchStatus(b: string, id: string): Promise<StatusResponse> {
  try {
    const hit = (await fetchAllStatuses(b)).get(id)
    if (hit) return hit
  } catch {
    /* batch route unavailable (older indexer) — fall through to the per-asset read */
  }
  return (await getJson(`${b}/assets/${id}/status`)) as StatusResponse
}

// The spent-nullifier set, lowercased for case-insensitive lookup. Nullifiers are
// GLOBAL in this vault — NewNullifier(bytes32) carries no assetId, so the indexer
// serves one flat set at /nullifiers (not per-asset). The assetId arg is kept for
// call-site symmetry with fetchCommitmentsFromIndexer; membership alone decides
// spentness, so a global set is correct.
//
// A scan runs per-asset and each asset asks for this same global set, so N assets fired
// N identical GET /nullifiers at once. Coalesce concurrent calls onto one in-flight
// request: the burst collapses to a single fetch, and the next scan cycle fetches fresh
// (the pending promise is cleared as soon as it settles, so there is no staleness).
let nullifiersInflight: Promise<Set<string>> | null = null

export async function fetchNullifiersFromIndexer(_assetId: BigNumber): Promise<Set<string>> {
  const b = base()
  if (!b) throw new Error('indexer not configured')
  if (nullifiersInflight) return nullifiersInflight
  nullifiersInflight = (async () => {
    try {
      const data = await getJson(`${b}/nullifiers`)
      return new Set((data.nullifiers as string[]).map((n) => n.toLowerCase()))
    } finally {
      nullifiersInflight = null
    }
  })()
  return nullifiersInflight
}
