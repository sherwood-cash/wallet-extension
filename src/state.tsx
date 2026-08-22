/**
 * The popup's one piece of shared state: who is signed in, what they hold, and the
 * local activity feed. Every flow screen reads it through `useAccountState()` instead
 * of taking a dozen props, so a screen can be written without knowing how the shell
 * wires it up.
 *
 * Deliberately thin. The protocol logic — note scanning, proving, routing — all lives
 * in the web app's `@app/lib` and is imported, not re-implemented; this file only
 * decides *when* to call it and holds the answers.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { ethers } from 'ethers'
import {
  fetchAssetBalances,
  getShieldedBalances,
  type AssetBalances,
  type Keys,
  type NoteSummary,
} from '@app/lib/actions'
import { signIn } from '@app/lib/privacy/encryption'
import { readProvider } from '@app/lib/rpc'
import { ASSETS, DEPLOYMENT, type AssetMeta } from '@app/config'
import type { ActivityItem, Screen } from './types'

/** Local activity feed. Persisted per-address so reopening the popup keeps the trail. */
const ACTIVITY_KEY = 'sherwood:ext:activity:'
const ACTIVITY_MAX = 30

/** Which face of the wallet is showing. Persisted globally (not per-address) so the
 *  choice survives a lock/unlock and a reopen. */
export type WalletMode = 'normal' | 'private'
const MODE_KEY = 'sherwood:ext:mode'

function readMode(): WalletMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'private' ? 'private' : 'normal'
  } catch {
    return 'normal'
  }
}

export interface AccountState {
  /** Local signer, already connected to the read RPC. Null while locked. */
  signer: ethers.Wallet | null
  address: string | null
  /** Note-spending keys, derived from a signature the local wallet makes silently. */
  keys: Keys | null
  /** True while the keys are still being derived on unlock. */
  signingIn: boolean

  /** Which face of the wallet is showing: a plain EOA wallet, or the shielded pool. */
  mode: WalletMode
  setMode: (m: WalletMode) => void
  /** Flip between the two faces. */
  toggleMode: () => void

  assets: AssetMeta[]
  asset: AssetMeta
  selectAsset: (key: string) => void

  /** Plain (unshielded) wallet balances per asset key, plus the native gas balance. */
  wallet: Map<string, AssetBalances>
  /** Shielded note totals per asset key. */
  shielded: Map<string, NoteSummary>
  /** True during the first load, so the UI shows skeletons rather than zeroes. */
  loading: boolean
  /** True while a background refresh is in flight (first load included). */
  refreshing: boolean
  refresh: () => void

  /** Human-formatted helpers for the currently selected asset. */
  walletBalanceOf: (asset: AssetMeta) => string | null
  shieldedBalanceOf: (asset: AssetMeta) => string | null
  /** Native gas balance as a human string — what pays for a self-submitted deposit. */
  nativeBalance: string | null

  activity: ActivityItem[]
  pushActivity: (item: ActivityItem) => void

  /** Navigate the shell. */
  go: (screen: Screen) => void
  /** Re-open the current screen as a full browser tab (survives losing focus). */
  expand: () => void
}

const Ctx = createContext<AccountState | null>(null)

export function useAccountState(): AccountState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAccountState must be used inside <AccountProvider>')
  return ctx
}

/** Format a base-unit balance the way the app does: trimmed, never in exponent form. */
export function fmtUnits(v: ethers.BigNumber | undefined, decimals: number, max = 6): string {
  if (!v) return '0'
  const s = ethers.utils.formatUnits(v, decimals)
  if (!s.includes('.')) return s
  const [whole, frac] = s.split('.')
  const cut = frac.slice(0, max).replace(/0+$/, '')
  return cut ? `${whole}.${cut}` : whole
}

