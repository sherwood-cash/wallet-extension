import { BigNumber } from 'ethers'
import deployment from './deployment.json'

// The native ETH sentinel used on-chain (PrivacyVault.NATIVE_ASSET_ID = 1). The
// native asset lives in tree `assetId = 1`, with token address(0) internally.
export const NATIVE_ASSET_ID = BigNumber.from(1)

export interface AssetConfig {
  // ERC-20 token address, or the zero address for native ETH.
  token: string
  decimals: number
  // True for the native gas coin (ETH). No approve/permit; deposit rides as msg.value.
  native: boolean
}

export interface Routers {
  v2: string
  v3: string
  v4: string
}

export interface Deployment {
  network: string
  chainId: number
  rpcUrl: string
  // Indexer base URL. When unset the frontend falls back to a direct RPC log scan.
  indexerUrl?: string
  // Relayer base URL. When unset it falls back to indexerUrl. VITE_RELAYER_URL overrides.
  relayerUrl?: string
  explorer: string
  deployBlock: number
  logChunk: number
  merkleTreeHeight: number
  admin: string

  // Single immutable custodian of all funds (ETH + ERC20) — the PrivacyVault.
  vault: string
  // UUPS route-builder proxy consumed by the vault.
  swapLogic: string
  verifier2: string
  hasher: string
  hasher4: string
  weth: string

  // Vault-allowlisted Uniswap routers per version. v2/v3 are the Uniswap routers directly;
  // v4 is the UniswapV4Adapter (the vault's canonical V4 router), not the UniversalRouter —
  // the vault pays a router by plain ERC20 approval, which the Permit2-based UniversalRouter
  // can't consume, so the adapter bridges the two.
  routers: Routers

  // V4 backing: the adapter allowlisted above, plus the UniversalRouter it forwards to and
  // the Permit2 it uses. Informational — the frontend builds UniversalRouter V4 payloads and
  // the vault routes them through the adapter. Present only when V4 is wired.
  v4?: { adapter: string; universalRouter: string; permit2: string }

  // Uniswap Quoter addresses (read-only price estimation, called via eth_call).
  // Optional — the swap UI falls back to reading pool state directly when unset.
  quoters?: { v3?: string; v4?: string }

  // Known V3 pools for configured pairs (effective/WETH addresses), so the swap
  // estimate skips fee-tier discovery and quotes in one call. Optional; imported
  // tokens still discover their tier on-chain.
  v3Pools?: { tokenA: string; tokenB: string; fee: number }[]

  nativeCurrency: { name: string; symbol: string; decimals: number }

  // Protocol fee wired on the vault (admin-set, hard-capped at 10%). `feeAssets`
  // are the asset keys charged as base/fee assets on swaps.
  protocolFee?: { swapBps: number; withdrawBps: number; recipient: string; feeAssets: string[] }

  // Registered assets, keyed by a short UI key (e.g. "eth", "usdg").
  assets: Record<string, AssetConfig>
}

/**
 * The deployment, with its endpoints overridable at build time.
 *
 * `deployment.json` ships with `rpcUrl`, `indexerUrl` and `relayerUrl` blank on purpose:
 * this repo is public, and an RPC URL is a credential — Alchemy, Infura and friends put
 * the key in the path. Committing one hands anybody who clones the repo a billable
 * endpoint. So the values arrive from the environment at build time instead, and a build
 * without them produces a wallet that cannot reach a chain rather than one quietly
 * spending someone else's quota.
 *
 * See `.env.example` for the variables and README.md for where to get them.
 */
const env = import.meta.env as Record<string, string | undefined>

export const DEPLOYMENT: Deployment = {
  ...(deployment as Deployment),
  rpcUrl: env.VITE_RPC_URL?.trim() || (deployment as Deployment).rpcUrl,
  indexerUrl: env.VITE_INDEXER_URL?.trim() || (deployment as Deployment).indexerUrl,
  relayerUrl: env.VITE_RELAYER_URL?.trim() || (deployment as Deployment).relayerUrl,
}

/** True when the build was given an RPC endpoint. Without one every read fails, and the
 *  UI would rather say so up front than surface a wall of network errors. */
export const hasRpc = (): boolean => DEPLOYMENT.rpcUrl.trim().length > 0

export const ZERO = '0x0000000000000000000000000000000000000000'

