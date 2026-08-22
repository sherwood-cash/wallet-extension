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
/** The HD account registry: which derived accounts exist and which one is active. Just
 *  indexes, labels and addresses — nothing secret — so it lives on disk beside the
 *  keystore and survives a restart. The private keys are re-derived from the mnemonic on
 *  unlock and never written here. */
const ACCOUNTS_KEY = 'sherwood:ext:accounts'

/** Standard Ethereum HD path. `ethers.Wallet.fromMnemonic(phrase)` derives account 0 at
 *  exactly this prefix + "/0", so account i is the same prefix + "/i" — this is the path
 *  MetaMask and every other wallet walk when they "add account". */
const HD_PATH_PREFIX = "m/44'/60'/0'/0"

const hdPath = (index: number): string => `${HD_PATH_PREFIX}/${index}`

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

/** scrypt work factor for NEW keystores. Lowered from 2^15 to 2^14 to roughly halve the
 *  unlock/encrypt wait (the dominant cost) while still forcing an scrypt run per password
 *  guess against a stolen keystore. Existing keystores keep whatever N they were written
 *  with — the parameters live in the keystore JSON, so this only speeds up wallets created
 *  or imported from here on. */
const SCRYPT_N = 1 << 14

/** 0 → 1. Both scrypt directions report through this so the UI can show a number. */
export type ProgressFn = (fraction: number) => void

export interface StoredAccount {
  address: string
  /** Web3 Secret Storage JSON, exactly as `Wallet.encrypt` produced it. */
  json: string
}

/** One account in the registry.
 *
 *  An HD account (the default) is purely descriptive — its key is re-derived from the
 *  mnemonic at `index`, so nothing secret is stored. An IMPORTED account is a private key
 *  the wallet did not derive, so it cannot be reproduced from the phrase: it carries its
 *  own scrypt-encrypted keystore (`json`, same password as the root), which is decrypted
 *  into the memory-only session at unlock. The ciphertext on disk is as safe as the root
 *  keystore beside it. */
export interface HdAccount {
  index: number
  address: string
  label?: string
  kind?: 'hd' | 'imported'
  /** Web3 Secret Storage JSON — present only for an imported account. */
  json?: string
}

/** The persisted account registry. `activeIndex` is the derivation index (not a list
 *  position) of the account the wallet is currently acting as. */
export interface AccountList {
  accounts: HdAccount[]
  activeIndex: number
}

/** What an unlock hands back. The key is passed by value and never held in module
 *  scope: only React state and `chrome.storage.session` keep a copy.
 *
 *  `index` is which HD account this key belongs to. `mnemonic` is the BIP-39 phrase the
 *  keystore was built from, present only for HD wallets (a raw-private-key import has
 *  none) — it rides the session so accounts can be switched without the password, and it
 *  never touches `chrome.storage.local`. */
export interface UnlockedKey {
  address: string
  privateKey: string
  index: number
  mnemonic: string | null
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

// ---------------------------------------------------------------------------
// The HD account registry
// ---------------------------------------------------------------------------
//
// The keystore encrypts one wallet — the mnemonic root, which is account 0. Every other
// account is derived from that same mnemonic at a different path index, so nothing extra
// has to be encrypted: the registry below only remembers WHICH indexes the user has
// added and which is active. It is rebuilt from the keystore's own address if it is ever
// missing, so an old single-account wallet upgrades itself the first time it is read.

/** Derive the wallet for one HD account from a BIP-39 phrase. */
export function deriveHdWallet(mnemonic: string, index: number): ethers.Wallet {
  return ethers.Wallet.fromMnemonic(mnemonic, hdPath(index))
}

/** The account registry, or a single-account default synthesised from the keystore for a
 *  wallet created before multi-account existed (or one imported from a raw key). */
export async function loadAccounts(): Promise<AccountList | null> {
  const account = await loadAccount()
  if (!account) return null

  const raw = await diskGet(ACCOUNTS_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<AccountList>
      if (Array.isArray(parsed.accounts) && parsed.accounts.length > 0) {
        const accounts = parsed.accounts
          .filter(
            (a): a is HdAccount =>
              !!a && typeof a.index === 'number' && typeof a.address === 'string',
          )
          .map((a) => ({
            index: a.index,
            address: a.address,
            label: a.label,
            kind: a.kind === 'imported' ? ('imported' as const) : ('hd' as const),
            json: a.json,
          }))
        if (accounts.length > 0) {
          const activeIndex =
            typeof parsed.activeIndex === 'number' &&
            accounts.some((a) => a.index === parsed.activeIndex)
              ? parsed.activeIndex
              : accounts[0].index
          return { accounts, activeIndex }
        }
      }
    } catch {
      /* an unreadable registry is treated as absent: the default below is always safe */
    }
  }

