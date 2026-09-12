// Session cache of the LAST computed shielded balances, so reopening the popup shows
// numbers instantly instead of a spinner while the note scan re-runs from scratch.
//
// Why this exists at all is an extension-only problem. Chrome tears the popup down on
// every blur, which discards all in-memory React state AND every module-global cache the
// scan builds up (the nullifier TTL, the page batches). So each reopen used to re-run the
// FULL scan — refetch /nullifiers and /assets/status, trial-decrypt every cached leaf —
// to arrive at numbers it had computed seconds earlier. The leafCache already makes the
// LEAF fetch a tail-only diff; this makes the DISPLAY instant on top of it.
//
// What is stored is a display optimisation and nothing more: a rolled-up balance/count/
// spendable per asset. It is NOT the source of truth — every real spend still rebuilds the
// tree and re-verifies against fresh /nullifiers in actions.ts. A wrong or stale value
// here costs one flash of a number until the scan lands, never a bad transaction.
//
// It lives in chrome.storage.session (MV3-backed by memory, cleared when the browser
// process dies) rather than on disk, to match the note-key lifetime exactly: the keys that
// derive these balances live in the memory-only session too (see vault.ts), so a browser
// restart drops both together and there is never a cached balance for keys that are gone.
//
// Keyed by the opaque per-account UTXO pubkey tag — never the on-chain address, so nothing
// links a stored balance to an identity — and scoped by chainId + vault like leafCache, so
// a redeploy or a chain switch can never resurrect a balance from a different vault.
import { DEPLOYMENT } from '../../config'

const VERSION = 'v1'
const PREFIX = 'sherwood:ext:shielded'

/** Scope every key to the deployment so a redeploy / chain switch never resurrects a
 *  balance from a different vault. Mirrors leafCache's scope(). */
function scope(): string {
  return `${DEPLOYMENT.chainId}:${(DEPLOYMENT.vault ?? 'novault').toLowerCase()}`
}

/** `account` is the opaque UTXO pubkey tag, NOT an address — so nothing here links a
 *  balance to an on-chain identity. */
function storageKey(account: string): string {
  return `${PREFIX}:${VERSION}:${scope()}:${account.toLowerCase()}`
}

/** One asset's rolled-up shielded balance. BigNumbers are stored as decimal strings
 *  because a BigNumber does not survive JSON — it is re-hydrated by the caller. */
export interface CachedNoteSummary {
  /** total of every unspent note — decimal base-unit string */
  balance: string
  /** how many unspent notes back that balance */
  count: number
  /** single-transaction ceiling (the 2 largest notes of one tree) — decimal string */
  spendable: string
}

/** The cache payload: per-asset summaries keyed by asset key. */
type CachePayload = Record<string, CachedNoteSummary>

// ---------------------------------------------------------------------------
// Storage, with a dev-only fallback (mirrors vault.ts)
// ---------------------------------------------------------------------------
//
// `vite dev` serves the same bundle in an ordinary tab where there is no chrome.storage;
// there the payload rides an in-module map + sessionStorage so a reload behaves like a
// popup re-open. Strictly a development convenience — this is only ever a display cache.

const hasChromeStorage = (): boolean =>
  typeof chrome !== 'undefined' && typeof chrome.storage !== 'undefined' && typeof chrome.storage.session !== 'undefined'

/** Dev mirror of chrome.storage.session, so a reload in a dev tab keeps the last balances. */
const devSession = new Map<string, string>()

async function sessionGet(key: string): Promise<string | null> {
  if (hasChromeStorage()) {
    try {
      const got = await chrome.storage.session.get(key)
      const value = got[key]
      return typeof value === 'string' ? value : null
    } catch {
      return null
    }
  }
  if (devSession.has(key)) return devSession.get(key) ?? null
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

async function sessionSet(key: string, value: string): Promise<void> {
  if (hasChromeStorage()) {
    try {
      await chrome.storage.session.set({ [key]: value })
    } catch {
      /* quota / area unavailable — the cache is optional, never fail the caller */
    }
    return
  }
  devSession.set(key, value)
  try {
    sessionStorage.setItem(key, value)
  } catch {
    /* the in-module copy still carries this page's session */
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The last computed shielded balances for `account`, or null when nothing is cached.
 *
 * The popup hydrates from this the moment keys are ready, so cached balances show without a
 * spinner while the scan runs a tail-only refresh underneath. The map is keyed by asset key
 * (the same key the shielded Map in state.tsx uses).
 */
export async function loadShieldedBalances(account: string): Promise<Map<string, CachedNoteSummary> | null> {
  const raw = await sessionGet(storageKey(account))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as CachePayload
    if (!parsed || typeof parsed !== 'object') return null
    const out = new Map<string, CachedNoteSummary>()
    for (const [key, s] of Object.entries(parsed)) {
      if (s && typeof s.balance === 'string' && typeof s.count === 'number' && typeof s.spendable === 'string') {
        out.set(key, s)
      }
    }
    return out.size ? out : null
  } catch {
    return null
  }
}

/**
 * Persist the full per-asset shielded summary map for `account`.
 *
 * Best-effort by construction: the scan already has its answer in memory, so a write that
 * fails only costs the next reopen a spinner. Merges over whatever is stored so an
 * asset that was not part of this scan keeps its previously cached value.
 */
export async function saveShieldedBalances(
  account: string,
  balances: Map<string, CachedNoteSummary>,
): Promise<void> {
  if (!balances.size) return
  const key = storageKey(account)
  const existing = (await loadShieldedBalances(account)) ?? new Map<string, CachedNoteSummary>()
  for (const [k, v] of balances) existing.set(k, v)
  const payload: CachePayload = {}
  for (const [k, v] of existing) payload[k] = v
  await sessionSet(key, JSON.stringify(payload))
}
