// Local, per-account scan hints. Purely an optimisation: discarding them costs only a
// longer re-scan, never correctness.
//
// Two hints are kept:
//   1. Which assets the account has traded, so the scan skips trees it never touched.
//   2. Where to start, since a user's notes cannot predate their first deposit.
//
// Both are re-derivable from public chain data, which is what makes this a cache rather
// than state — a new device recovers without any of it. Nothing secret is stored: no
// keys, no note contents, no commitment-to-address links.
import { DEPLOYMENT } from '../../config'

const VERSION = 'v1'

// `account` is an opaque per-account tag, NOT an address. Callers pass the UTXO pubkey so
// nothing links this cache to an on-chain identity. The wallet address is needed once, to
// find this wallet in the first-deposit table — and that lookup happens locally, on a table
// downloaded whole, so the address never leaves the browser.
function key(account: string, suffix: string): string {
  // Scoped by vault too, so a redeploy never resurrects stale hints.
  return `sherwood:${VERSION}:${DEPLOYMENT.vault?.toLowerCase() ?? 'novault'}:${account.toLowerCase()}:${suffix}`
}

function read<T>(k: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(k)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

function write(k: string, value: unknown): void {
  try {
    localStorage.setItem(k, JSON.stringify(value))
  } catch {
    // private mode / quota — hints are optional, never fail the caller
  }
}

// ---- traded assets ---------------------------------------------------------

/** assetIds (decimal strings) this account has deposited into, withdrawn or swapped. */
export function getTradedAssets(account: string): string[] {
  return read<string[]>(key(account, 'assets'), [])
}

/** Record an asset as touched. Idempotent. */
export function rememberTradedAsset(account: string, assetId: string): void {
  const current = getTradedAssets(account)
  if (current.includes(assetId)) return
  write(key(account, 'assets'), [...current, assetId])
}

export function rememberTradedAssets(account: string, assetIds: string[]): void {
  const current = new Set(getTradedAssets(account))
  const before = current.size
  for (const id of assetIds) current.add(id)
  if (current.size !== before) write(key(account, 'assets'), [...current])
}

/**
 * The assets worth scanning for `account`: the ones it has traded, plus `always` (the
 * base assets, which the UI shows a balance for regardless). Returns `always` on a fresh
 * device — the cache is a filter, never a source of truth about what the user owns.
 */
export function assetsToScan(account: string, always: string[]): string[] {
  return [...new Set([...always, ...getTradedAssets(account)])]
}

// ---- first-deposit anchor --------------------------------------------------

/** Cached scan anchor for this account: assetId -> first leaf index worth decrypting. */
export function getScanAnchor(account: string): Record<string, number> | null {
  return read<Record<string, number> | null>(key(account, 'anchor'), null)
}

export function setScanAnchor(account: string, anchor: Record<string, number>): void {
  write(key(account, 'anchor'), anchor)
}

/**
 * Resolve this wallet's scan anchor: per asset, the first leaf index worth trial-decrypting,
 * because a wallet cannot own a note minted before its own first deposit. Deposits are
 * always self-sent (only spends are relayed), so the indexer reads the depositor off the
 * chain and a new device recovers the anchor with one call.
 *
 * It is an anchor for DECRYPTION only. Every leaf is still fetched: the Merkle tree is
 * rebuilt from all of them and skipping any would give a wrong root and unprovable notes.
 *
 * Correctness note: this holds only while every output note is minted to its own prover's
 * pubkey, which is the case today. If shielded transfers to a third party are ever added, a
 * wallet could own a note older than its first deposit and this anchor would silently hide
 * it — drop the anchor then, do not patch around it.
 *
 * @param account opaque per-account tag (the UTXO pubkey) — used as the cache key
 * @param address the wallet address, sent to the indexer to look the anchor up
 */
export async function fetchScanAnchor(
  indexerBase: string,
  account: string,
  address: string,
): Promise<Record<string, number>> {
  const cached = getScanAnchor(account)
  if (cached !== null) return cached

  try {
    const res = await fetch(`${indexerBase}/first-deposit/${address}`, {
      headers: { accept: 'application/json' },
    })
    if (res.ok) {
      const data = (await res.json()) as { scanFromIndex?: Record<string, number> }
      const anchor = data.scanFromIndex ?? {}
      setScanAnchor(account, anchor)
      return anchor
    }
  } catch {
    // indexer unreachable — scan everything, which is correct, only slower
  }
  return {}
}

/** Drop every hint for an account (used by a "rescan from scratch" action). */
export function clearSyncCache(account: string): void {
  try {
    localStorage.removeItem(key(account, 'assets'))
    localStorage.removeItem(key(account, 'anchor'))
  } catch {
    /* nothing to do */
  }
}
