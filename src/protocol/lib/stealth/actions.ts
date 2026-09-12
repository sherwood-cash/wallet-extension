// Shielding a stealth address's balance into the vault — the one thing the extension's
// Receive tab does with a stealth wallet.
//
//   depositWalletToVault  shield a stealth address's ETH into the vault (self-submitted)
//   sponsoredTokenDeposit shield a stealth address's USDG when it holds NO GAS (relayed)
//
// The two are the same intent down two different roads, decided by one fact: whether the
// address holds native coin. An address paid only in USDG cannot submit anything, so it signs
// an EIP-3009 authorisation and a relayer submits for it. The obvious alternative — send it a
// little ETH — is the one thing that must never happen, because that transaction publicly
// links the funder to the stealth address and destroys the property the address exists for.
//
// KEY INVARIANT: the shielded output note is minted to `vaultKeys.keypair` — the MAIN wallet.
// The stealth key only SIGNS. That is why NO consolidation is needed: the money lands in the
// main wallet's vault directly, never routed through a sweep to the main address first.
import { BigNumber, ethers } from 'ethers'
import { DEPLOYMENT, isNativeAsset, type AssetMeta } from '../../config'
import { readProvider } from '../rpc'
import { Utxo } from '../privacy/utxo'
import { prepareTransaction } from '../privacy/transaction'
import { scanNotes, emptyTree, treeForEpoch } from '../privacy/tree'
import type { Keys } from '../actions'
import { deposit as vaultDeposit } from '../actions'
import { SCHEME_ID, type StealthKeys } from './crypto'
import { privateKeyFor, type StealthWallet } from './scan'
import { relayStealthDeposit, fetchRelayInfo } from './api'

export type Progress = (message: string) => void

const ERC3009_ABI = [
  'function name() view returns (string)',
]

/** The slice of ERC-6538 the extension needs: publish a meta-address, optionally with a name. */
export const REGISTRY_ABI = [
  'function registerKeys(uint256 schemeId, bytes stealthMetaAddress)',
  'function registerKeysWithUsername(uint256 schemeId, bytes stealthMetaAddress, string username)',
  'function registerUsername(string username)',
]

export interface StealthContracts {
  announcer: string
  registry: string
  forwarder: string | null
}

/**
 * Publish the meta-address on the ERC-6538 registry, claiming a name in the same transaction
 * when one is given.
 *
 * One transaction rather than two on the first run: a user who registers keys and then fails
 * to confirm a second prompt ends up discoverable by address but not by name, the confusing
 * half-state the combined entrypoint exists to avoid. The signer is the same local wallet key
 * that unlocks the extension, so this is submitted directly with no external prompt.
 */
export async function registerStealthKeys(
  signer: ethers.Signer,
  contracts: StealthContracts,
  keys: StealthKeys,
  username: string | null,
  onProgress: Progress = () => {},
): Promise<string> {
  const registry = new ethers.Contract(contracts.registry, REGISTRY_ABI, signer)
  onProgress(username ? `Claiming @${username}…` : 'Publishing your stealth keys…')
  const tx = username
    ? await registry.registerKeysWithUsername(SCHEME_ID, keys.metaAddress, username)
    : await registry.registerKeys(SCHEME_ID, keys.metaAddress)
  await tx.wait()
  return tx.hash
}

/**
 * What a stealth address must keep back to pay for its own deposit.
 *
 * Priced on maxFeePerGas, NOT on getGasPrice(): the node checks affordability as
 * `value + gasLimit * maxFeePerGas <= balance`, so a reserve priced off the lower gasPrice
 * strands a deposit at eth_estimateGas. DELIBERATELY GENEROUS — over-reserving leaves a
 * little dust behind; under-reserving fails at the very END, after the proof is built.
 */
