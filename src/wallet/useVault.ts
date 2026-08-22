/**
 * The React face of the vault.
 *
 * The state lives in this module rather than in a component, and `useVault()` is a
 * subscription to it. That is the whole design decision here: <App/>, <Onboarding/>
 * and <Settings/> each call the hook on their own, and if the hook owned its state
 * they would each get a different wallet — Onboarding could unlock a vault that App
 * still believed was empty. A module store makes "the vault" a single thing, which is
 * what it physically is.
 *
 * Everything that can throw goes through `run()`, so `busy`, `error` and the scrypt
 * `progress` stay consistent with each other and no screen has to wrap a two-second
 * operation in its own try/catch/finally.
 */
import { useMemo, useSyncExternalStore } from 'react'
import { ethers } from 'ethers'
import {
  addHdAccount,
  addImportedAccount,
  connectSigner,
  createWallet,
  describeError,
  endSession,
  importWallet,
  loadAccount,
  loadAccounts,
  renameHdAccount,
  resumeSession,
  revealSecret,
  sessionExpired,
  startSession,
  switchActiveAccount,
  unlockWallet,
  wipeVault,
  type HdAccount,
  type UnlockedKey,
} from './vault'

export type VaultStatus = 'loading' | 'empty' | 'locked' | 'unlocked'

export interface VaultApi {
  status: VaultStatus
  address: string | null
  /** ethers.Wallet already connected to the read provider. Null unless unlocked. */
  signer: ethers.Wallet | null
  busy: boolean
  error: string | null
  /**
   * 0 → 1 while scrypt runs. Unlocking is deliberately expensive, so the screens show
   * this as a percentage rather than letting the popup look frozen.
   */
  progress: number
  /**
   * Every HD account this wallet knows about: index, address and optional label. A
   * wallet imported from a raw private key has exactly one entry and cannot grow —
   * `canAddAccount` says so — because it has no mnemonic to derive further accounts from.
   */
  accounts: HdAccount[]
  /** The HD derivation index of the account `address`/`signer` currently belong to. */
  activeIndex: number
  /** False for a raw-private-key import (no mnemonic → no further derivation possible). */
  canAddAccount: boolean
  /** Derive the next HD account and switch to it. No-op label is fine. */
  addAccount(label?: string): Promise<void>
  /** Import a raw private key as an additional account and switch to it. Requires the
   *  wallet password (to encrypt the key with it). Available on every wallet, including a
   *  raw-key import — unlike `addAccount`, which needs a mnemonic. */
  importPrivateKey(privateKey: string, password: string, label?: string): Promise<void>
  /** Make the account at `index` the active one; flips `address`/`signer` downstream. */
  switchAccount(index: number): Promise<void>
  /** Rename an account. Cosmetic; an empty label reverts to the default name. */
  renameAccount(index: number, label: string): Promise<void>
  /** Create a brand-new wallet. Returns the 12-word mnemonic to show ONCE. */
  create(password: string): Promise<string>
  /**
   * Commit the wallet `create()` just minted, once its owner confirms they wrote the
   * phrase down. Separate from `create` on purpose: unlocking from inside `create`
   * would flip <App/> into the wallet and unmount the phrase before it was read.
   */
  activate(): void
  /** Import an existing mnemonic or 0x-prefixed private key. */
  importSecret(secret: string, password: string): Promise<void>
  unlock(password: string): Promise<void>
  lock(): void
  /** Re-derives the mnemonic from the keystore. Requires the password again. */
  reveal(password: string): Promise<{ mnemonic: string | null; privateKey: string }>
  /** Wipes the keystore entirely. Used by "remove wallet" in Settings. */
  wipe(): Promise<void>
}

/** How often an open popup re-checks the auto-lock deadline. The check is a storage
 *  read and a subtraction, so the interval is about responsiveness, not cost. */
const EXPIRY_POLL_MS = 15_000

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

interface VaultState {
  status: VaultStatus
  address: string | null
  /** The live signer. Holding it here rather than the bare key means the popup keeps
   *  exactly one Wallet object, and the key itself has one fewer place to sit. */
  signer: ethers.Wallet | null
  /** The persisted HD account registry, mirrored into the store so Settings can list it. */
  accounts: HdAccount[]
  activeIndex: number
  /** Whether the active wallet has a mnemonic behind it (only then can accounts grow). */
  canAddAccount: boolean
  busy: boolean
  error: string | null
  progress: number
}

let state: VaultState = {
  status: 'loading',
  address: null,
  signer: null,
  accounts: [],
  activeIndex: 0,
  canAddAccount: false,
  busy: false,
  error: null,
  progress: 0,
}

const listeners = new Set<() => void>()

function setState(patch: Partial<VaultState>): void {
  state = { ...state, ...patch }
  for (const notify of listeners) notify()
}

const getSnapshot = (): VaultState => state

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // The auto-lock timer runs only while something is watching. The popup itself is
  // short-lived, but `?view=tab` keeps a wallet mounted for hours, and a deadline that
  // were only checked on open would leave that tab unlocked indefinitely.
  if (listeners.size === 1) startExpiryTimer()
  void boot()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) stopExpiryTimer()
  }
}

let expiryTimer: ReturnType<typeof setInterval> | null = null

function startExpiryTimer(): void {
  if (expiryTimer !== null) return
  expiryTimer = setInterval(() => {
    if (state.status !== 'unlocked') return
    void sessionExpired().then((expired) => {
      if (expired && state.status === 'unlocked') lock()
    })
  }, EXPIRY_POLL_MS)
}

function stopExpiryTimer(): void {
  if (expiryTimer === null) return
  clearInterval(expiryTimer)
  expiryTimer = null
}

