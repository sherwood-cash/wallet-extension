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

/** Tokens the wallet shows by default. Everything else is opt-in via "add token". */
const DEFAULT_ASSET_KEYS = ['eth', 'usdg', 'sherwood']
const DEFAULT_ASSETS: AssetMeta[] = ASSETS.filter((a) => DEFAULT_ASSET_KEYS.includes(a.key))

/** User-added tokens, persisted so a reopen keeps them. Stored as plain rows because a
 *  BigNumber assetId does not survive JSON — it is re-derived from the token on load. */
const TOKENS_KEY = 'sherwood:ext:tokens'
interface StoredToken {
  key: string
  token: string
  decimals: number
  symbol: string
  name: string
  accent?: string
  logoUrl?: string
}

function toAsset(t: StoredToken): AssetMeta {
  return {
    token: t.token,
    decimals: t.decimals,
    native: false,
    key: t.key,
    symbol: t.symbol,
    name: t.name,
    accent: t.accent ?? '#50d2c1',
    logoUrl: t.logoUrl,
    assetId: ethers.BigNumber.from(t.token),
  } as AssetMeta
}

function readCustomTokens(): AssetMeta[] {
  try {
    const raw = localStorage.getItem(TOKENS_KEY)
    if (!raw) return []
    const rows = JSON.parse(raw) as StoredToken[]
    return Array.isArray(rows) ? rows.map(toAsset) : []
  } catch {
    return []
  }
}

function saveCustomTokens(list: AssetMeta[]): void {
  try {
    const rows: StoredToken[] = list.map((a) => ({
      key: a.key,
      token: a.token,
      decimals: a.decimals,
      symbol: a.symbol,
      name: a.name,
      accent: a.accent,
      logoUrl: a.logoUrl,
    }))
    localStorage.setItem(TOKENS_KEY, JSON.stringify(rows))
  } catch {
    /* quota / private-mode storage — the token list is a convenience */
  }
}

const ERC20_META_ABI = [
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
]