  // No registry yet: the keystore's own address is account 0.
  return { accounts: [{ index: 0, address: account.address }], activeIndex: 0 }
}

async function saveAccounts(list: AccountList): Promise<void> {
  await diskSet(ACCOUNTS_KEY, JSON.stringify(list))
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
  const mnemonic = wallet.mnemonic.phrase
  await saveAccount(await encryptWallet(wallet, password, onProgress))
  await saveAccounts({ accounts: [{ index: 0, address: wallet.address }], activeIndex: 0 })
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
    index: 0,
    mnemonic,
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
  // A phrase import derives account 0 at the standard path and can grow more accounts
  // later; a raw-key import has no phrase, so it is a single account for good.
  const mnemonic = wallet.mnemonic?.phrase ?? null
  await saveAccount(await encryptWallet(wallet, password, onProgress))
  await saveAccounts({ accounts: [{ index: 0, address: wallet.address }], activeIndex: 0 })
  const key: UnlockedKey = { address: wallet.address, privateKey: wallet.privateKey, index: 0, mnemonic }
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
  const root = await ethers.Wallet.fromEncryptedJson(account.json, password, onProgress)
  const mnemonic = root.mnemonic?.phrase ?? null

  const list = await loadAccounts()
  // Decrypt any imported accounts up front (same password as the root) so they can be
  // switched to later without re-authenticating, exactly like the mnemonic.
  const imported = await decryptImported(list, password)

  // Re-derive whichever account was active. An imported account uses its decrypted key; an
  // HD account derives from the phrase; index 0 is always the root keystore's own wallet.
  const activeIndex = list?.activeIndex ?? 0
  const key = deriveActiveKey(root, mnemonic, activeIndex, imported)
  await startSession(key, imported)
  return key
}

/** Decrypt every imported account's keystore with the wallet password. An entry that
 *  will not decrypt is skipped rather than failing the whole unlock. */
async function decryptImported(
  list: AccountList | null,
  password: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  if (!list) return out
  for (const a of list.accounts) {
    if (a.kind === 'imported' && a.json) {
      try {
        const w = await ethers.Wallet.fromEncryptedJson(a.json, password)
        out[String(a.index)] = w.privateKey
      } catch {
        /* wrong password for this one, or corrupt — leave it out; HD accounts still work */
      }
    }
  }
  return out
}

/** Build the `UnlockedKey` for a given active index. Shared by unlock and session-resume
 *  so both agree on how an index maps to a key: an imported index uses its decrypted key,
 *  a higher HD index needs the mnemonic, and index 0 is the keystore's own wallet. */
