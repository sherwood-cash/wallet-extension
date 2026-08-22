// Build the version-specific `routeData` the PrivacyVault.executeSwap → SwapLogic
// pipeline expects. SwapLogic decodes routeData per version and the vault performs
// the swap through the vault-allowlisted canonical router.
//
// The vault operates purely in ERC-20 terms with routers: it wraps native ETH to
// WETH before the call and unwraps after. So an ETH leg must be encoded with the
// WETH address (SwapLogic checks `path[0] == effectiveIn`, etc.).
import { ethers } from 'ethers'
import { DEPLOYMENT, ZERO, isNativeAsset, isQuoteAsset, type AssetMeta } from '../config'
import { indexerBaseUrl } from './privacy/indexer'
// Reads go to the deployment RPC, never the wallet's.
import { readProvider } from './rpc'

// ISwapLogic.Version — the uint8 the vault/SwapLogic expects.
export enum SwapVersion {
  V2 = 0,
  V3 = 1,
  V4 = 2,
}

export interface SwapRoute {
  version: SwapVersion
  routeData: string // abi-encoded bytes for SwapLogic
}

// The ERC-20 address SwapLogic/the vault deals in for an asset leg: WETH for native ETH.
// Used for V2/V3 routes and for pool discovery (DexScreener/factories key on WETH).
export function effectiveToken(asset: AssetMeta): string {
  return isNativeAsset(asset) ? DEPLOYMENT.weth : asset.token
}

// The Uniswap V4 currency for an asset leg: NATIVE ETH is address(0), not WETH — a V4 ETH
// pool keys on the native currency. The adapter wraps/unwraps around the swap.
export function v4Currency(asset: AssetMeta): string {
  return isNativeAsset(asset) ? ZERO : asset.token
}

const coder = ethers.utils.defaultAbiCoder

// ---- V2: routeData = abi.encode(address[] path) ----
export function encodeV2Route(from: AssetMeta, to: AssetMeta): SwapRoute {
  const path = [effectiveToken(from), effectiveToken(to)]
  return { version: SwapVersion.V2, routeData: coder.encode(['address[]'], [path]) }
}

// ---- V3 single-hop: routeData = abi.encode(tokenIn, tokenOut, uint24 fee) ----
// SwapLogic keys off the 96-byte length to treat this as exactInputSingle.
export function encodeV3SingleRoute(from: AssetMeta, to: AssetMeta, fee: number): SwapRoute {
  const routeData = coder.encode(
    ['address', 'address', 'uint24'],
    [effectiveToken(from), effectiveToken(to), fee],
  )
  return { version: SwapVersion.V3, routeData }
}

// ---- V3 multi-hop: routeData = abi.encode(bytes path) ----
// `path` is the packed Uniswap v3 path (token, fee, token, fee, …, token).
export function encodeV3MultiRoute(path: string): SwapRoute {
  return { version: SwapVersion.V3, routeData: coder.encode(['bytes'], [path]) }
}

// Pack a Uniswap v3 multihop path from alternating tokens/fees.
export function packV3Path(tokens: string[], fees: number[]): string {
  if (tokens.length !== fees.length + 1) throw new Error('v3 path: tokens must be fees+1')
  let packed = '0x'
  for (let i = 0; i < fees.length; i++) {
    packed += tokens[i].slice(2)
    packed += fees[i].toString(16).padStart(6, '0')
  }
  packed += tokens[tokens.length - 1].slice(2)
  return packed
}

// ---- V4: routeData = abi.encode(bytes commands, bytes[] inputs) ----
// The vault routes V4 through the UniswapV4Adapter (canonicalRouter[V4]): SwapLogic hands
// the adapter (tokenIn, tokenOut, amountIn) + these opaque commands/inputs, and the adapter
// pulls the input, wires Permit2 → UniversalRouter, runs the route, and sweeps proceeds to
// the vault. This is the raw passthrough for pre-built UniversalRouter blobs.
export function encodeV4Route(commands: string, inputs: string[]): SwapRoute {
  return { version: SwapVersion.V4, routeData: coder.encode(['bytes', 'bytes[]'], [commands, inputs]) }
}

// Uniswap V4 PoolKey + the parts of a UniversalRouter V4 exact-input-single route.
export interface V4Pool {
  fee: number // Uniswap fee units (hundredths of a bip), e.g. 3000 = 0.30%
  tickSpacing: number
  hooks: string // hookless pools use the zero address
}