export async function nativeGasReserve(): Promise<BigNumber> {
  const fee = await readProvider.getFeeData().catch(() => null)
  const gasPrice = await readProvider.getGasPrice().catch(() => BigNumber.from(0))
  const price = fee?.maxFeePerGas ?? gasPrice
  if (price.isZero()) return NATIVE_SHIELD_RESERVE
  const reserve = price.mul(DEPOSIT_GAS_BUDGET)
  return reserve.gt(NATIVE_SHIELD_RESERVE) ? reserve : NATIVE_SHIELD_RESERVE
}

/**
 * Gas a vault deposit is budgeted at. MEASURED against a real deposit proof (~1.3M gas: the
 * Groth16 verification plus 26 levels of on-chain Poseidon per leaf), budgeted 23% over.
 */
const DEPOSIT_GAS_BUDGET = 1_600_000

/**
 * Shield a stealth address's ETH into the vault, submitted by the stealth address itself.
 *
 * Reuses the app's ordinary `deposit` unchanged — the stealth address is just another signer,
 * and the output note is minted to `vaultKeys.keypair` (the MAIN wallet) inside it — so the
 * proof, note encryption and epoch handling can never drift from the main deposit flow.
 *
 * `amount` defaults to the whole balance minus a gas reserve; a deposit for the full balance
 * would leave nothing to pay for itself.
 */
export async function depositWalletToVault(
  stealthKeys: StealthKeys,
  vaultKeys: Keys,
  wallet: StealthWallet,
  asset: AssetMeta,
  opts: { amount?: BigNumber; reserve?: BigNumber; onProgress?: Progress } = {},
): Promise<string> {
  const onProgress = opts.onProgress ?? (() => {})
  const signer = new ethers.Wallet(privateKeyFor(stealthKeys, wallet), readProvider)

  let amount = opts.amount
  if (!amount) {
    if (!isNativeAsset(asset)) {
      amount = wallet.tokens[asset.token.toLowerCase()] ?? BigNumber.from(0)
    } else {
      const reserve = opts.reserve ?? (await nativeGasReserve())
      amount = wallet.native.gt(reserve) ? wallet.native.sub(reserve) : BigNumber.from(0)
    }
  }
  if (amount.lte(0)) throw new Error('Nothing left to deposit after the gas reserve')

  // Minted to the MAIN wallet's note keys — this is the whole reason there is no consolidation.
  return vaultDeposit(signer, asset, vaultKeys, amount, onProgress)
}

/**
 * Shield a stealth address's TOKENS into the vault when it holds NO GAS.
 *
 * The case the user named: an address paid only in USDG. The stealth key signs an EIP-3009
 * `ReceiveWithAuthorization` naming the forwarder as recipient; the relayer submits it; the
 * forwarder pulls the tokens, deposits them (to the MAIN wallet's note keys), and is repaid
 * out of the deposit through the vault's own `ExtData.fee`. The stealth address never needs a
 * wei — and again the note is minted to `vaultKeys.keypair`, so no consolidation step exists.
 */
