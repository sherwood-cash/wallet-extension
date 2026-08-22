// On-disk cache of the PUBLIC commitment stream, so a scan downloads only what it has not
// seen instead of rebuilding every tree from leaf 0 on every single poll.
//
// What is stored is exactly what `/assets/:asset/utxos` returns — commitments and their
// encrypted blobs — all of it already public on-chain. Nothing about WHICH notes belong to
// this wallet is written anywhere: that link lives inside the blob, and opening it needs a
// key this module never sees. The one thing the cache does leak locally is which assets this
// browser watched, the same exposure syncCache.ts already takes and for the same reason —
// it is a cache, so throwing it away costs a slower scan, never correctness.
//
// THE RULE, and the whole reason this file is careful:
//
//   a leaf is persisted only once the indexer has declared it settled.
//
// `settledIndex` (on `/assets/:asset/status`) is the exclusive frontier below which a leaf
// can no longer be rewritten by a reorg, can no longer have a gap opened beneath it by late
// backfill, and is no longer waiting on a swap amount. Cache strictly below it and the stored
// prefix is valid forever. Cache one leaf above it and a stale value silently yields a WRONG
// Merkle root — and the only symptom is notes that refuse to prove, with no error pointing
// back here. Everything below therefore fails toward "cache less".
import { DEPLOYMENT } from '../../config'
import type { CommitmentEvent } from './tree'

const DB_NAME = 'sherwood-leaves'
const DB_VERSION = 1
const CHUNK_STORE = 'chunks'
const META_STORE = 'meta'

/**
 * Leaves per stored record.
 *
 * A power of two, and smaller than any tree capacity, so a chunk can never straddle an epoch
 * boundary: epochs start at multiples of 2**MERKLE_TREE_HEIGHT, which is a multiple of 512.
 *
 * It also sets how much the tail costs. Only WHOLE chunks are persisted, so each scan
 * re-fetches at most CHUNK-1 leaves past the last aligned boundary — the price of never
 * having to rewrite a record we already committed to.
 */
export const CHUNK = 512

/** Bump to invalidate every cache after a format change. */
const SCHEMA = 'v1'

/** Scope every key to the deployment: a redeploy or a chain switch must never resurrect
 *  leaves belonging to a different vault. */
function scope(): string {
  return `${SCHEMA}:${DEPLOYMENT.chainId}:${(DEPLOYMENT.vault ?? 'novault').toLowerCase()}`
}

const metaKey = (assetId: string) => `${scope()}:${assetId}`
const chunkKey = (assetId: string, chunk: number) => `${scope()}:${assetId}:${chunk}`

interface MetaRecord {
  key: string
  /** exclusive: the cache holds EVERY leaf that exists below this global index */
  cachedUpTo: number
  /** how many leaves that prefix actually contains — a checksum against partial loss */
  count: number
}

interface ChunkRecord {
  key: string
  leaves: CommitmentEvent[]
}

// ---- IndexedDB plumbing ----------------------------------------------------
//
// Every entry point swallows its errors and degrades to "no cache". A browser in private
// mode, a storage quota, a user clearing site data — none of those are failures worth taking
// a scan down for; they just mean the scan does what it always did.

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null)
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      return resolve(null)
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(CHUNK_STORE)) db.createObjectStore(CHUNK_STORE, { keyPath: 'key' })
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'key' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
  return dbPromise
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** All chunk records for one asset. Keys are `<scope>:<assetId>:<chunk>`, so a bounded
 *  prefix range pulls exactly this asset's records and nothing else. */
async function readChunks(db: IDBDatabase, assetId: string): Promise<ChunkRecord[]> {
  const prefix = `${scope()}:${assetId}:`
  const tx = db.transaction(CHUNK_STORE, 'readonly')
  const range = IDBKeyRange.bound(prefix, prefix + '￿', false, false)
  return promisify(tx.objectStore(CHUNK_STORE).getAll(range) as IDBRequest<ChunkRecord[]>)
}

// ---- public API ------------------------------------------------------------

export interface CachedLeaves {
  /** every cached leaf, ascending by global index; covers [0, cachedUpTo) */
  leaves: CommitmentEvent[]
  /** exclusive frontier the cache is complete up to — where a scan may resume fetching */
  cachedUpTo: number
}

const EMPTY: CachedLeaves = { leaves: [], cachedUpTo: 0 }

/**
 * The cached prefix for one asset, or an empty one if there is nothing usable.
 *
 * The stored leaf count is verified against the metadata before anything is returned. A
 * mismatch means records were lost independently of the watermark (eviction, an interrupted
 * write), which would leave a HOLE in the tree and therefore a wrong root — so a mismatch
 * discards the asset's cache rather than trying to repair it.
 */