// UniversalRouter command + V4 action selectors (see @uniswap/universal-router + v4-periphery).
const CMD_V4_SWAP = '0x10'
const ACT_SWAP_EXACT_IN_SINGLE = '06'
const ACT_SETTLE_ALL = '0c'
const ACT_TAKE_ALL = '0f'

// Build a real UniversalRouter V4 exact-input single-hop route: SWAP_EXACT_IN_SINGLE then
// SETTLE_ALL (pay tokenIn) then TAKE_ALL (receive tokenOut). `amountIn` MUST be the amount
// the vault will actually route — SwapLogic passes the same figure to the adapter, so an
// inputs-embedded amount above it makes the router's pull revert.
//
// A native-ETH leg uses address(0) as its currency (a V4 ETH pool keys on native ETH); the
// UniswapV4Adapter wraps/unwraps around the swap so the vault still deals in WETH.
export function encodeV4ExactInSingle(
  from: AssetMeta,
  to: AssetMeta,
  amountIn: ethers.BigNumber,
  minOut: ethers.BigNumber,
  pool: V4Pool,
): SwapRoute {
  const tokenIn = v4Currency(from)
  const tokenOut = v4Currency(to)
  const [currency0, currency1] =
    tokenIn.toLowerCase() < tokenOut.toLowerCase() ? [tokenIn, tokenOut] : [tokenOut, tokenIn]
  const zeroForOne = tokenIn.toLowerCase() === currency0.toLowerCase()

  const poolKey = [currency0, currency1, pool.fee, pool.tickSpacing, pool.hooks]
  const swapParams = coder.encode(
    ['tuple((address,address,uint24,int24,address),bool,uint128,uint128,bytes)'],
    [[poolKey, zeroForOne, amountIn, minOut, '0x']],
  )
  const settleParams = coder.encode(['address', 'uint256'], [tokenIn, amountIn])
  const takeParams = coder.encode(['address', 'uint256'], [tokenOut, minOut])
  const actions = '0x' + ACT_SWAP_EXACT_IN_SINGLE + ACT_SETTLE_ALL + ACT_TAKE_ALL
  const v4Input = coder.encode(['bytes', 'bytes[]'], [actions, [swapParams, settleParams, takeParams]])
  return encodeV4Route(CMD_V4_SWAP, [v4Input])
}

// ---- best-route resolution -------------------------------------------------
// The fee tier is NOT fixed: a pair's only real pool can sit on any tier, and
// encoding a tier with no pool makes the router revert with "router call failed"
// (the vault asks the router for a pool that doesn't exist). Uniswap's hosted
// routing API doesn't serve this chain, so we pick the DEEPEST pool via
// DexScreener (which indexes it) and read the tier off that pool on-chain, with
// a pure on-chain factory scan as the fallback.
const V3_FEE_TIERS = [100, 500, 3000, 10000]

// Best V3 fee tier per pair, memoised for the session. A pair's tier is stable, so
// we resolve it once and reuse it: a re-quote on every keystroke — and the route
// lookup at submit — must not re-scan the chain. Keyed by the unordered pair (the
// fee is symmetric), so from→to and to→from share one entry.
const bestFeeCache = new Map<string, number>()
const feeKey = (a: string, b: string) => [a.toLowerCase(), b.toLowerCase()].sort().join('-')

// Seed the cache with the deployment's known pools, so configured pairs quote in a
// single call from the very first estimate — no tier discovery. Imported/unknown
// tokens still discover their tier on-chain (and cache it) on first quote.
for (const pool of DEPLOYMENT.v3Pools ?? []) {
  bestFeeCache.set(feeKey(pool.tokenA, pool.tokenB), pool.fee)
}

const ROUTER_ABI = ['function factory() view returns (address)']
const FACTORY_ABI = ['function getPool(address,address,uint24) view returns (address)']
const POOL_ABI = [
  'function fee() view returns (uint24)',
  'function liquidity() view returns (uint128)',
]