/**
 * Arbitrary-token discovery: importing a token by address, the Uniswap search results in
 * the token picker, and the "Trending on Uniswap" list.
 *
 * ON in permissionless mode — the vault runs with `setPermissionlessSwaps(true)`, so any
 * token / any pool is tradable and the picker exposes the full discovery surface (import
 * by address, Uniswap search, trending). Flip back to `false` only if the vault is ever
 * re-closed to the `swapAllowed` allowlist, so the UI never surfaces pairs the contract
 * would refuse.
 */
export const SHOW_ARBITRARY_TOKENS = true

// Block explorer for tx links. deployment.json wins when it names one; otherwise fall back
// to the chain's Blockscout. Without a fallback an unset `explorer` produced `/tx/0x…` —
// a relative URL that silently resolves against our own origin and 404s.
const DEFAULT_EXPLORER = 'https://robinhoodchain.blockscout.com'
export const EXPLORER = (DEPLOYMENT.explorer || DEFAULT_EXPLORER).replace(/\/+$/, '')

/** Canonical link to a transaction on the configured explorer. */
export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`

export const CHAIN_NAMES: Record<number, string> = {}

export const CHAIN_PARAMS = {
  chainId: '0x' + DEPLOYMENT.chainId.toString(16),
  chainName: CHAIN_NAMES[DEPLOYMENT.chainId] || DEPLOYMENT.network,
  nativeCurrency: DEPLOYMENT.nativeCurrency,
  rpcUrls: [DEPLOYMENT.rpcUrl],
  blockExplorerUrls: [EXPLORER],
}

// assetId = uint256(uint160(token)); native ETH uses the sentinel (assetId = 1).
// Returned as a BigNumber — it is the private `mintAddress` label in the circuit
// AND the on-chain tree namespace, so both sides agree.
export function assetIdOf(token: string): BigNumber {
  if (token === ZERO) return NATIVE_ASSET_ID
  return BigNumber.from(token)
}

export function isNativeAsset(asset: AssetConfig): boolean {
  return asset.native || asset.token === ZERO
}

// Minimum deposit/withdraw for native ETH. A dust amount can't cover the relayer's
// gas fee (~0.00007 ETH) and reverts on-chain with an opaque error, so the UI gates it
// up-front. Only the native leg is gated — the relayer fee for ERC-20 quotes is tiny.
// Where $SHERWOOD trades until it migrates. External on purpose: the token is not on this
// chain's own venues yet, so the header link has to leave the app.
export const SHERWOOD_LAUNCHPAD =
  'https://www.ponsfamily.com/launchpad/0xD4DC6B48Ad73EC51E71D9B8F65568f88609b92c1'

export const MIN_NATIVE_ETH = 0.0005

/** True when `amount` (a human string) is a non-zero native-ETH amount below the minimum. */
export function belowNativeMin(asset: AssetConfig, amount: string): boolean {
  if (!isNativeAsset(asset)) return false
  const n = Number(amount)
  return Number.isFinite(n) && n > 0 && n < MIN_NATIVE_ETH
}

// Minimum ETH-input swap. A dust swap can't cover the relayer fee (the vault reverts
// with "ext amount must exceed fee"), and tiny routes get chewed up by fees/slippage.
// Gated on the input leg being native ETH.
export const MIN_SWAP_ETH = 0.001

/** True when a native-ETH swap input `amount` is a non-zero value below the swap minimum. */
export function belowSwapMin(fromAsset: AssetConfig, amount: string): boolean {
  if (!isNativeAsset(fromAsset)) return false
  const n = Number(amount)
  return Number.isFinite(n) && n > 0 && n < MIN_SWAP_ETH
}

// Quote assets are the only ones the vault lets in or out, and every fee is denominated
// in one. Native ETH always qualifies; the rest come from the deployment's asset list.
// Mirrors SherwoodVault._isQuote — the contract is the authority, this is for UI gating.
export function isQuoteAsset(asset: AssetConfig): boolean {
  return isNativeAsset(asset) || QUOTE_KEYS.has((asset as { key?: string }).key ?? '')
}

const QUOTE_KEYS = new Set(['eth', 'usdg', 'sherwood'])

// Display metadata for the asset selector, keyed by the deployment.assets key.
export interface AssetMeta extends AssetConfig {
  key: string
  symbol: string
  name: string
  accent: string // icon background color
  logoUrl?: string // remote logo (tokens discovered through the Uniswap gateway)
  assetId: BigNumber
  /** A not-yet-launched teaser token: shown in the lists but never selectable/usable. */
  comingSoon?: boolean
  /**
   * Depositable and withdrawable, but NOT swappable yet: shown greyed in the swap picker
   * with the same "after migration" treatment a teaser gets, and selectable everywhere
   * else. $SHERWOOD until it migrates off the launchpad — the vault would let a swap
   * through (permissionless swaps are on), but there is no pool here to route it to, so
   * the gate is the UI's job.
   */
  swapAfterMigration?: boolean
}

const ASSET_META: Record<string, { symbol: string; name: string; accent: string; logoUrl?: string }> = {
  eth: { symbol: 'ETH', name: 'Ethereum', accent: '#627eea' },
  usdg: { symbol: 'USDG', name: 'USD Global', accent: '#2775ca' },
  sherwood: { symbol: '$SHERWOOD', name: 'Sherwood', accent: '#1f6f4a', logoUrl: '/parallax/logo-mark.webp' },
  cashcat: { symbol: 'CASHCAT', name: 'Cash Cat', accent: '#f2b705', logoUrl: '/assets/cashcat.png' },
  pipedog: { symbol: 'PIPEDOG', name: 'Pipedog', accent: '#e8853a', logoUrl: '/assets/pipedog.png' },
  pons: { symbol: 'PONS', name: 'Pons', accent: '#9b6dff', logoUrl: '/assets/pons.png' },
  nvda: { symbol: 'NVDA', name: 'NVIDIA', accent: '#76b900', logoUrl: '/assets/nvda.png' },
  spcx: { symbol: 'SPCX', name: 'SpaceX', accent: '#005288', logoUrl: '/assets/spcx.png' },
  tsla: { symbol: 'TSLA', name: 'Tesla', accent: '#e82127', logoUrl: '/assets/tsla.png' },
  whatif: { symbol: 'IF', name: 'What If', accent: '#7c5cff', logoUrl: '/assets/what-if.png' },
}

// Display order for the selector (native ETH first, then USDG, then others).
// ETH stays first: the head of this list is the default selection everywhere, and a
// swap-disabled asset must never be one (SwapCard seeds from/to with assets[0]/assets[1]).
const ASSET_ORDER = ['eth', 'usdg', 'sherwood', 'cashcat', 'pipedog', 'pons', 'nvda', 'spcx', 'tsla', 'whatif']
const orderRank = (key: string) => {
  const i = ASSET_ORDER.indexOf(key)
  return i === -1 ? ASSET_ORDER.length : i
}

// Real, depositable, withdrawable — but with no pool on this chain until they migrate off
// the launchpad, so the swap picker still shows them greyed. $SHERWOOD is one of these
// rather than a teaser because it now has a genuine on-chain address the vault accepts.
const SWAP_AFTER_MIGRATION = new Set(['sherwood'])

export const ASSETS: AssetMeta[] = Object.entries(DEPLOYMENT.assets)
  .map(([key, a]) => ({
    ...a,
    key,
    symbol: ASSET_META[key]?.symbol ?? key.toUpperCase(),
    name: ASSET_META[key]?.name ?? key,
    accent: ASSET_META[key]?.accent ?? '#50d2c1',
    logoUrl: ASSET_META[key]?.logoUrl,
    assetId: assetIdOf(a.token),
    swapAfterMigration: SWAP_AFTER_MIGRATION.has(key),
  }))
  .sort((a, b) => orderRank(a.key) - orderRank(b.key))

// Teaser tokens: not launched, no on-chain address, never selectable anywhere. Kept OUT of
// ASSETS so no default selection can ever land on one; the UI injects them into the display
// lists and renders them disabled with an "after migration" tag. Empty since $SHERWOOD
// graduated from a teaser to a real quote asset — kept because the next one will need it.
export const COMING_SOON_ASSETS: AssetMeta[] = []

export function assetByKey(key: string): AssetMeta | undefined {
  return ASSETS.find((a) => a.key === key)
}

// Find the registered asset for a token address (case-insensitive). Native ETH
// matches the zero address.
export function assetByToken(token: string): AssetMeta | undefined {
  const t = token.toLowerCase()
  return ASSETS.find((a) => a.token.toLowerCase() === t)
}

// The vault must be wired in before deposit/withdraw/swap work.
export function isConfigured(): boolean {
  return DEPLOYMENT.vault !== ZERO && DEPLOYMENT.chainId !== 0
}

// Swaps additionally need the SwapLogic proxy + at least one router wired in.
export function isSwapEnabled(): boolean {
  return (
    isConfigured() &&
    DEPLOYMENT.swapLogic !== ZERO &&
    (DEPLOYMENT.routers.v2 !== ZERO || DEPLOYMENT.routers.v3 !== ZERO || DEPLOYMENT.routers.v4 !== ZERO)
  )
}
