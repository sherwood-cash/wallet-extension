// The two storage areas the stealth screen writes to, adapted to the extension exactly the
// way `src/wallet/vault.ts` adapts its own — with the same dev-only fallbacks so the flow is
// clickable under `vite dev`, where there is no `chrome.storage`.
//
//   session area (chrome.storage.session, memory-only)  the TIMED stealth sign-in signature.
//     Same tier as the wallet's own decrypted key: it derives the spending key and must die
//     with the browser process, never reaching disk.
//   local area (chrome.storage.local, on disk)          the PINNED signature behind a
//     published identity, and the one-time receive address currently on offer. These are
//     meant to survive a restart (the pin, because losing it silently loses funds; the held
//     address, because re-minting it on every open wastes a backend row and misleads a payer).
//
// All keys are namespaced by chainId+vault so two accounts / two deployments on one browser
// can never read each other's stealth state.
import { DEPLOYMENT } from '../../config'

const hasChromeStorage = (): boolean =>
  typeof chrome !== 'undefined' && typeof chrome.storage !== 'undefined'

/** Scope every key by chain + owning (vault) address, lower-cased. */
export function scopedKey(prefix: string, owner: string): string {
  return `${prefix}${DEPLOYMENT.chainId}:${owner.toLowerCase()}`
}

// --- disk area (chrome.storage.local, localStorage fallback) ---------------

export async function diskGet(key: string): Promise<string | null> {
  if (hasChromeStorage()) {
    const got = await chrome.storage.local.get(key)
    const value = got[key]
    return typeof value === 'string' ? value : null
  }
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export async function diskSet(key: string, value: string): Promise<void> {
  if (hasChromeStorage()) return chrome.storage.local.set({ [key]: value })
  try {
    localStorage.setItem(key, value)
  } catch {
    /* private mode / quota — the caller finds out on read */
  }
}

export async function diskRemove(key: string): Promise<void> {
  if (hasChromeStorage()) return chrome.storage.local.remove(key)
  try {
    localStorage.removeItem(key)
  } catch {
    /* nothing stored means nothing to remove */
  }
}

// --- memory area (chrome.storage.session, sessionStorage fallback) ---------

export async function sessionGet(key: string): Promise<string | null> {
  if (hasChromeStorage()) {
    const got = await chrome.storage.session.get(key)
    const value = got[key]
    return typeof value === 'string' ? value : null
  }
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

export async function sessionSet(key: string, value: string): Promise<void> {
  if (hasChromeStorage()) return chrome.storage.session.set({ [key]: value })
  try {
    sessionStorage.setItem(key, value)
  } catch {
    /* the signature still works for this page; it just will not survive a reload */
  }
}

export async function sessionRemove(key: string): Promise<void> {
  if (hasChromeStorage()) return chrome.storage.session.remove(key)
  try {
    sessionStorage.removeItem(key)
  } catch {
    /* already gone */
  }
}
