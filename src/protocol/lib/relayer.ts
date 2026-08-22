// Client for the Robinhood mixer relayer. Withdrawals go through the relayer so
// the gas payer + timing don't deanonymise the exit: the frontend builds the
// Groth16 proof + extData locally and POSTs them here; the relayer pays gas and
// reimburses itself in the withdrawn asset via extData.fee / extData.feeRecipient.
//
// The relayer may be mounted on the same backend as the indexer. VITE_RELAYER_URL
// overrides; otherwise it falls back to deployment.relayerUrl, then indexerUrl.
//
// HTTP contract (backend must match). All amounts are namespaced by assetId (the
// decimal uint256 string; native ETH = "1"):
//   GET  /relay/info
//     -> { relayer: "0x..",                       // used as extData.feeRecipient
//          fees: { "<assetId>": "<feeInAssetBaseUnits>" } }
//   POST /relay/deposit  { assetId, proof, extData, permit } -> { txHash }
//     Gasless ERC-20 deposit for a user who holds the token but no native gas. The
//     relayer submits transact() after pulling `permit.value` via EIP-2612, paying gas.
//   POST /relay/withdraw { assetId, proof, extData } -> { txHash }
//     Relayed withdrawal to any address; the relayer submits vault.transact(assetId,...).
// All proof/extData numeric fields are the hex/decimal strings produced by
// prepareTransaction.
import { BigNumber } from 'ethers'
import { DEPLOYMENT } from '../config'
import type { ProofArgs, ExtData } from './privacy/transaction'

function base(): string | null {
  const env = (import.meta as any).env?.VITE_RELAYER_URL as string | undefined
  const url = (env || DEPLOYMENT.relayerUrl || DEPLOYMENT.indexerUrl || '').trim()
  return url ? url.replace(/\/+$/, '') : null
}

export function relayerEnabled(): boolean {
  return base() !== null
}

async function postJson(path: string, body: unknown): Promise<any> {
  const b = base()
  if (!b) throw new Error('Relayer not configured')
  const res = await fetch(`${b}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`
    try {
      const j = await res.json()
      // Prefer the human `reason` the backend attaches (e.g. why a simulation reverted);
      // fall back to the machine `error` code, then `message`.
      if (j?.reason || j?.error || j?.message) detail = j.reason || j.error || j.message
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`Relayer ${path}: ${detail}`)
  }
  return res.json()
}

// --- /relay/info (cached for the session) ---
export interface RelayerInfo {
  relayer: string
  // fees keyed by assetId (decimal string), in that asset's base units.
  fees: Record<string, string>
}

let infoCache: { at: number; info: RelayerInfo } | null = null

// The fees are priced off LIVE gas, so this cannot be cached for the session: the number
// gets baked into a proof and the relayer re-checks it at submit time against a fresh
// quote. A stale fee is a rejected payload. The TTL is short enough that every user action
// effectively re-quotes, while still collapsing the back-to-back calls a single flow makes
// — and it applies to every call site, including ones added later, which sprinkling
// `force` at each of them would not.
const INFO_TTL_MS = 15_000

export async function relayInfo(force = false): Promise<RelayerInfo> {
  if (!force && infoCache && Date.now() - infoCache.at < INFO_TTL_MS) return infoCache.info
  const b = base()
  if (!b) throw new Error('Relayer not configured')
  const res = await fetch(`${b}/relay/info`, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`Relayer /relay/info: ${res.status} ${res.statusText}`)
  const data = (await res.json()) as RelayerInfo
  const info: RelayerInfo = { relayer: data.relayer, fees: data.fees || {} }
  infoCache = { at: Date.now(), info }
  return info
}

// The relayer fee for a given asset, in that asset's base units. The relayer takes
// no fee of its own — the vault already charges a protocol fee inside transact/
// executeSwap — so an unpublished asset defaults to 0 (relayer eats gas). The
// backend's checkFee accepts a zero fee when MIN_FEE is 0.
export function feeForAsset(info: RelayerInfo, assetId: BigNumber): BigNumber {
  const raw = info.fees[assetId.toString()]
  return raw == null ? BigNumber.from(0) : BigNumber.from(raw)
}

// --- writes ---
// Off-chain signatures that let the relayer pull tokens + bind the user to a note.
export interface DepositAuth {
  owner: string
  value: string // token base units
  deadline: string // unix seconds
  permitV: number
  permitR: string
  permitS: string
  authV: number
  authR: string
  authS: string
}

export function relayDeposit(payload: {
  assetId: string
  // The epoch of the tree the proof's root came from. A deposit spends nothing, but the
  // vault still checks the root against treeIdOf(assetId, inEpoch), so this cannot be
  // left to the server's 0 default once an asset has rotated.
  inEpoch: number
  proof: ProofArgs
  extData: ExtData
  permit: DepositAuth
}): Promise<{ txHash: string }> {
  return postJson('/relay/deposit', payload)
}

// `inEpoch` is the epoch of the tree the SPENT notes live in. Output notes always land
// in the asset's live epoch, so a spend may cross an epoch boundary. Defaults to 0
// server-side, which is correct until the first rotation.
export function relayWithdraw(payload: {
  assetId: string
  inEpoch: number
  proof: ProofArgs
  extData: ExtData
}): Promise<{ txHash: string }> {
  return postJson('/relay/withdraw', payload)
}

// Swap params tuple, JSON-safe (all numeric fields as decimal/hex strings): the
// relayer POSTs it straight into vault.executeSwap, so BigNumbers must already be
// serialised — a raw BigNumber becomes {type,hex} under JSON and won't parse.
export interface RelaySwapParams {
  assetIn: string
  tokenOut: string
  version: number
  routeData: string
  minOut: string
  deadline: number | string
  outPubkey: string
  outBlinding: string
  // Relayer fee taken from the swap proceeds, in tokenOut. Required when tokenIn is not
  // a quote, where the vault forbids charging the input; must be '0' otherwise.
  relayerFeeOut: string
  encryptedOutput: string
}

// Swaps go through the relayer for the same reason as withdrawals: if the user
// submitted executeSwap themselves, their address would be msg.sender and the
// swap would be trivially deanonymised. The relayer pays gas and reimburses
// itself in the input asset via extData.fee / extData.feeRecipient.
export function relaySwap(payload: {
  inEpoch: number
  proof: ProofArgs
  extData: ExtData
  params: RelaySwapParams
}): Promise<{ txHash: string; amountOut?: string; outCommitment?: string }> {
  return postJson('/relay/swap', payload)
}