export async function sponsoredTokenDeposit(
  stealthKeys: StealthKeys,
  vaultKeys: Keys,
  contracts: StealthContracts,
  wallet: StealthWallet,
  asset: AssetMeta,
  opts: { amount?: BigNumber; onProgress?: Progress } = {},
): Promise<string> {
  const onProgress = opts.onProgress ?? (() => {})
  if (!contracts.forwarder) throw new Error('Gas-less deposits are not configured on this deployment')
  if (isNativeAsset(asset)) throw new Error('The sponsored path is for ERC-20s; ETH pays its own gas')

  const value = opts.amount ?? wallet.tokens[asset.token.toLowerCase()] ?? BigNumber.from(0)
  if (value.lte(0)) throw new Error(`No ${asset.symbol} in this address`)

  onProgress('Checking the relayer…')
  const info = await fetchRelayInfo()
  if (!info?.enabled) throw new Error('No relayer is available to sponsor this deposit')

  const fee = BigNumber.from(info.minFee[asset.assetId.toString()] ?? '0')
  if (fee.lte(0)) throw new Error(`${asset.symbol} deposits are not sponsored right now`)
  if (fee.gte(value)) {
    throw new Error(`The relayer fee (${fee.toString()}) is more than this address holds`)
  }

  // ---- the proof ------------------------------------------------------------
  // extAmount = fee + outputs = value, which is exactly what the forwarder will pull.
  onProgress('Building the deposit proof…')
  const live = await scanNotes(asset.assetId, vaultKeys.keypair, vaultKeys.encryptionKey)
  const liveTree = treeForEpoch(live, live.liveEpoch)
  const out = new Utxo({ amount: value.sub(fee), keypair: vaultKeys.keypair, assetId: asset.assetId })

  const { args, extData } = await prepareTransaction({
    tree: liveTree.elements.length ? liveTree : emptyTree(),
    inputs: [],
    outputs: [out],
    fee,
    feeRecipient: info.relayer,
    recipient: 0,
    encryptionKey: vaultKeys.encryptionKey,
    assetId: asset.assetId,
  })

  if (!BigNumber.from(extData.extAmount).eq(value)) {
    throw new Error('Proof and authorisation disagree about the amount')
  }

  // ---- the authorisation ----------------------------------------------------
  onProgress('Signing the transfer authorisation…')
  const signer = new ethers.Wallet(privateKeyFor(stealthKeys, wallet))
  const token = new ethers.Contract(asset.token, ERC3009_ABI, readProvider)

  const name: string = await token.name()
  const validAfter = 0
  const validBefore = Math.floor(Date.now() / 1000) + 3600
  const nonce = ethers.utils.hexlify(ethers.utils.randomBytes(32))

  const signature = await signer._signTypedData(
    { name, version: '1', chainId: DEPLOYMENT.chainId, verifyingContract: asset.token },
    {
      ReceiveWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    {
      from: wallet.address,
      to: contracts.forwarder,
      value,
      validAfter,
      validBefore,
      nonce,
    },
  )
  const { v, r, s } = ethers.utils.splitSignature(signature)

  onProgress('Sending it to the relayer…')
  const { txHash } = await relayStealthDeposit({
    assetId: asset.assetId.toString(),
    from: wallet.address,
    value: value.toString(),
    mode: 'authorization',
    inEpoch: live.liveEpoch,
    auth: { validAfter, validBefore, nonce, v, r, s },
    proof: args,
    extData,
  })
  return txHash
}

/**
 * The floor under the live reserve, for when fee data cannot be read. A deposit costs ~1.3M
 * gas, so this is far more than a plain send. The UI applies the SAME number when deciding
 * whether to offer the button, or it would offer a shield the deposit then refuses.
 */
export const NATIVE_SHIELD_RESERVE = BigNumber.from(10).pow(15).mul(3) // 0.003 ETH

/**
 * Which of the two shield roads applies to this wallet and asset — or neither.
 *
 * `'none'` is not only "empty". It is also "holds less than it would cost to move", which is
 * why this takes `fees`: offering a shield on a balance that cannot cover its own fee produces
 * either a self-submitted deposit that runs out of gas at the very end, or a sponsored one
 * where the relayer pays gas for a transaction that cannot repay it.
 */
export function depositMode(
  wallet: StealthWallet,
  asset: AssetMeta,
  fees: { native?: BigNumber; token?: Record<string, string> } = {},
): 'self' | 'sponsored' | 'none' {
  if (isNativeAsset(asset)) {
    const reserve = fees.native ?? NATIVE_SHIELD_RESERVE
    return wallet.native.gt(reserve) ? 'self' : 'none'
  }

  const balance = wallet.tokens[asset.token.toLowerCase()]
  if (!balance || balance.isZero()) return 'none'

  if (wallet.native.gt(fees.native ?? NATIVE_SHIELD_RESERVE)) return 'self'

  const raw = fees.token?.[asset.assetId.toString()]
  if (raw) {
    try {
      if (balance.lte(BigNumber.from(raw))) return 'none'
    } catch {
      // An unparseable fee is treated as unknown: offer the button, let the relayer refuse.
    }
  }
  return 'sponsored'
}