function deriveActiveKey(
  root: ethers.Wallet,
  mnemonic: string | null,
  activeIndex: number,
  imported?: Record<string, string>,
): UnlockedKey {
  const pk = imported?.[String(activeIndex)]
  if (pk) {
    const w = new ethers.Wallet(pk)
    return { address: w.address, privateKey: pk, index: activeIndex, mnemonic }
  }
  if (mnemonic && activeIndex > 0) {
    const derived = deriveHdWallet(mnemonic, activeIndex)
    return { address: derived.address, privateKey: derived.privateKey, index: activeIndex, mnemonic }
  }
  return { address: root.address, privateKey: root.privateKey, index: 0, mnemonic }
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
  await diskRemove(ACCOUNTS_KEY)
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

interface SessionEntry {
  privateKey: string
  /** The active account's address and HD index, so a resumed session comes back as the
   *  same account the popup was closed on rather than always account 0. */
  address: string
  index: number
  /** The BIP-39 phrase, kept in memory-only session storage so accounts can be switched
   *  without re-entering the password. Null for a raw-key import. This is the same
   *  security tier as `privateKey`: it never reaches `chrome.storage.local`. */
  mnemonic: string | null
  /** Decrypted private keys of the IMPORTED accounts, keyed by their registry index. Held
   *  only here (memory-only session) so an imported account can be switched to without the
   *  password, exactly like the mnemonic above. Absent when there are no imported accounts. */
  imported?: Record<string, string>
  /** When the password was last accepted. Drives the auto-lock deadline. */
  unlockedAt: number
}

/** Open a session for an already-decrypted key. Exported because a freshly created
 *  wallet is confirmed by its owner after `createWallet` has returned. `imported` carries
 *  the decrypted imported-account keys forward so switching to them needs no password. */
export async function startSession(
  key: UnlockedKey,
  imported?: Record<string, string>,
): Promise<void> {
  const entry: SessionEntry = {
    privateKey: key.privateKey,
    address: key.address,
    index: key.index,
    mnemonic: key.mnemonic,
    ...(imported && Object.keys(imported).length ? { imported } : {}),
    unlockedAt: Date.now(),
  }
  await memorySet(JSON.stringify(entry))
}

/**
 * Switch the active account without the password. Reads the mnemonic already held in the
 * session, derives the requested index, persists it as active in the registry and rolls
 * the session over to the new key. Throws for a raw-key import (no mnemonic) or a stale
 * session — the caller should be unlocked before calling.
 */
export async function switchActiveAccount(index: number): Promise<UnlockedKey> {
  const raw = await memoryGet()
  if (!raw) throw new Error('The wallet is locked.')
  let entry: SessionEntry
  try {
    entry = JSON.parse(raw) as SessionEntry
  } catch {
    throw new Error('The wallet is locked.')
  }

  const list = await loadAccounts()
  if (!list) throw new Error('There is no wallet on this device yet.')

  const target = list.accounts.find((a) => a.index === index)
  if (!target) throw new Error('That account does not exist.')

  let key: UnlockedKey
  const importedPk = entry.imported?.[String(index)]
  if (importedPk) {
    // An imported account: its key was decrypted at unlock and rides the session.
    key = { address: target.address, privateKey: importedPk, index, mnemonic: entry.mnemonic }
  } else if (index === entry.index) {
    // Already the active account: the session's own key is the answer, no derivation.
    key = { address: entry.address, privateKey: entry.privateKey, index, mnemonic: entry.mnemonic }
  } else {
    // Any other HD index needs the phrase.
    if (!entry.mnemonic) throw new Error('This wallet cannot switch to that account.')
    const derived = deriveHdWallet(entry.mnemonic, index)
    key = { address: derived.address, privateKey: derived.privateKey, index, mnemonic: entry.mnemonic }
  }

  await saveAccounts({ ...list, activeIndex: index })
  // Preserve the original unlock deadline: switching is not a re-authentication.
  await memorySet(
    JSON.stringify({
      privateKey: key.privateKey,
      address: key.address,
      index: key.index,
      mnemonic: key.mnemonic,
      ...(entry.imported ? { imported: entry.imported } : {}),
      unlockedAt: entry.unlockedAt,
    } satisfies SessionEntry),
  )
  return key
}

/**
 * Add the next HD account (highest existing index + 1), derived from the session's
 * mnemonic. Persists it in the registry and returns the updated list. Does NOT switch to
 * it — the caller decides whether adding should also activate. Throws for a raw-key
 * import, which has no phrase to derive from.
 */
export async function addHdAccount(label?: string): Promise<AccountList> {
  const raw = await memoryGet()
  if (!raw) throw new Error('The wallet is locked.')
  let entry: SessionEntry
  try {
    entry = JSON.parse(raw) as SessionEntry
  } catch {
    throw new Error('The wallet is locked.')
  }
  if (!entry.mnemonic)
    throw new Error('This wallet was imported from a private key, so it holds a single account only.')

  const list = (await loadAccounts()) ?? { accounts: [], activeIndex: 0 }
  const nextIndex = list.accounts.reduce((max, a) => Math.max(max, a.index), -1) + 1
  const derived = deriveHdWallet(entry.mnemonic, nextIndex)
  const trimmed = label?.trim()
  const account: HdAccount = { index: nextIndex, address: derived.address, ...(trimmed ? { label: trimmed } : {}) }
  const next: AccountList = { accounts: [...list.accounts, account], activeIndex: list.activeIndex }
  await saveAccounts(next)
  return next
}

/**
 * Import a raw private key as an ADDITIONAL account, alongside the HD accounts. Works for
 * any wallet — HD or itself imported — because it does not derive from the phrase: it
 * encrypts the pasted key into its own keystore under the SAME wallet password, so one
 * unlock opens it and every other account together.
 *
 * The password is required (to encrypt with it, and to verify it against the root before
 * writing anything), and the new key is dropped into the live session so the account is
 * usable immediately without a re-unlock. Does not change which account is active.
 */
export async function addImportedAccount(
  privateKey: string,
  password: string,
  label?: string,
): Promise<{ list: AccountList; index: number; address: string }> {
  const account = await loadAccount()
  if (!account) throw new Error('There is no wallet on this device yet.')

  // Verify the password unlocks this wallet before we encrypt the new key with it — an
  // imported keystore under a different password would silently fail to open at unlock.
  await ethers.Wallet.fromEncryptedJson(account.json, password)

  const trimmedKey = privateKey.trim()
  let wallet: ethers.Wallet
  try {
    wallet = new ethers.Wallet(trimmedKey.startsWith('0x') ? trimmedKey : `0x${trimmedKey}`)
  } catch {
    throw new Error('That is not a valid private key. It should be 64 hex characters, usually with a 0x in front.')
  }

  const list =
    (await loadAccounts()) ?? { accounts: [{ index: 0, address: account.address }], activeIndex: 0 }
  if (list.accounts.some((a) => a.address.toLowerCase() === wallet.address.toLowerCase())) {
    throw new Error('That account is already in this wallet.')
  }

  const json = await wallet.encrypt(password, { scrypt: { N: SCRYPT_N } })
  const nextIndex = list.accounts.reduce((max, a) => Math.max(max, a.index), -1) + 1
  const trimmed = label?.trim()
  const acct: HdAccount = {
    index: nextIndex,
    address: wallet.address,
    kind: 'imported',
    json,
    ...(trimmed ? { label: trimmed } : {}),
  }
  const next: AccountList = { accounts: [...list.accounts, acct], activeIndex: list.activeIndex }
  await saveAccounts(next)

  // Make the new key usable this session without another unlock.
  const raw = await memoryGet()
  if (raw) {
    try {
      const entry = JSON.parse(raw) as SessionEntry
      const imported = { ...(entry.imported ?? {}), [String(nextIndex)]: wallet.privateKey }
      await memorySet(JSON.stringify({ ...entry, imported }))
    } catch {
      /* no readable session — the account is persisted and works after the next unlock */
    }
  }

  return { list: next, index: nextIndex, address: wallet.address }
}

/** Rename an account in the registry. Labels are cosmetic and hold no key material, so
 *  this needs no session and no password. Clearing the label reverts to the default name. */
export async function renameHdAccount(index: number, label: string): Promise<AccountList> {
  const list = await loadAccounts()
  if (!list) throw new Error('There is no wallet on this device yet.')
  const trimmed = label.trim()
  const accounts = list.accounts.map((a) =>
    a.index === index ? { ...a, label: trimmed || undefined } : a,
  )
  const next: AccountList = { ...list, accounts }
  await saveAccounts(next)
  return next
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
  // The session carries the active account it was closed on; older sessions (written
  // before multi-account) have neither field, so fall back to the keystore's account 0.
  return {
    address: typeof entry.address === 'string' ? entry.address : account.address,
    privateKey: entry.privateKey,
    index: typeof entry.index === 'number' ? entry.index : 0,
    mnemonic: typeof entry.mnemonic === 'string' ? entry.mnemonic : null,
  }
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
