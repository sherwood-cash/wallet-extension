// Client for /stealth/* on the backend.
//
// Base URL resolved the same way the extension's relayer client resolves it:
// VITE_RELAYER_URL, then VITE_INDEXER_URL, then the deployment's relayerUrl / indexerUrl.
// (The web app also routes through a same-origin /api on the onion; the extension has no
// onion build, so the resolved URL is used directly.)
//
// WHAT IS AND IS NOT SENT. Announcements are fetched as an ordered firehose from a block
// cursor, never as "which of these are mine?". The server cannot answer that question and
// must not be given the chance to: ownership is decided locally by a viewing key that never
// leaves this device. The one thing sent about the user is the meta-address they publish on
// purpose.
import { DEPLOYMENT } from '../../config'

export interface StealthStatus {
  enabled: boolean
  schemeId?: number
  announcer?: string
  registry?: string | null
  /** null when gas-less deposits are not configured — the UI hides that button rather than
   *  offering one that will 503. */
  forwarder?: string | null
  deployBlock?: number
  indexedTo?: number | null
  announcements?: number
  registrations?: { keys: number; usernames: number }
  pending?: { open: number; announced: number }
  /** How long a handed-out address stays watched. Displayed rather than hardcoded, so
   *  the screen cannot promise a window the watcher does not keep. */
  pendingWindowHours?: number
  /** Whether this server can announce, and so whether the public /@name page can hand out
   *  addresses at all. False means a payment made there might never be found. */
  canAnnounce?: boolean
}

export interface RawAnnouncement {
  blockNumber: number
  logIndex: number
  txHash: string
  stealthAddress: string
  caller: string
  ephemeralPubKey: string
  metadata: string
  viewTag: number | null
}

export interface AnnouncementPage {
  announcements: RawAnnouncement[]
  next: { fromBlock: number; fromLogIndex: number } | null
  indexedTo: number | null
  done: boolean
}

export interface StealthProfile {
  username: string | null
  registrant: string
  stealthMetaAddress: string
  spendingPubKey: string | null
  viewingPubKey: string | null
  source?: 'index' | 'chain'
}

function base(): string | null {
  const env = (import.meta as any).env as Record<string, string | undefined>
  const url = (
    env?.VITE_RELAYER_URL ||
    env?.VITE_INDEXER_URL ||
    DEPLOYMENT.relayerUrl ||
    DEPLOYMENT.indexerUrl ||
    ''
  ).trim()
  return url ? url.replace(/\/+$/, '') : null
}

class StealthApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'StealthApiError'
  }
}

async function get<T>(path: string): Promise<T> {
  const root = base()
  if (!root) throw new StealthApiError('No indexer configured', 0)
  const res = await fetch(`${root}${path}`)
  if (!res.ok) {
    let code: string | undefined
    let reason = `HTTP ${res.status}`
    try {
      const body = await res.json()
      code = body?.error
      reason = body?.reason || body?.error || reason
    } catch {
      // A non-JSON error body is still an error; the status carries the meaning.
    }
    throw new StealthApiError(reason, res.status, code)
  }
  return res.json() as Promise<T>
}

export const isNotFound = (e: unknown): boolean => e instanceof StealthApiError && e.status === 404

export function fetchStealthStatus(): Promise<StealthStatus> {
  return get<StealthStatus>('/stealth/status')
}

/**
 * One page of announcements from a cursor.
 *
 * The cursor is (block, logIndex) rather than a page number, so a block holding more
 * announcements than fit in one page cannot be half-skipped when new ones land mid-scan.
 * A skipped announcement is a payment its owner never learns about.
 */
export function fetchAnnouncements(cursor: {
  fromBlock: number
  fromLogIndex?: number
  limit?: number
}): Promise<AnnouncementPage> {
  const q = new URLSearchParams({
    fromBlock: String(cursor.fromBlock),
    fromLogIndex: String(cursor.fromLogIndex ?? 0),
    limit: String(cursor.limit ?? 500),
  })
  return get<AnnouncementPage>(`/stealth/announcements?${q}`)
}

/** Resolve `@name` to its keys. Null when nobody holds it. */
export async function fetchProfileByUsername(username: string): Promise<StealthProfile | null> {
  try {
    return await get<StealthProfile>(`/stealth/name/${encodeURIComponent(username.replace(/^@/, ''))}`)
  } catch (e) {
    if (isNotFound(e)) return null
    throw e
  }
}

/** The plain ERC-6538 lookup: keys by registrant address. */
export async function fetchProfileByAddress(address: string): Promise<StealthProfile | null> {
  try {
    return await get<StealthProfile>(`/stealth/keys/${address}`)
  } catch (e) {
    if (isNotFound(e)) return null
    throw e
  }
}

export async function checkUsernameAvailable(username: string): Promise<boolean> {
  try {
    const r = await get<{ available: boolean }>(`/stealth/available/${encodeURIComponent(username)}`)
    return Boolean(r.available)
  } catch {
    return false
  }
}

export interface RelayInfo {
  enabled: boolean
  relayer: string
  forwarder: string
  gasCap: number
  /** assetId -> minimum ExtData.fee, in that token's base units. */
  minFee: Record<string, string>
}

export async function fetchRelayInfo(): Promise<RelayInfo | null> {
  try {
    return await get<RelayInfo>('/stealth/relay-info')
  } catch {
    return null
  }
}

/** Submit a sponsored deposit for a stealth address that holds no gas. */
export async function relayStealthDeposit(payload: unknown): Promise<{ txHash: string }> {
  const root = base()
  if (!root) throw new StealthApiError('No relayer configured', 0)
  const res = await fetch(`${root}/stealth/relay-deposit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await res.json().catch(() => ({}) as any)
  if (!res.ok) throw new StealthApiError(body?.reason || body?.error || `HTTP ${res.status}`, res.status, body?.error)
  return body as { txHash: string }
}

/**
 * Park an address so the backend announces it when money lands.
 *
 * The step that makes a no-wallet payment findable. The payer cannot publish the ERC-5564
 * announcement themselves — they have no wallet connected, which is the whole point of the
 * public page — so the relayer does it once funds arrive.
 *
 * Throws on failure, and callers are expected to SURFACE that rather than swallow it: the
 * address still works, but its owner may never learn it was paid.
 */
export async function registerPending(payload: {
  stealthAddress: string
  ephemeralPubKey: string
  viewTag: number
  username: string | null
}): Promise<void> {
  const root = base()
  if (!root) throw new StealthApiError('No indexer configured', 0)
  const res = await fetch(`${root}/stealth/pending`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as any)
    throw new StealthApiError(body?.reason || body?.error || `HTTP ${res.status}`, res.status, body?.error)
  }
}
