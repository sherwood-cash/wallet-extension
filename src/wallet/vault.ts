/**
 * The key vault: every line that touches the private key, with no React in it.
 *
 * The shape of the thing is deliberately boring, because boring is auditable:
 *
 *   chrome.storage.local    the scrypt-encrypted Web3 Secret Storage keystore, plus
 *                           the address it belongs to and the auto-lock preference.
 *                           This survives a browser restart and IS on disk.
 *   chrome.storage.session   the raw private key of an unlocked wallet, and when it
 *                           was unlocked. MV3 backs this area with memory only — it
 *                           never reaches the profile directory and dies with the
 *                           browser process.
 *
 * The split is the whole security story. Someone who copies a profile directory off a
 * laptop gets the keystore and nothing else, and the keystore costs an scrypt run per
 * password guess (N = 2^15, ~2s on this hardware) to attack. The alternative we
 * rejected was keeping the decrypted key in `local` so the popup never has to ask for
 * a password again: that trades the entire benefit of encrypting it for two seconds a
 * day.
 */
import { ethers } from 'ethers'
import { readProvider } from '@app/lib/rpc'

/** Namespaced so nothing here can collide with the web app's own storage keys. */
const KEYSTORE_KEY = 'sherwood:ext:keystore'
const SESSION_KEY = 'sherwood:ext:session'
const AUTOLOCK_KEY = 'sherwood:ext:autolock-ms'

/**
 * `@app/lib/privacy/encryption` caches the sign-in signature in sessionStorage under
 * this prefix. That signature derives the note-spending keys, so leaving it behind on
 * lock would mean a locked wallet whose shielded notes are still spendable by anything
 * running in the page. Locking clears it and the next unlock re-signs silently.
 */
const SIGN_IN_SIG_PREFIX = 'rhm:siwe-sig:'

/** Short enough to be typed in a popup, long enough that scrypt is the cheap part. */
export const MIN_PASSWORD_LENGTH = 8

/** Thirty minutes matches what people expect from a wallet: long enough to finish a
 *  deposit and a swap, short enough that a walked-away-from laptop closes itself. */
const DEFAULT_AUTOLOCK_MS = 30 * 60_000

/** scrypt work factor. 2^15 is the ethers default for `Wallet.encrypt`; we state it
 *  explicitly so a future ethers change cannot silently weaken existing keystores. */
const SCRYPT_N = 1 << 15

/** 0 → 1. Both scrypt directions report through this so the UI can show a number. */
export type ProgressFn = (fraction: number) => void

export interface StoredAccount {
  address: string
  /** Web3 Secret Storage JSON, exactly as `Wallet.encrypt` produced it. */
  json: string
}

/** What an unlock hands back. The key is passed by value and never held in module
 *  scope: only React state and `chrome.storage.session` keep a copy. */
export interface UnlockedKey {
  address: string
  privateKey: string
}

// ---------------------------------------------------------------------------
// Storage, with a dev-only fallback
// ---------------------------------------------------------------------------
//
// The same bundle is served by `vite dev` in an ordinary tab while a screen is being
// worked on, and there is no `chrome.storage` there. The fallback below mirrors the
// two areas onto localStorage / sessionStorage so the flows are clickable. It is
// strictly a development convenience: web storage IS on disk, so a wallet created in
// the dev tab has none of the guarantees the packed extension gives.

const hasChromeStorage = (): boolean =>
  typeof chrome !== 'undefined' && typeof chrome.storage !== 'undefined'

/** Dev-only mirror of `chrome.storage.session`, so a reload in a dev tab behaves like
 *  a popup re-open rather than a browser restart. */
let devSession: string | null = null