// Fee tier of the deepest Uniswap V3 pool for the pair, per the backend (which
// ranks DexScreener's pairs and reads the tier off the pool). null when there is
// no backend, no pool, or the lookup fails — the caller then scans on-chain.
async function bestFeeFromBackend(tokenIn: string, tokenOut: string): Promise<number | null> {
  const base = indexerBaseUrl()
  if (!base) return null
  const res = await fetch(`${base}/best-pool?tokenA=${tokenIn}&tokenB=${tokenOut}`, {
    headers: { accept: 'application/json' },
  })
  if (!res.ok) return null
  const body = (await res.json()) as { fee?: number }
  return typeof body?.fee === 'number' ? body.fee : null
}

// Fallback: ask the router's own factory for every tier and keep the deepest.
async function deepestV3FeeOnChain(tokenIn: string, tokenOut: string): Promise<number | null> {
  const factoryAddr: string = await new ethers.Contract(
    DEPLOYMENT.routers.v3,
    ROUTER_ABI,
    readProvider,
  ).factory()
  const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, readProvider)
  const found = await Promise.all(
    V3_FEE_TIERS.map(async (fee) => {
      const addr: string = await factory.getPool(tokenIn, tokenOut, fee)
      if (addr === ZERO) return null
      const liquidity = await new ethers.Contract(addr, POOL_ABI, readProvider).liquidity()
      return { fee, liquidity }
    }),
  )
  const best = found
    .filter((x): x is { fee: number; liquidity: ethers.BigNumber } => x !== null)
    .sort((a, b) => (a.liquidity.eq(b.liquidity) ? 0 : a.liquidity.lt(b.liquidity) ? 1 : -1))[0]
  return best ? best.fee : null
}

// Full best-pool record from the backend (ranks DexScreener across V3 and V4). null when
// there is no backend, no pool, or the lookup fails — the caller then scans V3 on-chain.
interface BackendPool {
  version: 'v3' | 'v4'
  fee: number
  tickSpacing?: number
  hooks?: string
}
async function bestPoolFromBackend(tokenIn: string, tokenOut: string): Promise<BackendPool | null> {
  const base = indexerBaseUrl()
  if (!base) return null
  const res = await fetch(`${base}/best-pool?tokenA=${tokenIn}&tokenB=${tokenOut}`, {
    headers: { accept: 'application/json' },
  })
  if (!res.ok) return null
  const body = (await res.json()) as BackendPool & { fee?: number }
  if (typeof body?.fee !== 'number') return null
  return { version: body.version === 'v4' ? 'v4' : 'v3', fee: body.fee, tickSpacing: body.tickSpacing, hooks: body.hooks }
}

// Metadata of the best V4 pool per pair, memoised for the session (the PoolKey is stable).
const v4PoolCache = new Map<string, V4Pool>()

// The V4 pool the vault would route this pair through, or null. Usable when a V4 router is
// wired and the backend reports a V4 pool as deepest with a fully-known PoolKey. Native-ETH
// pairs are supported (the adapter wraps/unwraps). Pool discovery keys on WETH (what
// DexScreener indexes); the route itself keys on address(0) for the ETH leg. Shared by both
// the estimate and the actual route so they never disagree. Memoised per pair.
async function preferredV4Pool(from: AssetMeta, to: AssetMeta): Promise<V4Pool | null> {
  if (DEPLOYMENT.routers.v4 === ZERO) return null
  const key = feeKey(effectiveToken(from), effectiveToken(to))
  const cached = v4PoolCache.get(key)
  if (cached) return cached
  // DexScreener must be queried by a REAL token address, and a native-ETH V4 pool is indexed
  // under native ETH (address(0)), not WETH — so query by the non-native token and pass the
  // other leg as its V4 currency (address(0) for ETH). The backend normalises ETH↔WETH.
  const nonNative = !isNativeAsset(from) ? from : to
  const other = nonNative === from ? to : from
  try {
    const best = await bestPoolFromBackend(nonNative.token, v4Currency(other))
    if (best?.version === 'v4' && typeof best.tickSpacing === 'number') {
      const pool: V4Pool = { fee: best.fee, tickSpacing: best.tickSpacing, hooks: best.hooks ?? ZERO }
      v4PoolCache.set(key, pool)
      return pool
    }
  } catch {
    /* backend unreachable — caller falls back to V3 */
  }
  return null
}