export async function loadLeaves(assetId: string): Promise<CachedLeaves> {
  try {
    const db = await openDb()
    if (!db) return EMPTY

    const metaTx = db.transaction(META_STORE, 'readonly')
    const meta = (await promisify(
      metaTx.objectStore(META_STORE).get(metaKey(assetId)) as IDBRequest<MetaRecord | undefined>,
    )) as MetaRecord | undefined
    if (!meta || meta.cachedUpTo <= 0) return EMPTY

    const chunks = await readChunks(db, assetId)
    const leaves = chunks.flatMap((c) => c.leaves).sort((a, b) => a.index - b.index)

    if (leaves.length !== meta.count) {
      console.warn(
        `[leafCache] asset ${assetId}: expected ${meta.count} cached leaves, found ${leaves.length} — discarding`,
      )
      await clearAsset(assetId)
      return EMPTY
    }
    // Nothing at or above the watermark may be served: the watermark is precisely the claim
    // "everything below is complete", and it says nothing about what sits above.
    if (leaves.length && leaves[leaves.length - 1].index >= meta.cachedUpTo) {
      console.warn(`[leafCache] asset ${assetId}: leaf beyond the watermark — discarding`)
      await clearAsset(assetId)
      return EMPTY
    }
    return { leaves, cachedUpTo: meta.cachedUpTo }
  } catch {
    return EMPTY
  }
}

/**
 * Persist the newly settled part of a scan.
 *
 * `leaves` must be the asset's COMPLETE leaf list, ascending. `settledIndex` is the indexer's
 * frontier; null means it could not tell us, so nothing is written.
 *
 * Only whole chunks below the frontier are stored, which makes every record write-once: a
 * chunk is never revisited to be completed later, so there is no window where a half-written
 * chunk looks whole. Chunks holding no leaves are skipped rather than written empty — the
 * stride between two epochs spans ~131k of them.
 */
export async function saveLeaves(
  assetId: string,
  leaves: CommitmentEvent[],
  settledIndex: number | null,
  cachedUpTo: number,
): Promise<void> {
  if (settledIndex === null) return
  // Round DOWN to a chunk boundary: a partial trailing chunk is exactly what we refuse to
  // store, because the next scan would have to rewrite it.
  const newUpTo = Math.floor(settledIndex / CHUNK) * CHUNK
  if (newUpTo <= cachedUpTo) return

  try {
    const db = await openDb()
    if (!db) return

    const byChunk = new Map<number, CommitmentEvent[]>()
    let count = 0
    for (const leaf of leaves) {
      if (leaf.index >= newUpTo) break // ascending, so nothing further qualifies
      count++
      if (leaf.index < cachedUpTo) continue // already on disk in an earlier chunk
      const chunk = Math.floor(leaf.index / CHUNK)
      const bucket = byChunk.get(chunk)
      if (bucket) bucket.push(leaf)
      else byChunk.set(chunk, [leaf])
    }

    const tx = db.transaction([CHUNK_STORE, META_STORE], 'readwrite')
    const chunkStore = tx.objectStore(CHUNK_STORE)
    for (const [chunk, bucket] of byChunk) {
      chunkStore.put({ key: chunkKey(assetId, chunk), leaves: bucket } satisfies ChunkRecord)
    }
    // The watermark lands in the SAME transaction as the chunks it describes, so a crash can
    // never leave a watermark claiming leaves that were not written.
    tx.objectStore(META_STORE).put({ key: metaKey(assetId), cachedUpTo: newUpTo, count } satisfies MetaRecord)
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } catch {
    // Quota, eviction, a closed connection — the scan already has its data in memory.
  }
}

/** Drop one asset's cache. */
export async function clearAsset(assetId: string): Promise<void> {
  try {
    const db = await openDb()
    if (!db) return
    const chunks = await readChunks(db, assetId)
    const tx = db.transaction([CHUNK_STORE, META_STORE], 'readwrite')
    const store = tx.objectStore(CHUNK_STORE)
    for (const c of chunks) store.delete(c.key)
    tx.objectStore(META_STORE).delete(metaKey(assetId))
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    })
  } catch {
    /* nothing to do — the cache is optional */
  }
}

/** Drop everything. Exposed for a "reset local data" affordance and used by tests. */
export async function clearLeafCache(): Promise<void> {
  try {
    const db = await openDb()
    if (!db) return
    const tx = db.transaction([CHUNK_STORE, META_STORE], 'readwrite')
    tx.objectStore(CHUNK_STORE).clear()
    tx.objectStore(META_STORE).clear()
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    })
  } catch {
    /* ignore */
  }
}

/** Test seam: forget the memoised connection so a fresh fake IndexedDB is picked up. */
export function __resetLeafCacheForTests(): void {
  dbPromise = null
}