async function diskGet(key: string): Promise<string | null> {
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

async function diskSet(key: string, value: string): Promise<void> {
  if (hasChromeStorage()) return chrome.storage.local.set({ [key]: value })
  try {
    localStorage.setItem(key, value)
  } catch {
    /* private mode / quota — nothing to do but let the caller find out on read */
  }
}

async function diskRemove(key: string): Promise<void> {
  if (hasChromeStorage()) return chrome.storage.local.remove(key)
  try {
    localStorage.removeItem(key)
  } catch {
    /* nothing stored means nothing to remove */
  }
}

async function memoryGet(): Promise<string | null> {
  if (hasChromeStorage()) {
    const got = await chrome.storage.session.get(SESSION_KEY)
    const value = got[SESSION_KEY]
    return typeof value === 'string' ? value : null
  }
  if (devSession !== null) return devSession
  try {
    return sessionStorage.getItem(SESSION_KEY)
  } catch {
    return null
  }
}

async function memorySet(value: string): Promise<void> {
  if (hasChromeStorage()) return chrome.storage.session.set({ [SESSION_KEY]: value })
  devSession = value
  try {
    sessionStorage.setItem(SESSION_KEY, value)
  } catch {
    /* the in-module copy still carries this page's session */
  }
}

async function memoryClear(): Promise<void> {
  if (hasChromeStorage()) return chrome.storage.session.remove(SESSION_KEY)
  devSession = null
  try {
    sessionStorage.removeItem(SESSION_KEY)
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
// The keystore
// ---------------------------------------------------------------------------

/** The stored account, or null when this browser has never held a wallet. */
export async function loadAccount(): Promise<StoredAccount | null> {
  const raw = await diskGet(KEYSTORE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<StoredAccount>
    if (typeof parsed.address !== 'string' || typeof parsed.json !== 'string') return null
    return { address: parsed.address, json: parsed.json }
  } catch {
    // A keystore we cannot parse is indistinguishable from no keystore for the UI,
    // and pretending it exists would strand the user on a screen with no way out.
    return null
  }
}

/** The address is stored beside the ciphertext so the locked screen can name the
 *  account it is asking a password for, without decrypting anything first. */
async function saveAccount(account: StoredAccount): Promise<void> {
  await diskSet(KEYSTORE_KEY, JSON.stringify(account))
}

async function encryptWallet(
  wallet: ethers.Wallet,
  password: string,
  onProgress?: ProgressFn,
): Promise<StoredAccount> {
  const json = await wallet.encrypt(password, { scrypt: { N: SCRYPT_N } }, onProgress)
  return { address: wallet.address, json }
}

/**
 * Mint a brand-new wallet and persist its keystore. Returns the mnemonic so the caller
 * can show it once — it is never written anywhere in the clear, and the only other way
 * back to it is `revealSecret`, which costs the password again.
 *
 * This deliberately does NOT start a session. The caller has a confirmation step to run
 * first, and a wallet that unlocked itself the moment it was generated would let a
 * closed popup strand a user with funds and an unread recovery phrase.
 */
export async function createWallet(
  password: string,
  onProgress?: ProgressFn,
): Promise<UnlockedKey & { mnemonic: string }> {
  const wallet = ethers.Wallet.createRandom()
  await saveAccount(await encryptWallet(wallet, password, onProgress))
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
    mnemonic: wallet.mnemonic.phrase,
  }
}

/** Import a BIP-39 phrase or a raw private key. Unlike `createWallet` there is nothing
 *  for the user to write down, so this one does open a session. */
export async function importWallet(
  secret: string,
  password: string,
  onProgress?: ProgressFn,
): Promise<UnlockedKey> {
  const wallet = walletFromSecret(secret)
  await saveAccount(await encryptWallet(wallet, password, onProgress))
  const key = { address: wallet.address, privateKey: wallet.privateKey }
  await startSession(key)
  return key
}

/**
 * Decrypt the keystore and open a session. Slow on purpose: scrypt at N = 2^15 takes
 * a couple of seconds, which is the entire defence against someone brute-forcing a
 * stolen keystore. `fromEncryptedJson` reports progress, so the button counts up
 * instead of the popup appearing to hang.
 */
export async function unlockWallet(password: string, onProgress?: ProgressFn): Promise<UnlockedKey> {
  const account = await loadAccount()
  if (!account) throw new Error('There is no wallet on this device yet.')
  const wallet = await ethers.Wallet.fromEncryptedJson(account.json, password, onProgress)
  const key = { address: wallet.address, privateKey: wallet.privateKey }
  await startSession(key)
  return key
}

/**
 * Re-derive the secrets for display. Takes the password again rather than reading the
 * session key: showing a recovery phrase is the one action where "you were already
 * unlocked" is not enough — the popup may have been left open on someone's desk.
 *
 * `mnemonic` is null for a wallet imported from a raw private key, which has no phrase
 * to recover from.
 */
export async function revealSecret(
  password: string,
  onProgress?: ProgressFn,
): Promise<{ mnemonic: string | null; privateKey: string }> {
  const account = await loadAccount()
  if (!account) throw new Error('There is no wallet on this device yet.')
  const wallet = await ethers.Wallet.fromEncryptedJson(account.json, password, onProgress)
  return { mnemonic: wallet.mnemonic?.phrase ?? null, privateKey: wallet.privateKey }
}

/** Remove the wallet from this device entirely. Nothing here is recoverable
 *  afterwards; only the recovery phrase can bring the account back. */
export async function wipeVault(): Promise<void> {
  await endSession()
  await diskRemove(KEYSTORE_KEY)
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

interface SessionEntry {
  privateKey: string
  /** When the password was last accepted. Drives the auto-lock deadline. */
  unlockedAt: number
}

/** Open a session for an already-decrypted key. Exported because a freshly created
 *  wallet is confirmed by its owner after `createWallet` has returned. */
export async function startSession(key: UnlockedKey): Promise<void> {
  const entry: SessionEntry = { privateKey: key.privateKey, unlockedAt: Date.now() }
  await memorySet(JSON.stringify(entry))
}

/**
 * The unlocked key from this browser session, or null if there is none or it has aged
 * out. Chrome tears the popup down on every blur, so this is what stops a wallet from
 * asking for its password each time the toolbar icon is clicked.
 *
 * The deadline is measured from the last time the popup picked the session up, not
 * from the original unlock: a wallet someone is actively using should not lock in the
 * middle of a swap, and a wallet nobody has opened for half an hour should.
 */
export async function resumeSession(): Promise<UnlockedKey | null> {
  const raw = await memoryGet()
  if (!raw) return null

  let entry: SessionEntry
  try {
    entry = JSON.parse(raw) as SessionEntry
  } catch {
    await memoryClear()
    return null
  }
  if (typeof entry.privateKey !== 'string' || typeof entry.unlockedAt !== 'number') {
    await memoryClear()
    return null
  }

  if (Date.now() - entry.unlockedAt > (await getAutoLockMs())) {
    await endSession()
    return null
  }

  const account = await loadAccount()
  // A session without a keystore is a wipe that raced a popup open; the keystore is
  // the source of truth, so the orphaned key goes.
  if (!account) {
    await endSession()
    return null
  }

  await memorySet(JSON.stringify({ ...entry, unlockedAt: Date.now() }))
  return { address: account.address, privateKey: entry.privateKey }
}

/** True once the current session has aged past the auto-lock deadline. Cheap enough
 *  to poll from a timer while the popup is open. */
export async function sessionExpired(): Promise<boolean> {
  const raw = await memoryGet()
  if (!raw) return true
  try {
    const entry = JSON.parse(raw) as SessionEntry
    return Date.now() - entry.unlockedAt > (await getAutoLockMs())
  } catch {
    return true
  }
}

/** Drop the unlocked key and everything derived from it. */
export async function endSession(): Promise<void> {
  clearSignInCache()
  await memoryClear()
}

/** Wipe the cached sign-in signature so locking also revokes the note-spending keys.
 *  Without this the wallet locks while the page can still derive keys that spend
 *  shielded notes, which is the opposite of what the lock button promises. */
function clearSignInCache(): void {
  try {
    const doomed: string[] = []
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)
      if (key?.startsWith(SIGN_IN_SIG_PREFIX)) doomed.push(key)
    }
    for (const key of doomed) sessionStorage.removeItem(key)
  } catch {
    /* no sessionStorage means nothing was ever cached in it */
  }
}

/** Auto-lock delay in ms. Stored on disk rather than in the session so the preference
 *  outlives a browser restart; Settings owns the UI for changing it. */
export async function getAutoLockMs(): Promise<number> {
  const raw = await diskGet(AUTOLOCK_KEY)
  const parsed = raw === null ? NaN : Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AUTOLOCK_MS
}

export async function setAutoLockMs(ms: number): Promise<void> {
  await diskSet(AUTOLOCK_KEY, String(Math.max(60_000, Math.round(ms))))
}

// ---------------------------------------------------------------------------
// Signers, validation, error copy
// ---------------------------------------------------------------------------

/** Every signer the popup hands out rides the shared read provider, so balance reads
 *  and log scans go through the one connection the rest of the app already uses. */
export function connectSigner(privateKey: string): ethers.Wallet {
  return new ethers.Wallet(privateKey, readProvider)
}

/** Null when the password is acceptable, otherwise the sentence to show under it. */
export function validatePassword(password: string, confirm?: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH)
    return `Use at least ${MIN_PASSWORD_LENGTH} characters. This password is the only thing protecting the key on this device.`
  if (confirm !== undefined && password !== confirm) return 'The two passwords do not match.'
  return null
}