// The amount the vault will actually route: when selling a quote it first takes the protocol
// swap fee off the input (SherwoodVault.executeSwap), so a V4 route must embed THAT figure,
// not the gross, or the adapter's Permit2 allowance won't cover the router's pull. Mirrors
// SherwoodVault._feeOn (floored, and only when a fee recipient is configured).
function routedAmountIn(from: AssetMeta, amountIn: ethers.BigNumber): ethers.BigNumber {
  const bps = DEPLOYMENT.protocolFee?.swapBps ?? 0
  const recipient = DEPLOYMENT.protocolFee?.recipient ?? ZERO
  const feeApplies = isQuoteAsset(from) && bps > 0 && recipient !== ZERO
  return feeApplies ? amountIn.sub(amountIn.mul(bps).div(10_000)) : amountIn
}

// Route a from→to pair through the deepest available pool. V4 is selected only when the
// backend reports a deeper V4 pool with a fully-known PoolKey AND both legs are ERC-20
// (the vault deals in WETH with routers, whereas native-ETH V4 pools key on address(0)),
// AND the amounts are known (a V4 route embeds them). Everything else routes V3, then V2.
export async function resolveRoute(
  from: AssetMeta,
  to: AssetMeta,
  amountIn?: ethers.BigNumber,
  minOut?: ethers.BigNumber,
): Promise<SwapRoute> {
  const tokenIn = effectiveToken(from)
  const tokenOut = effectiveToken(to)

  // ---- V4: only when a V4 pool is preferred AND the amounts are known (a route embeds them) ----
  if (amountIn && minOut) {
    const pool = await preferredV4Pool(from, to)
    if (pool) return encodeV4ExactInSingle(from, to, routedAmountIn(from, amountIn), minOut, pool)
  }

  if (DEPLOYMENT.routers.v3 !== ZERO) {
    // The estimate the user just saw already resolved (and cached) the tier, so
    // submit normally spends zero RPC here.
    let fee: number | null = bestFeeCache.get(feeKey(tokenIn, tokenOut)) ?? null
    if (fee === null) {
      try {
        fee = await bestFeeFromBackend(tokenIn, tokenOut)
      } catch {
        /* backend unreachable — fall through to the on-chain scan */
      }
    }
    if (fee === null) fee = await deepestV3FeeOnChain(tokenIn, tokenOut)
    if (fee !== null) {
      bestFeeCache.set(feeKey(tokenIn, tokenOut), fee)
      return encodeV3SingleRoute(from, to, fee)
    }
  }

  if (DEPLOYMENT.routers.v2 !== ZERO) return encodeV2Route(from, to)
  throw new Error(`No Uniswap pool found for ${from.symbol} → ${to.symbol}`)
}

// ---- output estimate -------------------------------------------------------
// Primary path: the deployed QuoterV2 (exact, crosses ticks). We resolve a pair's
// tier once (quoting all tiers, keeping the max) and cache it, so a settled quote
// costs ONE eth_call to the quoter — not a per-keystroke factory/pool/liquidity
// scan. Only when no quoter is configured do we fall back to reading pool state:
// exact constant-product for V2, within-current-tick sqrtPrice math for V3.
const Q96 = ethers.BigNumber.from(2).pow(96)

const V3_POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
]
// Uniswap QuoterV2. quoteExactInputSingle is non-view (it simulates the swap), so
// it's called through callStatic / eth_call — it returns the exact amountOut across
// ticks, price impact and pool fee included.
const QUOTER_V2_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]
const V2_FACTORY_ABI = ['function getPair(address,address) view returns (address)']
const V2_PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32)',
  'function token0() view returns (address)',
]
// Uniswap V4 Quoter (v4-periphery). quoteExactInputSingle simulates the swap and reverts
// to return, so it is called through callStatic / eth_call. It takes the full PoolKey.
const QUOTER_V4_ABI = [
  'function quoteExactInputSingle((tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)',
]

// The vault charges swapFeeBps on the swap (SherwoodVault.executeSwap), so shave it
// off the estimate to reflect what actually lands in the output note.
function afterProtocolFee(amount: ethers.BigNumber): ethers.BigNumber {
  const bps = DEPLOYMENT.protocolFee?.swapBps ?? 0
  return bps > 0 ? amount.mul(10_000 - bps).div(10_000) : amount
}