/**
 * Three questions, in order: is there a wallet, is there a live session, and has that
 * session aged out. `resumeSession` answers the last two and cleans up after itself.
 * Runs once per page load — the flag also absorbs StrictMode's double effect.
 */
let booted = false
async function boot(): Promise<void> {
  if (booted) return
  booted = true
  const account = await loadAccount()
  if (!account) return setState({ status: 'empty' })

  const session = await resumeSession()
  if (session) await adopt(session)
  else setState({ status: 'locked', address: account.address, signer: null })
}

/** Take ownership of a decrypted key: this is the only path to `status: 'unlocked'`.
 *  Also refreshes the account registry, since a fresh unlock is the first chance the
 *  store has to know how many accounts exist and which one is active. */
async function adopt(key: UnlockedKey): Promise<void> {
  const list = await loadAccounts()
  setState({
    status: 'unlocked',
    address: key.address,
    signer: connectSigner(key.privateKey),
    accounts: list?.accounts ?? [{ index: key.index, address: key.address }],
    activeIndex: key.index,
    // Only an HD wallet (one with a mnemonic) can derive more accounts. A raw-key import
    // returns mnemonic: null and stays a single account.
    canAddAccount: key.mnemonic !== null,
    error: null,
  })
}

/**
 * The one place a vault operation is awaited. It owns the busy flag, resets the
 * progress counter and turns whatever ethers threw into a sentence, so the screens
 * only ever deal with `busy` and `error`.
 */
async function run<T>(fallback: string, op: () => Promise<T>): Promise<T> {
  setState({ busy: true, error: null, progress: 0 })
  try {
    return await op()
  } catch (e) {
    const message = describeError(e, fallback)
    setState({ error: message })
    throw new Error(message)
  } finally {
    setState({ busy: false, progress: 0 })
  }
}

const reportProgress = (fraction: number): void => setState({ progress: fraction })

// ---------------------------------------------------------------------------
// Actions — module-level, so their identity never changes between renders
// ---------------------------------------------------------------------------

/** A wallet that has been generated and encrypted but whose owner has not yet
 *  confirmed the recovery phrase. Never written to session storage until they do. */
let pending: UnlockedKey | null = null

async function create(password: string): Promise<string> {
  return run('The wallet could not be created.', async () => {
    const made = await createWallet(password, reportProgress)
    pending = { address: made.address, privateKey: made.privateKey, index: made.index, mnemonic: made.mnemonic }
    return made.mnemonic
  })
}

function activate(): void {
  const held = pending
  if (!held) return
  pending = null
  void adopt(held)
  // Only now does the key reach session storage: a popup closed on the phrase screen
  // should come back locked, not signed in behind a recovery phrase nobody read.
  void startSession(held)
}

async function importSecret(secret: string, password: string): Promise<void> {
  await run('The wallet could not be imported.', async () => {
    await adopt(await importWallet(secret, password, reportProgress))
  })
}

async function unlock(password: string): Promise<void> {
  await run('The wallet could not be unlocked.', async () => {
    await adopt(await unlockWallet(password, reportProgress))
  })
}

function lock(): void {
  // The address survives a lock so the unlock screen can name the account it is
  // asking about. Only the key goes.
  setState({ status: 'locked', signer: null, error: null, progress: 0 })
  void endSession()
}

async function reveal(password: string): Promise<{ mnemonic: string | null; privateKey: string }> {
  return run('The recovery phrase could not be read.', () => revealSecret(password, reportProgress))
}

/**
 * Derive the next HD account and switch to it. Adopting the new key flips `address` and
 * `signer`, which <state.tsx> watches to re-derive the shielded keys and refetch
 * balances — so no extra plumbing is needed to move the whole popup to the new account.
 */
async function addAccount(label?: string): Promise<void> {
  await run('The account could not be added.', async () => {
    const list = await addHdAccount(label)
    const newest = list.accounts.reduce((a, b) => (b.index > a.index ? b : a), list.accounts[0])
    // adopt() reloads the registry, so it will see the account addHdAccount just saved.
    await adopt(await switchActiveAccount(newest.index))
  })
}

/** Import a raw private key as a new account and switch to it. Encrypts the key under the
 *  wallet password, then adopts it — flipping `address`/`signer` like any other switch. */
async function importPrivateKey(privateKey: string, password: string, label?: string): Promise<void> {
  await run('The private key could not be imported.', async () => {
    const { index } = await addImportedAccount(privateKey, password, label)
    await adopt(await switchActiveAccount(index))
  })
}

async function switchAccount(index: number): Promise<void> {
  if (index === state.activeIndex && state.status === 'unlocked') return
  await run('The account could not be switched.', async () => {
    const key = await switchActiveAccount(index)
    await adopt(key)
  })
}

async function renameAccount(index: number, label: string): Promise<void> {
  await run('The account could not be renamed.', async () => {
    const list = await renameHdAccount(index, label)
    setState({ accounts: list.accounts })
  })
}

async function wipe(): Promise<void> {
  await run('The wallet could not be removed.', async () => {
    await wipeVault()
    pending = null
    setState({
      status: 'empty',
      address: null,
      signer: null,
      accounts: [],
      activeIndex: 0,
      canAddAccount: false,
    })
  })
}

export function useVault(): VaultApi {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot)
  return useMemo(
    () => ({
      ...snapshot,
      addAccount,
      importPrivateKey,
      switchAccount,
      renameAccount,
      create,
      activate,
      importSecret,
      unlock,
      lock,
      reveal,
      wipe,
    }),
    [snapshot],
  )
}