export function AccountProvider({
  signer,
  address,
  go,
  children,
}: {
  signer: ethers.Wallet | null
  address: string | null
  go: (screen: Screen) => void
  children: ReactNode
}) {
  const [keys, setKeys] = useState<Keys | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  const [mode, setModeState] = useState<WalletMode>(readMode)
  const [assetKey, setAssetKey] = useState<string>(ASSETS[0]?.key ?? 'eth')
  const [wallet, setWallet] = useState<Map<string, AssetBalances>>(new Map())
  const [shielded, setShielded] = useState<Map<string, NoteSummary>>(new Map())
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [activity, setActivity] = useState<ActivityItem[]>([])
  const [tick, setTick] = useState(0)

  const asset = useMemo(
    () => ASSETS.find((a) => a.key === assetKey) ?? ASSETS[0],
    [assetKey],
  )

  // --- sign-in -------------------------------------------------------------
  // The web app pops a wallet prompt here. A local key signs the same fixed message
  // silently, so unlocking the popup IS the sign-in: one password, no second step.
  useEffect(() => {
    let alive = true
    if (!signer) {
      setKeys(null)
      return
    }
    setSigningIn(true)
    signIn(signer)
      .then((k) => {
        if (alive) setKeys({ encryptionKey: k.encryptionKey, keypair: k.keypair })
      })
      .catch((e) => console.error('sign-in failed', e))
      .finally(() => {
        if (alive) setSigningIn(false)
      })
    return () => {
      alive = false
    }
  }, [signer])

  // --- activity feed -------------------------------------------------------
  useEffect(() => {
    if (!address) return setActivity([])
    try {
      const raw = localStorage.getItem(ACTIVITY_KEY + address.toLowerCase())
      setActivity(raw ? (JSON.parse(raw) as ActivityItem[]) : [])
    } catch {
      setActivity([])
    }
  }, [address])

  const pushActivity = useCallback(
    (item: ActivityItem) => {
      const entry = { ...item, at: item.at ?? Date.now() }
      setActivity((prev) => {
        const next = [entry, ...prev].slice(0, ACTIVITY_MAX)
        if (address) {
          try {
            localStorage.setItem(ACTIVITY_KEY + address.toLowerCase(), JSON.stringify(next))
          } catch {
            /* quota — the feed is a convenience, never the source of truth */
          }
        }
        return next
      })
      // A landed transaction moves both balances; re-read rather than guess.
      setTick((t) => t + 1)
    },
    [address],
  )

  // --- balances ------------------------------------------------------------
  // Plain balances land in one Multicall3 round-trip and are cheap, so they refresh
  // on every tick. The shielded scan walks the merkle tree and trial-decrypts every
  // leaf, so it only runs once keys exist and streams results in as each asset lands.
  const inFlight = useRef(false)
  useEffect(() => {
    if (!address) {
      setWallet(new Map())
      setShielded(new Map())
      setLoading(false)
      return
    }
    if (inFlight.current) return
    let alive = true
    inFlight.current = true
    setRefreshing(true)

    const plain = fetchAssetBalances(readProvider, address, ASSETS)
      .then((m) => {
        if (alive) setWallet(m)
      })
      .catch((e) => console.error('wallet balances', e))

    const priv = keys
      ? getShieldedBalances(readProvider, ASSETS, keys, DEPLOYMENT.deployBlock, (key, summary) => {
          if (alive) setShielded((prev) => new Map(prev).set(key, summary))
        }).catch((e) => console.error('shielded balances', e))
      : Promise.resolve()

    Promise.all([plain, priv]).finally(() => {
      inFlight.current = false
      if (!alive) return
      setLoading(false)
      setRefreshing(false)
    })

    return () => {
      alive = false
    }
  }, [address, keys, tick])

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  const setMode = useCallback((m: WalletMode) => {
    setModeState(m)
    try {
      localStorage.setItem(MODE_KEY, m)
    } catch {
      /* private-mode / quota — the toggle still works for this session */
    }
  }, [])

  const toggleMode = useCallback(
    () => setMode(mode === 'private' ? 'normal' : 'private'),
    [mode, setMode],
  )

  const walletBalanceOf = useCallback(
    (a: AssetMeta) => {
      const b = wallet.get(a.key)
      return b ? fmtUnits(b.token, a.decimals) : null
    },
    [wallet],
  )

  const shieldedBalanceOf = useCallback(
    (a: AssetMeta) => {
      const s = shielded.get(a.key)
      return s ? fmtUnits(s.balance, a.decimals) : null
    },
    [shielded],
  )

  const nativeBalance = useMemo(() => {
    const any = wallet.values().next().value as AssetBalances | undefined
    return any ? fmtUnits(any.native, DEPLOYMENT.nativeCurrency.decimals) : null
  }, [wallet])

  const expand = useCallback(() => {
    try {
      void chrome.tabs.create({ url: chrome.runtime.getURL('index.html?view=tab') })
    } catch {
      window.open('index.html?view=tab', '_blank')
    }
  }, [])

  const value: AccountState = {
    signer,
    address,
    keys,
    signingIn,
    mode,
    setMode,
    toggleMode,
    assets: ASSETS,
    asset,
    selectAsset: setAssetKey,
    wallet,
    shielded,
    loading,
    refreshing,
    refresh,
    walletBalanceOf,
    shieldedBalanceOf,
    nativeBalance,
    activity,
    pushActivity,
    go,
    expand,
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