async function v3PoolFor(tokenIn: string, tokenOut: string): Promise<{ pool: string; fee: number } | null> {
  let fee: number | null = null
  try {
    fee = await bestFeeFromBackend(tokenIn, tokenOut)
  } catch {
    /* backend unreachable — fall through to the on-chain scan */
  }
  if (fee === null) fee = await deepestV3FeeOnChain(tokenIn, tokenOut)
  if (fee === null) return null
  const factoryAddr: string = await new ethers.Contract(DEPLOYMENT.routers.v3, ROUTER_ABI, readProvider).factory()
  const pool: string = await new ethers.Contract(factoryAddr, FACTORY_ABI, readProvider).getPool(tokenIn, tokenOut, fee)
  return pool === ZERO ? null : { pool, fee }
}

const quoterV3 = (): ethers.Contract | null => {
  const addr = DEPLOYMENT.quoters?.v3
  return addr && addr !== ZERO ? new ethers.Contract(addr, QUOTER_V2_ABI, readProvider) : null
}

const quoterV4 = (): ethers.Contract | null => {
  const addr = DEPLOYMENT.quoters?.v4
  return addr && addr !== ZERO ? new ethers.Contract(addr, QUOTER_V4_ABI, readProvider) : null
}

// Exact V4 estimate for a non-native pair, through the same pool resolveRoute would route.
// null when there's no preferred V4 pool, no V4 quoter, or the pool can't price the size —
// the caller then falls back to V3/V2, so the estimate degrades instead of blocking.
async function quoteV4(from: AssetMeta, to: AssetMeta, amountIn: ethers.BigNumber): Promise<ethers.BigNumber | null> {
  const quoter = quoterV4()
  if (!quoter) return null
  const pool = await preferredV4Pool(from, to)
  if (!pool) return null
  // The PoolKey keys on address(0) for a native-ETH leg, same as the route.
  const tokenIn = v4Currency(from)
  const tokenOut = v4Currency(to)
  const [currency0, currency1] =
    tokenIn.toLowerCase() < tokenOut.toLowerCase() ? [tokenIn, tokenOut] : [tokenOut, tokenIn]
  const zeroForOne = tokenIn.toLowerCase() === currency0.toLowerCase()
  try {
    const res = await quoter.callStatic.quoteExactInputSingle([
      [currency0, currency1, pool.fee, pool.tickSpacing, pool.hooks],
      zeroForOne,
      amountIn,
      '0x',
    ])
    const out: ethers.BigNumber = res.amountOut ?? res[0]
    // Same as the V3 path: shave the vault's swap fee off so the estimate reflects the note.
    return out && out.gt(0) ? afterProtocolFee(out) : null
  } catch {
    return null
  }
}

// One quoter call on a specific tier. null (not throw) when that tier has no pool,
// so a tier scan can Promise.all without one revert killing the batch.
async function quoterOut(
  quoter: ethers.Contract,
  tokenIn: string,
  tokenOut: string,
  fee: number,
  amountIn: ethers.BigNumber,
): Promise<ethers.BigNumber | null> {
  try {
    const res = await quoter.callStatic.quoteExactInputSingle({
      tokenIn,
      tokenOut,
      amountIn,
      fee,
      sqrtPriceLimitX96: 0,
    })
    const out: ethers.BigNumber = res.amountOut ?? res[0]
    return out && out.gt(0) ? out : null
  } catch {
    return null
  }
}

