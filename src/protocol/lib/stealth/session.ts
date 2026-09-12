// Remembering a stealth sign-in, so a reopen does not cost a wallet prompt.
//
// The message is fixed, so signMessage is deterministic per wallet: the same address always
// produces the same signature and therefore the same stealth identity. Caching the signature
// means a reopen re-derives the keys WITHOUT re-signing.
//
// Adapted to the extension's storage the same way the vault is (see storage.ts):
//   - the TIMED session signature lives in chrome.storage.session (memory-only) — the same
//     tier as the wallet's decrypted key. It EXPIRES 30 minutes after its LAST USE (an idle
//     timeout, matching the vault's auto-lock), so an active user is never asked twice while
//     a walked-away machine forgets quickly.
//   - the PINNED signature lives in chrome.storage.local (on disk) with NO expiry — see below.
//
// WHAT IT COSTS: while an entry is live, the SPENDING key is re-derivable without a prompt.
// That is the same exposure the vault already accepts for note keys, bounded the same ways.
import { diskGet, diskRemove, diskSet, scopedKey, sessionGet, sessionRemove, sessionSet } from './storage'

const PREFIX = 'sherwood:ext:stealth-sig:'

/** How long a sign-in survives AFTER ITS LAST USE. Matches the wallet's auto-lock window. */
const SESSION_TTL_MS = 30 * 60 * 1000

interface Entry {
  sig: string
  exp: number
}

const sigKey = (address: string) => scopedKey(PREFIX, address)

/**
 * Read a live signature, or null.
 *
 * Every failure path returns null rather than throwing: storage can be unavailable and a
 * malformed entry has no bound — both must cost one signature, not a broken screen.
 */
export async function readStealthSignature(address: string): Promise<string | null> {
  try {
    const raw = await sessionGet(sigKey(address))
    if (!raw) return null
    const entry = JSON.parse(raw) as Entry
    if (typeof entry?.sig !== 'string' || typeof entry?.exp !== 'number') return null
    if (Date.now() >= entry.exp) {
      await clearStealthSignature(address)
      return null
    }
    return entry.sig
  } catch {
    return null
  }
}

/** Store a signature, or slide an existing one forward. Both are the same write. */
export async function writeStealthSignature(address: string, sig: string): Promise<void> {
  const entry: Entry = { sig, exp: Date.now() + SESSION_TTL_MS }
  await sessionSet(sigKey(address), JSON.stringify(entry))
}

export async function clearStealthSignature(address: string): Promise<void> {
  await sessionRemove(sigKey(address))
}

/**
 * Slide the window forward without reading the signature into the caller.
 *
 * Using the session is what keeps it alive. Deliberately a no-op when there is nothing live:
 * once the window closes, only a fresh signature reopens it.
 */
export async function touchStealthSession(address: string): Promise<void> {
  const sig = await readStealthSignature(address)
  if (sig) await writeStealthSignature(address, sig)
}

// ---------------------------------------------------------------- the pinned identity

/**
 * The signature that produced the keys this wallet has PUBLISHED on chain.
 *
 * `personal_sign` is only deterministic if the signer chooses its ECDSA nonce deterministically
 * (RFC 6979). A signer that rolls a random nonce returns a different signature every time for
 * the identical message, and the derivation then yields a different meta-address on every
 * unlock — which silently loses any payment made to the previously-published address.
 *
 * So once an identity is PUBLISHED it stops being re-derived. The signature behind it is
 * pinned on disk with no expiry, because the identity it produces is now a commitment on
 * chain: a wallet that re-signs and gets something else has not changed its mind, it has lost
 * its money.
 */
const PIN_PREFIX = 'sherwood:ext:stealth-pin:'

const pinKey = (address: string) => scopedKey(PIN_PREFIX, address)

export async function pinnedSignature(address: string): Promise<string | null> {
  const raw = await diskGet(pinKey(address))
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

/** Pin the signature behind a published identity. Never overwrites an existing pin: the
 *  first one is the one the on-chain registration was made with. */
export async function pinSignature(address: string, sig: string): Promise<void> {
  if (await diskGet(pinKey(address))) return
  await diskSet(pinKey(address), sig)
}

export async function clearPinnedSignature(address: string): Promise<void> {
  await diskRemove(pinKey(address))
}