/** Phrases arrive from clipboards with newlines, double spaces and stray capitals in
 *  them; BIP-39 wants single-spaced lower case. */
const normalizeMnemonic = (secret: string): string =>
  secret.trim().toLowerCase().split(/\s+/).join(' ')

/**
 * Turn a pasted secret into a wallet. A private key is validated by construction
 * rather than by regex — ethers checks the length and the curve, and its own error is
 * the definition of "valid" everywhere else in this codebase.
 */
export function walletFromSecret(secret: string): ethers.Wallet {
  const trimmed = secret.trim()
  if (!trimmed) throw new Error('Paste a recovery phrase or a private key.')

  // Anything with a gap in it is a phrase — clipboards hand these over with newlines
  // and double spaces as often as with single ones.
  if (trimmed.split(/\s+/).length > 1) {
    const phrase = normalizeMnemonic(trimmed)
    if (!ethers.utils.isValidMnemonic(phrase))
      throw new Error('That is not a valid recovery phrase. Check the spelling and the word order.')
    return ethers.Wallet.fromMnemonic(phrase)
  }

  try {
    return new ethers.Wallet(trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`)
  } catch {
    throw new Error('That is not a valid private key. It should be 64 hex characters, usually with a 0x in front.')
  }
}

/**
 * Turn a thrown value into a sentence. ethers reports a bad password as a generic
 * "invalid password" from deep inside the keystore code; users read that as the app
 * being broken, so it gets rewritten here where the context is known.
 */
export function describeError(err: unknown, fallback: string): string {
  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : String(err ?? '')
  if (/invalid password/i.test(message)) return 'That password does not unlock this wallet.'
  return message.trim() || fallback
}