async function quoteV3(tokenIn: string, tokenOut: string, amountIn: ethers.BigNumber): Promise<ethers.BigNumber | null> {
  const quoter = quoterV3()
  if (quoter) {
    const key = feeKey(tokenIn, tokenOut)
    const cached = bestFeeCache.get(key)
    // Fast path: known tier → a single eth_call.
    if (cached !== undefined) {
      const out = await quoterOut(quoter, tokenIn, tokenOut, cached, amountIn)
      if (out) return afterProtocolFee(out)
      // Cached tier stopped pricing (rare) — re-discover below.
    }
    // Discover the tier: quote every tier once, keep the max, cache it. Runs once
    // per pair; thereafter the fast path above is used.
    const outs = await Promise.all(
      V3_FEE_TIERS.map(async (fee) => ({ fee, out: await quoterOut(quoter, tokenIn, tokenOut, fee, amountIn) })),
    )
    const best = outs
      .filter((x): x is { fee: number; out: ethers.BigNumber } => x.out !== null)
      .sort((a, b) => (a.out.gt(b.out) ? -1 : 1))[0]
    if (!best) return null // quoter present but no V3 pool → caller tries V2
    bestFeeCache.set(key, best.fee)
    return afterProtocolFee(best.out)
  }

  // No quoter configured: fall back to reading pool state directly.
  const info = await v3PoolFor(tokenIn, tokenOut)
  if (!info) return null
  const pool = new ethers.Contract(info.pool, V3_POOL_ABI, readProvider)
  const [slot0, liquidity, token0]: [any, ethers.BigNumber, string] = await Promise.all([
    pool.slot0(),
    pool.liquidity(),
    pool.token0(),
  ])
  const sqrtP: ethers.BigNumber = slot0.sqrtPriceX96
  const L = liquidity
  if (sqrtP.isZero() || L.isZero()) return null
  const zeroForOne = tokenIn.toLowerCase() === token0.toLowerCase()
  const inAfterFee = amountIn.mul(1_000_000 - info.fee).div(1_000_000)
  let out: ethers.BigNumber
  if (zeroForOne) {
    // token0 in → token1 out; price falls. sqrtNext = L·sqrtP / (L + amountIn·sqrtP/Q96)
    const numerator1 = L.mul(Q96)
    const sqrtNext = numerator1.mul(sqrtP).div(numerator1.add(inAfterFee.mul(sqrtP)))
    out = L.mul(sqrtP.sub(sqrtNext)).div(Q96) // amount1 = L·Δsqrt / Q96
  } else {
    // token1 in → token0 out; price rises. sqrtNext = sqrtP + amountIn·Q96/L
    const sqrtNext = sqrtP.add(inAfterFee.mul(Q96).div(L))
    out = L.mul(sqrtNext.sub(sqrtP)).mul(Q96).div(sqrtNext.mul(sqrtP)) // amount0 = L·Δsqrt·Q96 / (sqrtP·sqrtNext)
  }
  return out.gt(0) ? afterProtocolFee(out) : null
}

async function quoteV2(tokenIn: string, tokenOut: string, amountIn: ethers.BigNumber): Promise<ethers.BigNumber | null> {
  const factoryAddr: string = await new ethers.Contract(DEPLOYMENT.routers.v2, ROUTER_ABI, readProvider).factory()
  const pair: string = await new ethers.Contract(factoryAddr, V2_FACTORY_ABI, readProvider).getPair(tokenIn, tokenOut)
  if (pair === ZERO) return null
  const c = new ethers.Contract(pair, V2_PAIR_ABI, readProvider)
  const [reserves, token0]: [any, string] = await Promise.all([c.getReserves(), c.token0()])
  const zeroForOne = tokenIn.toLowerCase() === token0.toLowerCase()
  const reserveIn: ethers.BigNumber = zeroForOne ? reserves.reserve0 : reserves.reserve1
  const reserveOut: ethers.BigNumber = zeroForOne ? reserves.reserve1 : reserves.reserve0
  if (reserveIn.isZero() || reserveOut.isZero()) return null
  const inWithFee = amountIn.mul(997) // Uniswap V2 0.30% pool fee
  const out = inWithFee.mul(reserveOut).div(reserveIn.mul(1000).add(inWithFee))
  return out.gt(0) ? afterProtocolFee(out) : null
}

/** Estimate the output-token amount for a from→to swap of `amountIn` (base units).
 *  Tries V4 first for non-native pairs (matching what resolveRoute would route), then the
 *  V3 quoter/pool math, then V2. null when it can't be priced. */
export async function quoteAmountOut(
  from: AssetMeta,
  to: AssetMeta,
  amountIn: ethers.BigNumber,
): Promise<ethers.BigNumber | null> {
  if (amountIn.lte(0)) return null
  const tokenIn = effectiveToken(from)
  const tokenOut = effectiveToken(to)
  // V4 is quoted through the same pool resolveRoute would pick, so the estimate the user
  // sees matches the route that submits. Only fires for non-native pairs with a V4 pool.
  try {
    const v4 = await quoteV4(from, to, amountIn)
    if (v4) return v4
  } catch {
    /* fall through to V3/V2 */
  }
  if (DEPLOYMENT.routers.v3 !== ZERO) {
    try {
      const v3 = await quoteV3(tokenIn, tokenOut, amountIn)
      if (v3) return v3
    } catch {
      /* fall through to V2 */
    }
  }
  if (DEPLOYMENT.routers.v2 !== ZERO) {
    try {
      return await quoteV2(tokenIn, tokenOut, amountIn)
    } catch {
      return null
    }
  }
  return null
}
