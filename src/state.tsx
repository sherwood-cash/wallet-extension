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
import { indexerBaseUrl } from '@app/lib/privacy/indexer'
import {
  loadShieldedBalances,
  saveShieldedBalances,
  type CachedNoteSummary,
} from '@app/lib/privacy/shieldedCache'
import { readProvider } from '@app/lib/rpc'
import { ASSETS, DEPLOYMENT, assetByToken, type AssetMeta } from '@app/config'
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

/** Read an ERC-20's metadata so an added token shows a real symbol, decimals and logo.
 *  Prefers the indexer's resolver — the same `/tokens/:address` route the web app's token
 *  import uses (it enriches with a DexScreener logo) — and falls back to a direct on-chain
 *  read when no indexer is configured or it cannot resolve the token. */
async function fetchTokenMeta(address: string): Promise<AssetMeta> {
  const addr = ethers.utils.getAddress(address)

  const base = indexerBaseUrl()
  if (base) {
    try {
      const res = await fetch(`${base}/tokens/${addr}`, { headers: { accept: 'application/json' } })
      if (res.ok) {
        const body = (await res.json()) as {
          token?: { symbol?: string | null; name?: string | null; decimals?: number | null; logoUrl?: string | null }
        }
        const t = body?.token
        if (t && (t.symbol || t.decimals != null)) {
          return {
            token: addr,
            decimals: Number(t.decimals ?? 18),
            native: false,
            key: `t:${addr.toLowerCase()}`,
            symbol: t.symbol || addr.slice(0, 6),
            name: t.name || t.symbol || 'Token',
            accent: '#cdb360',
            logoUrl: t.logoUrl || undefined,
            assetId: ethers.BigNumber.from(addr),
          } as AssetMeta
        }
      }
    } catch {
      /* fall through to a direct on-chain read */
    }
  }

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
    accent: '#cdb360',
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

/** The top tokens by vault TVL, straight from the indexer's /assets ranking — the same
 *  list the web app's Assets page shows. Used to widen Private mode beyond the three
 *  defaults so a user sees their shielded balance across the assets that actually trade
 *  here. Returns [] with no indexer or on any failure. */
async function fetchTopAssets(limit = 12): Promise<AssetMeta[]> {
  const base = indexerBaseUrl()
  if (!base) return []
  try {
    const sher = ASSETS.find((a) => a.key === 'sherwood')?.token
    const include = sher ? `&include=${sher}` : ''
    const res = await fetch(`${base}/assets?limit=${limit}${include}`, { headers: { accept: 'application/json' } })
    if (!res.ok) return []
    const body = (await res.json()) as {
      assets?: Array<{
        assetId: string
        token: string
        native?: boolean
        symbol?: string | null
        name?: string | null
        decimals?: number | null
        logoUrl?: string | null
      }>
    }
    const rows = Array.isArray(body?.assets) ? body.assets : []
    const out: AssetMeta[] = []
    for (const a of rows) {
      if (!a || a.decimals == null || !a.symbol) continue
      const native = !!a.native
      const token = native ? ethers.constants.AddressZero : a.token
      // Where the deployment already describes this token, its curated metadata wins — same as
      // the web front's toAsset (lib/assets.ts). That keeps the local key/symbol/name/accent and,
      // crucially, its local logo file for the baked-in assets. Otherwise take the backend's
      // fields, and prefer the /assets logoUrl (a CDN URL) over the symbol-guessed local png so
      // stocks (NVDA/TSLA/GOOGL) show their real mark instead of a mismatched token image.
      const local = assetByToken(token)
      out.push({
        token,
        decimals: local?.decimals ?? Number(a.decimals),
        native,
        key: local?.key ?? (native ? 'eth' : `t:${token.toLowerCase()}`),
        symbol: local?.symbol ?? a.symbol,
        name: local?.name ?? a.name ?? a.symbol,
        accent: local?.accent ?? '#cdb360',
        logoUrl: local?.logoUrl ?? a.logoUrl ?? undefined,
        assetId: ethers.BigNumber.from(a.assetId),
      } as AssetMeta)
    }
    return out
  } catch {
    return []
  }
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
  const [topAssets, setTopAssets] = useState<AssetMeta[]>([])

  // The opaque per-account tag for the shielded-balance session cache: the UTXO pubkey,
  // never the on-chain address (see shieldedCache.ts). Null until sign-in derives the keys.
  const accountTag = useMemo(() => (keys ? keys.keypair.pubkey.toString() : null), [keys])
  // Latest scan set, read by the balances effect without making it depend on the array
  // identity — the effect keys on `scanKey`, so a re-render that only rebuilds the array
  // does not re-run the scan.
  const scanAssetsRef = useRef<AssetMeta[]>([])

  // Pull the top-by-TVL ranking once; Private mode widens to it so the shielded scan covers
  // the assets that actually trade here, not just the three defaults.
  useEffect(() => {
    let alive = true
    fetchTopAssets(12)
      .then((a) => {
        if (alive) setTopAssets(a)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // The visible list. Normal mode: the three defaults + the user's own added tokens. Private
  // mode also folds in the top-by-TVL assets so shielded balances are computed across them.
  // Deduped by token address (defaults first, then TVL, then custom).
  const assets = useMemo(() => {
    const list: AssetMeta[] = [...DEFAULT_ASSETS]
    const seen = new Set(DEFAULT_ASSETS.map((a) => a.token.toLowerCase()))
    const add = (arr: AssetMeta[]) => {
      for (const a of arr) {
        const t = a.token.toLowerCase()
        if (seen.has(t)) continue
        seen.add(t)
        list.push(a)
      }
    }
    if (mode === 'private') add(topAssets)
    add(customAssets)
    return list
  }, [mode, topAssets, customAssets])

  // The set the shielded scan actually walks — the mode-independent UNION of every asset a
  // balance could exist in: the defaults, the top-by-TVL ranking (which Private mode shows)
  // and the user's own tokens. Deliberately NOT keyed on `mode`: the shielded set does not
  // depend on which face is displayed, so flipping Normal⇄Private must not re-run the scan.
  // It only re-fires when the asset UNIVERSE actually grows (top-TVL landing async, a token
  // added), and even then the per-asset leafCache serves already-scanned trees from their
  // cached frontier, so the arrival merges rather than rescanning everything.
  const scanAssets = useMemo(() => {
    const list: AssetMeta[] = [...DEFAULT_ASSETS]
    const seen = new Set(DEFAULT_ASSETS.map((a) => a.token.toLowerCase()))
    const add = (arr: AssetMeta[]) => {
      for (const a of arr) {
        const t = a.token.toLowerCase()
        if (seen.has(t)) continue
        seen.add(t)
        list.push(a)
      }
    }
    add(topAssets)
    add(customAssets)
    return list
  }, [topAssets, customAssets])

  // A stable signature of the scan set, so the scan effect re-runs only when the set of
  // assets CHANGES — not on every render that rebuilds the array identity.
  const scanKey = useMemo(
    () => scanAssets.map((a) => a.key).sort().join(','),
    [scanAssets],
  )
  scanAssetsRef.current = scanAssets

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

  // --- shielded cache hydration -------------------------------------------
  // The popup is torn down on blur, so the in-memory shielded Map is gone on every reopen.
  // Rather than show a spinner while the scan recomputes numbers it had seconds ago, paint
  // the last computed balances straight from the memory-only session cache the moment the
  // note keys are ready. The scan below then refreshes them underneath (tail-only, thanks to
  // leafCache) — the cached values are a display optimisation, never the spend source.
  useEffect(() => {
    if (!accountTag) return
    let alive = true
    // A different account's balances must not linger; start this account from its own cache.
    setShielded(new Map())
    loadShieldedBalances(accountTag)
      .then((cached) => {
        if (!alive || !cached) return
        setShielded((prev) => {
          const next = new Map(prev)
          for (const [key, s] of cached) {
            // Never clobber a value the live scan has already written this session.
            if (next.has(key)) continue
            next.set(key, {
              balance: ethers.BigNumber.from(s.balance),
              count: s.count,
              spendable: ethers.BigNumber.from(s.spendable),
            })
          }
          return next
        })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [accountTag])

  // --- plain wallet balances ----------------------------------------------
  // One Multicall3 round-trip, cheap, so it refreshes on every tick and follows the displayed
  // asset list. This alone drives `loading`, so the wallet view (and Normal mode) shows
  // numbers the moment it lands — it never waits on the shielded scan.
  useEffect(() => {
    if (!address) {
      setWallet(new Map())
      setLoading(false)
      return
    }
    let alive = true
    withTimeout(fetchAssetBalances(readProvider, address, assets), 20000)
      .then((m) => {
        if (alive) setWallet(m)
      })
      .catch((e) => console.error('wallet balances', e))
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [address, tick, assets])

  // --- shielded scan -------------------------------------------------------
  // Walks the merkle tree and trial-decrypts every leaf, so it only runs once keys exist and
  // streams results in as each asset lands. Keyed on `scanKey` (the mode-independent asset
  // UNION) — NOT on `mode` or the displayed `assets` — so a Normal⇄Private toggle does not
  // rescan: the shielded set is the same regardless of which face is showing. When the asset
  // universe grows (top-TVL landing, a token added) the per-asset leafCache serves the
  // already-scanned trees from their cached frontier, so the new scan merges rather than
  // re-downloading everything. Results are persisted to the session cache so the next reopen
  // hydrates instantly (see above).
  useEffect(() => {
    if (!address) {
      setShielded(new Map())
      setShieldedLoading(false)
      setRefreshing(false)
      return
    }
    if (!keys || !accountTag) {
      setShieldedLoading(false)
      setRefreshing(false)
      return
    }
    let alive = true
    setRefreshing(true)
    setShieldedLoading(true)
    const scanned = scanAssetsRef.current
    withTimeout(
      getShieldedBalances(readProvider, scanned, keys, DEPLOYMENT.deployBlock, (key, summary) => {
        if (alive) setShielded((prev) => new Map(prev).set(key, summary))
      }),
      60000,
    )
      .then((result) => {
        if (!alive) return
        // Persist the fresh set so the next reopen paints without a spinner.
        const payload = new Map<string, CachedNoteSummary>()
        for (const [key, s] of result) {
          payload.set(key, {
            balance: s.balance.toString(),
            count: s.count,
            spendable: s.spendable.toString(),
          })
        }
        void saveShieldedBalances(accountTag, payload)
      })
      .catch((e) => console.error('shielded balances', e))
      .finally(() => {
        if (alive) {
          setShieldedLoading(false)
          setRefreshing(false)
        }
      })
    return () => {
      alive = false
    }
    // scanAssetsRef is read via ref; scanKey is its stable signature so the scan re-runs
    // only when the asset universe actually changes, never on a mode flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, keys, accountTag, tick, scanKey])

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