/** Read an ERC-20's metadata so an added token shows a real symbol and decimals. */
async function fetchTokenMeta(address: string): Promise<AssetMeta> {
  const addr = ethers.utils.getAddress(address)
  const c = new ethers.Contract(addr, ERC20_META_ABI, readProvider)
  const [symbol, name, decimals] = await Promise.all([
    c.symbol().catch(() => addr.slice(0, 6)),
    c.name().catch(() => 'Token'),
    c
      .decimals()
      .then((d: number) => Number(d))
      .catch(() => 18),
  ])
  return {
    token: addr,
    decimals,
    native: false,
    key: `t:${addr.toLowerCase()}`,
    symbol,
    name,
    accent: '#50d2c1',
    assetId: ethers.BigNumber.from(addr),
  } as AssetMeta
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

  /** The deployment's other tokens not currently shown — suggestions for "add token". */
  catalog: AssetMeta[]
  /** Add a token from the catalog (by its metadata). */
  addToken: (meta: AssetMeta) => void
  /** Add a token by address; reads symbol/name/decimals on-chain. Throws on bad/duplicate. */
  addTokenByAddress: (address: string) => Promise<AssetMeta>
  /** Remove a user-added token. Defaults (ETH/USDG/SHERWOOD) cannot be removed. */
  removeToken: (key: string) => void
  /** Whether a token is a non-removable default. */
  isDefaultAsset: (key: string) => boolean

  /** Plain (unshielded) wallet balances per asset key, plus the native gas balance. */
  wallet: Map<string, AssetBalances>
  /** Shielded note totals per asset key. */
  shielded: Map<string, NoteSummary>
  /** True during the first load of the plain wallet balances, so the UI shows skeletons. */
  loading: boolean
  /** True while the shielded (private) scan is still running — independent of `loading`. */
  shieldedLoading: boolean
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

/** Reject a promise if it hasn't settled in `ms`, so a stalled read never wedges the UI. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('read timed out')), ms)),
  ])
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
  const [customAssets, setCustomAssets] = useState<AssetMeta[]>(readCustomTokens)
  const [shieldedLoading, setShieldedLoading] = useState(false)

  // The visible list: the three defaults, then whatever the user has added (deduped by key).
  const assets = useMemo(() => {
    const seen = new Set(DEFAULT_ASSETS.map((a) => a.key))
    return [...DEFAULT_ASSETS, ...customAssets.filter((a) => !seen.has(a.key))]
  }, [customAssets])

  // The deployment's other tokens not already shown — the "add from list" suggestions.
  const catalog = useMemo(() => {
    const shown = new Set(assets.map((a) => a.token.toLowerCase()))
    return ASSETS.filter((a) => !shown.has(a.token.toLowerCase()))
  }, [assets])

  const asset = useMemo(
    () => assets.find((a) => a.key === assetKey) ?? assets[0],
    [assets, assetKey],
  )

  const isDefaultAsset = useCallback((key: string) => DEFAULT_ASSET_KEYS.includes(key), [])

  const addToken = useCallback((meta: AssetMeta) => {
    setCustomAssets((prev) => {
      if (DEFAULT_ASSET_KEYS.includes(meta.key)) return prev
      if (prev.some((a) => a.token.toLowerCase() === meta.token.toLowerCase())) return prev
      const next = [...prev, meta]
      saveCustomTokens(next)
      return next
    })
    setTick((t) => t + 1)
  }, [])

  const addTokenByAddress = useCallback(
    async (address: string) => {
      if (!ethers.utils.isAddress(address)) throw new Error('Not a valid token address')
      const addr = ethers.utils.getAddress(address)
      if (
        DEFAULT_ASSETS.concat(customAssets).some((a) => a.token.toLowerCase() === addr.toLowerCase())
      ) {
        throw new Error('Token already added')
      }
      const meta = await fetchTokenMeta(addr)
      addToken(meta)
      return meta
    },
    [customAssets, addToken],
  )

  const removeToken = useCallback(
    (key: string) => {
      if (DEFAULT_ASSET_KEYS.includes(key)) return
      setCustomAssets((prev) => {
        const next = prev.filter((a) => a.key !== key)
        saveCustomTokens(next)
        return next
      })
      setAssetKey((cur) => (cur === key ? 'eth' : cur))
    },
    [],
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
  useEffect(() => {
    if (!address) {
      setWallet(new Map())
      setShielded(new Map())
      setLoading(false)
      setShieldedLoading(false)
      setRefreshing(false)
      return
    }
    let alive = true
    setRefreshing(true)

    // Plain wallet balances: one Multicall3 round-trip. This alone drives `loading`, so the
    // wallet view (and Normal mode) shows numbers the moment it lands — it never waits on the
    // shielded scan, which is what used to leave BOTH modes stuck on a spinner.
    withTimeout(fetchAssetBalances(readProvider, address, assets), 20000)
      .then((m) => {
        if (alive) setWallet(m)
      })
      .catch((e) => console.error('wallet balances', e))
      .finally(() => {
        if (alive) setLoading(false)
      })

    // Shielded scan: only once note keys exist. Streams each asset in as it resolves and
    // carries its own loading flag, kept separate from `loading` on purpose.
    if (keys) {
      setShieldedLoading(true)
      withTimeout(
        getShieldedBalances(readProvider, assets, keys, DEPLOYMENT.deployBlock, (key, summary) => {
          if (alive) setShielded((prev) => new Map(prev).set(key, summary))
        }),
        60000,
      )
        .catch((e) => console.error('shielded balances', e))
        .finally(() => {
          if (alive) {
            setShieldedLoading(false)
            setRefreshing(false)
          }
        })
    } else {
      setShieldedLoading(false)
      setRefreshing(false)
    }

    return () => {
      alive = false
    }
  }, [address, keys, tick, assets])

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
    assets,
    asset,
    selectAsset: setAssetKey,
    catalog,
    addToken,
    addTokenByAddress,
    removeToken,
    isDefaultAsset,
    wallet,
    shielded,
    loading,
    shieldedLoading,
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
