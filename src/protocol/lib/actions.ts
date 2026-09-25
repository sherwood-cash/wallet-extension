// High-level flows for the Robinhood mixer + private DEX:
//   - shielded deposit (ETH or ERC-20) into the single PrivacyVault;
//   - shielded withdrawal to any address (via the relayer);
//   - private swap: spend an input-asset note, route amountIn through a
//     vault-allowlisted Uniswap router, and mint the measured output note.
// Each builds a Groth16 proof in the browser and submits it; no secret leaves the
// device.
import { ethers, BigNumber } from 'ethers'
import { tr } from './i18n'
import { Utxo } from './privacy/utxo'
import { Keypair, deriveTemporaryKeypair } from './privacy/keypair'
import { prepareTransaction } from './privacy/transaction'
import { scanNotes, selectNotes, emptyTree, treeForEpoch, type OwnedNotes } from './privacy/tree'
import { fetchNullifiersFromIndexer, invalidateNullifiers } from './privacy/indexer'
import { rememberTradedAsset, rememberTradedAssets } from './privacy/syncCache'
import { VAULT_ABI, ERC20_ABI, SWAP_PARAMS_TUPLE } from './contracts/abis'
import { DEPLOYMENT, ZERO, isNativeAsset, isQuoteAsset, type AssetMeta } from '../config'
import { relayInfo, feeForAsset, relayDeposit, relayWithdraw, relaySwap, type RelaySwapParams } from './relayer'
// Reads (log scans, balances) go through a dedicated RPC, not the wallet's
// (which is rate-limited). Writes still use the signer / wallet.
import { readProvider } from './rpc'
import { toFixedHex } from './privacy/utils'
import { loadSwapNotes, saveSwapNote, markSwapNoteSpent, type StoredSwapNote } from './swapNotes'
import type { ProofArgs, ExtData } from './privacy/transaction'
import type { SwapRoute } from './swap'

export interface Keys {
  encryptionKey: Uint8Array
  keypair: Keypair
}

// Stable per-account tag for local scan hints. The UTXO pubkey, not the wallet address:
// it identifies the account for caching without writing an on-chain identity to
// localStorage. Derived from the sign-in signature, so it is the same on every device.
function accountTag(keys: Keys): string {
  return keys.keypair.pubkey.toString()
}

export type ProgressFn = (msg: string) => void

// The token address the vault uses for an asset: address(0) for native ETH.
function assetTokenAddr(asset: AssetMeta): string {
  return isNativeAsset(asset) ? ZERO : asset.token
}

// Plain wallet balances (non-shielded): the asset's token + native gas coin. For
// the native asset the "token" balance IS the native balance.
export async function getWalletBalances(
  provider: ethers.providers.Provider,
  address: string,
  asset: AssetMeta,
): Promise<{ token: BigNumber; native: BigNumber }> {
  const native = await provider.getBalance(address)
  if (isNativeAsset(asset)) return { token: native, native }
  const token = new ethers.Contract(asset.token, ERC20_ABI, provider)
  const bal = (await token.balanceOf(address)) as BigNumber
  return { token: bal, native }
}

// TVL held by the vault for an asset. Native ETH = the vault's ETH balance;
// otherwise the vault's balance of that ERC-20. (Approximate: the vault pools all
// assets, so an ERC-20 balance is that asset's shielded TVL.)
export async function getAssetTvl(
  provider: ethers.providers.Provider,
  asset: AssetMeta,
): Promise<BigNumber> {
  if (isNativeAsset(asset)) return provider.getBalance(DEPLOYMENT.vault)
  const token = new ethers.Contract(asset.token, ERC20_ABI, provider)
  return token.balanceOf(DEPLOYMENT.vault) as Promise<BigNumber>
}

// ---- batched balances (Multicall3) ----------------------------------------
// /assets loads TVL + wallet balance for every asset; per-asset that's 2N+ eth_calls.
// Multicall3 (the canonical 0xcA11…, deployed on this chain) batches them into ONE.
// Native balances go through Multicall3.getEthBalance so the ETH and ERC-20 legs share
// the same aggregate call.
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
const MULTICALL3_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  'function getEthBalance(address addr) view returns (uint256)',
]

export interface AssetBalances {
  /** plain wallet balance of the asset's token (the native balance for ETH) */
  token: BigNumber
  /** the wallet's native gas balance (asset-independent) */
  native: BigNumber
  /** vault-held TVL for the asset */
  tvl: BigNumber
}

/** TVL (+ the wallet's token/native balances when `address` is set) for every asset in
 *  a single Multicall3 eth_call. Failures per call degrade to 0 rather than throwing. */
export async function fetchAssetBalances(
  provider: ethers.providers.Provider,
  address: string | null,
  assets: AssetMeta[],
): Promise<Map<string, AssetBalances>> {
  const mc = new ethers.utils.Interface(MULTICALL3_ABI)
  const erc = new ethers.utils.Interface(ERC20_ABI)
  const vault = DEPLOYMENT.vault

  type Call = { target: string; allowFailure: boolean; callData: string }
  const calls: Call[] = []
  const ethBal = (addr: string): Call => ({
    target: MULTICALL3,
    allowFailure: true,
    callData: mc.encodeFunctionData('getEthBalance', [addr]),
  })
  const erc20Bal = (token: string, addr: string): Call => ({
    target: token,
    allowFailure: true,
    callData: erc.encodeFunctionData('balanceOf', [addr]),
  })

  // The user's native gas balance is asset-independent — fetch it once and reuse.
  let nativeIdx = -1
  if (address) {
    nativeIdx = calls.length
    calls.push(ethBal(address))
  }

  const plan = assets.map((a) => {
    const isNative = isNativeAsset(a)
    const tvlIdx = calls.length
    calls.push(isNative ? ethBal(vault) : erc20Bal(a.token, vault))
    let walletIdx = -1
    if (address) {
      if (isNative) walletIdx = nativeIdx // the native leg's wallet balance IS the gas balance
      else {
        walletIdx = calls.length
        calls.push(erc20Bal(a.token, address))
      }
    }
    return { key: a.key, tvlIdx, walletIdx }
  })

  const contract = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, provider)
  const results: { success: boolean; returnData: string }[] = await contract.callStatic.aggregate3(calls)

  const readUint = (i: number): BigNumber => {
    const r = i >= 0 ? results[i] : undefined
    if (!r || !r.success || r.returnData === '0x') return BigNumber.from(0)
    try {
      return BigNumber.from(ethers.utils.defaultAbiCoder.decode(['uint256'], r.returnData)[0])
    } catch {
      return BigNumber.from(0)
    }
  }

  const native = readUint(nativeIdx)
  const out = new Map<string, AssetBalances>()
  for (const p of plan) {
    out.set(p.key, {
      tvl: readUint(p.tvlIdx),
      token: p.walletIdx >= 0 ? readUint(p.walletIdx) : BigNumber.from(0),
      native,
    })
  }
  return out
}

/**
 * A shielded balance and the shape of the notes behind it.
 *
 * `balance` is what the user owns; `spendable` is what one transaction can actually move.
 * They differ, and the gap is not a rounding detail: the circuit takes exactly 2 inputs
 * and has a single public root, so a spend can only ever reach the 2 largest notes of ONE
 * tree. A wallet holding 0.1 + 0.1 + 0.1 has a balance of 0.3 and a ceiling of 0.2.
 *
 * The UI needs both, because showing only the balance offers amounts that cannot be proven
 * and dead-ends the user on "split across more than 2 notes" with no way forward.
 */
export interface NoteSummary {
  /** total of every unspent note — what the balance displays */
  balance: BigNumber
  /** how many unspent notes back that balance */
  count: number
  /** ceiling for a SINGLE transaction: the 2 largest notes of one tree */
  spendable: BigNumber
}

/** Roll a note set up into the two numbers the UI needs. Exported for its test. */
export function summarize(notes: Utxo[]): NoteSummary {
  const total = (ns: Utxo[]) => ns.reduce((s, n) => s.add(n.amount), BigNumber.from(0))
  // Bucket by epoch: only notes sharing a tree can be spent together, so the ceiling is
  // the best single tree, not the best 2 notes globally.
  const byEpoch = new Map<number, Utxo[]>()
  for (const n of notes) {
    const bucket = byEpoch.get(n.epoch)
    if (bucket) bucket.push(n)
    else byEpoch.set(n.epoch, [n])
  }
  let spendable = BigNumber.from(0)
  for (const bucket of byEpoch.values()) {
    const top2 = total([...bucket].sort(byAmountDesc).slice(0, 2))
    if (top2.gt(spendable)) spendable = top2
  }
  return { balance: total(notes), count: notes.length, spendable }
}

/** Largest-first, the order every 2-input selection wants. */
const byAmountDesc = (a: Utxo, b: Utxo) => (b.amount.gt(a.amount) ? 1 : -1)

// Shielded balance for one asset: every unspent note this wallet owns in that asset's
// trees. Delegates to allNotes so the displayed balance and the spendable set cannot
// disagree — they did, and it double-counted every swap note (see the dedup there).
export async function getShieldedBalance(
  provider: ethers.providers.Provider,
  asset: AssetMeta,
  keys: Keys,
  deployBlock: number,
): Promise<NoteSummary> {
  const { notes } = await allNotes(provider, asset, keys, deployBlock)
  return summarize(notes)
}

/** currentEpoch(assetId) for every asset in ONE Multicall3 eth_call, instead of one
 *  eth_call per asset on every /assets scan. A missing/failed read is left absent so the
 *  caller passes `null` and the scan falls back to the leaves' highest epoch — exactly the
 *  degradation the per-asset fetchLiveEpoch already had on an RPC error. */
async function fetchLiveEpochs(
  provider: ethers.providers.Provider,
  assetIds: BigNumber[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!assetIds.length) return out
  try {
    const vaultIface = new ethers.utils.Interface(VAULT_ABI)
    const mc = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, provider)
    const calls = assetIds.map((id) => ({
      target: DEPLOYMENT.vault,
      allowFailure: true,
      callData: vaultIface.encodeFunctionData('currentEpoch', [id]),
    }))
    const results: { success: boolean; returnData: string }[] = await mc.callStatic.aggregate3(calls)
    results.forEach((r, i) => {
      if (!r.success || r.returnData === '0x') return
      try {
        out.set(assetIds[i].toString(), Number(ethers.utils.defaultAbiCoder.decode(['uint32'], r.returnData)[0]))
      } catch {
        /* undecodable — leave absent, scan falls back to leaves */
      }
    })
  } catch {
    // Multicall unavailable — leave the map empty; each scan falls back to its own read.
  }
  return out
}

/** Shielded balances for MANY assets, sharing the two batch-wide reads that the per-asset
 *  path used to repeat: currentEpoch (one Multicall3 for all assets) and the global
 *  /nullifiers set (one request). Per-asset /status is coalesced onto a single GET
 *  /assets/status batch inside the indexer client; only /utxos stays truly per-asset, since
 *  a tree's leaves can't be collapsed. `onResult` fires as each asset
 *  resolves so the UI can fill balances in progressively rather than all at once. */
export async function getShieldedBalances(
  provider: ethers.providers.Provider,
  assets: AssetMeta[],
  keys: Keys,
  deployBlock: number,
  onResult?: (key: string, summary: NoteSummary) => void,
): Promise<Map<string, NoteSummary>> {
  const out = new Map<string, NoteSummary>()
  if (!assets.length) return out

  const [epochs, spentSet] = await Promise.all([
    fetchLiveEpochs(provider, assets.map((a) => a.assetId)),
    // The nullifier set is GLOBAL (no assetId), so one fetch serves every asset. Fetching
    // it here — before the per-asset scans fan out — is what actually collapses the burst:
    // in-flight coalescing missed because each scan asked only AFTER its commitments
    // resolved, staggering the calls. Degrade to undefined so a failure just lets each
    // scan try again rather than sinking the whole batch.
    assets.length ? fetchNullifiersFromIndexer(assets[0].assetId).catch(() => undefined) : Promise.resolve(undefined),
  ])

  await Promise.all(
    assets.map(async (a) => {
      try {
        const { notes } = await allNotes(provider, a, keys, deployBlock, {
          liveEpoch: epochs.get(a.assetId.toString()) ?? null,
          spentSet,
        })
        const summary = summarize(notes)
        out.set(a.key, summary)
        onResult?.(a.key, summary)
      } catch (e) {
        console.error(e)
      }
    }),
  )
  return out
}

// ---------------------------------------------------------------- deposit
// Build the deposit proof: one output note worth `amount`, no inputs.
async function buildDepositProof(
  asset: AssetMeta,
  keys: Keys,
  amount: BigNumber,
  onProgress: ProgressFn,
): Promise<{ args: ProofArgs; extData: ExtData; inEpoch: number }> {
  // A deposit has no real inputs, so the root it proves against is only checked for
  // membership in the LIVE epoch's tree — that is where its output notes land.
  const live = await scanNotes(asset.assetId, keys.keypair, keys.encryptionKey)
  const liveTree = treeForEpoch(live, live.liveEpoch)
  const out = new Utxo({ amount, keypair: keys.keypair, assetId: asset.assetId })

  onProgress(tr('status.proving'))
  const built = await prepareTransaction({
    tree: liveTree.elements.length ? liveTree : emptyTree(),
    inputs: [],
    outputs: [out],
    recipient: 0,
    encryptionKey: keys.encryptionKey,
    assetId: asset.assetId,
  })
  // The epoch must travel with the proof: _verifyAndConsume checks the root against
  // treeIdOf(assetId, inEpoch) UNCONDITIONALLY, even for a deposit that spends nothing.
  // It is the live epoch because that is the tree the root above came from.
  return { ...built, inEpoch: live.liveEpoch }
}

export async function deposit(
  signer: ethers.Signer,
  asset: AssetMeta,
  keys: Keys,
  amount: BigNumber,
  onProgress: ProgressFn = () => {},
): Promise<string> {
  // Remember the asset so later scans can skip trees this account has never touched.
  rememberTradedAsset(accountTag(keys), asset.assetId.toString())
  const { args, extData, inEpoch } = await buildDepositProof(asset, keys, amount, onProgress)
  const vault = new ethers.Contract(DEPLOYMENT.vault, VAULT_ABI, signer)

  // Native asset (ETH): no ERC-20, no approval — the deposit rides as msg.value.
  if (isNativeAsset(asset)) {
    onProgress(tr('status.submittingDeposit'))
    const tx = await vault.transact(asset.assetId, inEpoch, args, extData, { value: amount })
    await tx.wait()
    return tx.hash
  }

  const token = new ethers.Contract(asset.token, ERC20_ABI, signer)
  const owner = await signer.getAddress()
  const allowance: BigNumber = await token.allowance(owner, DEPLOYMENT.vault)
  if (allowance.lt(amount)) {
    onProgress(tr('status.approving'))
    await (await token.approve(DEPLOYMENT.vault, amount)).wait()
  }

  onProgress(tr('status.submittingDeposit'))
  const tx = await vault.transact(asset.assetId, inEpoch, args, extData)
  await tx.wait()
  return tx.hash
}

// ------------------------------------------------------ gasless deposit (permit)
// For a user who holds the ERC-20 but has no native gas: they sign an EIP-2612
// permit + a deposit auth off-chain and the relayer submits transact(), paying gas.
const DEPOSIT_DEADLINE_SECS = 3600

async function signPermit(
  signer: ethers.Signer,
  token: string,
  owner: string,
  spender: string,
  value: BigNumber,
  deadline: number,
): Promise<ethers.Signature> {
  const erc = new ethers.Contract(token, ERC20_ABI, readProvider)
  const nonce = (await erc.nonces(owner)) as BigNumber
  let name: string
  let version: string
  try {
    const d = await erc.eip712Domain()
    name = d.name
    version = d.version
  } catch {
    name = await erc.name()
    version = await (erc.version() as Promise<string>).catch(() => '1')
  }
  const domain = { name, version, chainId: DEPLOYMENT.chainId, verifyingContract: token }
  const types = {
    Permit: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  }
  const raw = await (signer as any)._signTypedData(domain, types, { owner, spender, value, nonce, deadline })
  return ethers.utils.splitSignature(raw)
}

async function signDepositAuth(
  signer: ethers.Signer,
  assetId: BigNumber,
  c0: string,
  c1: string,
  extAmount: BigNumber,
  deadline: number,
): Promise<ethers.Signature> {
  const inner = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ['string', 'uint256', 'address', 'uint256', 'bytes32', 'bytes32', 'int256', 'uint256'],
      ['RobinhoodDeposit', DEPLOYMENT.chainId, DEPLOYMENT.vault, assetId, c0, c1, extAmount, deadline],
    ),
  )
  const raw = await signer.signMessage(ethers.utils.arrayify(inner))
  return ethers.utils.splitSignature(raw)
}

export async function depositGasless(
  signer: ethers.Signer,
  asset: AssetMeta,
  keys: Keys,
  amount: BigNumber,
  onProgress: ProgressFn = () => {},
): Promise<string> {
  if (isNativeAsset(asset)) throw new Error('Gasless deposit is only available for ERC-20 assets')
  const owner = await signer.getAddress()
  const { args, extData, inEpoch } = await buildDepositProof(asset, keys, amount, onProgress)
  const deadline = Math.floor(Date.now() / 1000) + DEPOSIT_DEADLINE_SECS

  onProgress(tr('status.signApproval'))
  const permit = await signPermit(signer, asset.token, owner, DEPLOYMENT.vault, amount, deadline)

  onProgress(tr('status.signDeposit'))
  const auth = await signDepositAuth(signer, asset.assetId, args.outputCommitments[0], args.outputCommitments[1], amount, deadline)

  onProgress(tr('status.depositRelayer'))
  const { txHash } = await relayDeposit({
    assetId: asset.assetId.toString(),
    inEpoch,
    proof: args,
    extData,
    permit: {
      owner,
      value: amount.toString(),
      deadline: String(deadline),
      permitV: permit.v,
      permitR: permit.r,
      permitS: permit.s,
      authV: auth.v,
      authR: auth.r,
      authS: auth.s,
    },
  })
  return txHash
}

// ---------------------------------------------------------------- epoch migration
// The vault opens a fresh Merkle tree for an asset whenever the current one fills, and
// the circuit has a SINGLE public root — so one transaction can only spend notes that
// share a tree. A user active across a rotation can therefore hold, say, 0.5 in the old
// epoch and 0.3 in the new one, and be unable to send 0.7 in one go.
//
// This is invisible to them. A migration is an ordinary `transact` with extAmount == 0:
// the old notes are nullified and their value is REISSUED in the live epoch. Nothing
// enters or leaves the vault; only the claim ticket is rewritten. The UI shows an extra
// confirmation step, never the word "epoch".
//
// It is also self-healing: because every output note lands in the live epoch, ordinary
// deposits and spends drag balances forward on their own. This path only runs when the
// user tries to spend more than one epoch holds.

export class MigrationRequired extends Error {
  constructor(public readonly epoch: number) {
    super('Notes must be consolidated before this amount can be spent')
    this.name = 'MigrationRequired'
  }
}

// Each migration merges two notes into the live epoch, so the number of epochs holding
// funds strictly decreases. The cap only guards against an unexpected non-convergence.
const MAX_MIGRATIONS = 8

/** One migration transaction: burn `sel.inputs` in their epoch, reissue in the live one. */
async function migrateNotes(
  asset: AssetMeta,
  keys: Keys,
  notes: OwnedNotes,
  sel: { epoch: number; inputs: Utxo[] },
  onProgress: ProgressFn,
): Promise<string> {
  const info = await relayInfo()
  const fee = feeForAsset(info, asset.assetId)
  const inSum = sel.inputs.reduce((s, n) => s.add(n.amount), BigNumber.from(0))
  if (inSum.lte(fee)) {
    throw new Error('These notes are too small to consolidate after the relayer fee')
  }

  // extAmount = fee + outputs - inputs = 0 -> an internal transfer, no funds move.
  const merged = new Utxo({ amount: inSum.sub(fee), keypair: keys.keypair, assetId: asset.assetId })
  const { args, extData } = await prepareTransaction({
    tree: treeForEpoch(notes, sel.epoch),
    inputs: sel.inputs,
    outputs: [merged],
    recipient: 0,
    fee,
    feeRecipient: info.relayer,
    encryptionKey: keys.encryptionKey,
    assetId: asset.assetId,
  })

  const { txHash } = await relayWithdraw({
    assetId: asset.assetId.toString(),
    inEpoch: sel.epoch,
    proof: args,
    extData,
  })
  markConsumedNotes(asset, keys, args)
  // This spend consumed nullifiers; the held spent set is now stale. Drop it so the
  // next scan re-reads /nullifiers rather than handing an already-spent note to the
  // next action (a double-spend the relay reverts, charging the note a failure).
  invalidateNullifiers()
  // Wait for inclusion: the next selection re-scans, and the indexer must have seen
  // the new note before it can be picked.
  await readProvider.waitForTransaction(txHash, 1)
  return txHash
}

/**
 * Consolidate until `amount` is spendable in a single transaction, or return if it
 * already is. Never throws for insufficient balance — that is left to the real proof
 * builder so the user sees one consistent error.
 */
async function migrateUntilSpendable(
  asset: AssetMeta,
  keys: Keys,
  amount: BigNumber,
  deployBlock: number,
  onProgress: ProgressFn,
): Promise<void> {
  // Non-quote assets never need this. A bare consolidation would have to pay the relayer
  // in the memecoin, which the vault refuses, so it could only be self-submitted — and
  // that would put the user's address on-chain next to their nullifiers. They don't have
  // to: a swap already migrates. It proves against the epoch the note lives in and writes
  // both the change note and the output note into the LIVE epoch. Notes split across
  // epochs are therefore sold one epoch at a time, relayed and private throughout.
  if (!isQuoteAsset(asset)) return

  const info = await relayInfo()
  const fee = feeForAsset(info, asset.assetId)

  for (let step = 0; step < MAX_MIGRATIONS; step++) {
    const notes = await allNotes(readProvider, asset, keys, deployBlock)
    let sel
    try {
      sel = selectNotes(notes.notes, amount.add(fee), notes.liveEpoch)
    } catch {
      return // insufficient / too fragmented — surfaced by the caller's own build
    }
    if (!sel.needsMigration) return
    onProgress(tr('status.consolidatingStep', { step: step + 1 }))
    await migrateNotes(asset, keys, notes, sel, onProgress)
  }
  throw new Error(
    'Could not consolidate your notes into a single transaction. Try a smaller amount.',
  )
}

/**
 * Merge the user's two largest notes into one, on request.
 *
 * `migrateUntilSpendable` above already does this — but only when the balance is split
 * across EPOCHS, which in practice never happens: a tree holds 2**26 leaves, so every note
 * lives in epoch 0 and `selectNotes` throws "split across more than 2 notes" instead of
 * ever asking for a migration. The machinery was reachable only by the case that does not
 * occur, while the case that does had no way out. This exposes it directly.
 *
 * ONE merge per call, because a consolidation is an ordinary spend and inherits the same
 * 2-input limit: N notes need N-2 calls to become spendable in a single transaction. The
 * two LARGEST are the right pair — merging them is what raises the 2-note ceiling fastest,
 * whereas merging the two smallest leaves that ceiling exactly where it was.
 *
 * Nothing enters or leaves the vault (`extAmount == 0`), so this is invisible on-chain
 * beyond being one more transact — and it is strictly better for privacy than the
 * alternative of exiting in several withdrawals, which lands several correlated payments
 * on the same recipient address.
 */
export async function consolidate(
  asset: AssetMeta,
  keys: Keys,
  deployBlock: number,
  onProgress: ProgressFn = () => {},
): Promise<string> {
  // Same reason migrateUntilSpendable bails on non-quotes: the relayer must be paid in the
  // note's own asset, the vault refuses a fee in a memecoin, so this could only be
  // self-submitted — which would put the user's address on-chain beside their nullifiers.
  if (!isQuoteAsset(asset)) {
    throw new Error(`${asset.symbol} notes cannot be consolidated — sell them in several passes instead`)
  }

  onProgress(tr('status.scanning'))
  const notes = await allNotes(readProvider, asset, keys, deployBlock)

  // Pick a tree holding at least 2 notes, preferring the live epoch so the merged note
  // lands where new notes already go.
  const byEpoch = new Map<number, Utxo[]>()
  for (const n of notes.notes) {
    const bucket = byEpoch.get(n.epoch)
    if (bucket) bucket.push(n)
    else byEpoch.set(n.epoch, [n])
  }
  const epoch = [...byEpoch.keys()]
    .sort((a, b) => (a === notes.liveEpoch ? -1 : b === notes.liveEpoch ? 1 : b - a))
    .find((e) => (byEpoch.get(e)?.length ?? 0) >= 2)
  if (epoch === undefined) {
    throw new Error('Nothing to consolidate — you hold fewer than 2 notes')
  }

  const inputs = [...byEpoch.get(epoch)!].sort(byAmountDesc).slice(0, 2)
  onProgress(tr('status.consolidating'))
  // migrateNotes refuses a pair worth less than the relayer fee, which is the correct
  // floor: merging them would cost more than they hold.
  const txHash = await migrateNotes(asset, keys, notes, { epoch, inputs }, onProgress)
  rememberTradedAsset(accountTag(keys), asset.assetId.toString())
  return txHash
}

// ---------------------------------------------------------------- withdraw
// Withdrawals go through the relayer (gas payer + timing would otherwise
// deanonymise the exit). The relayer reimburses itself in the withdrawn asset via
// extData.fee / extData.feeRecipient; the recipient still receives `amount` in full.
async function buildWithdrawProof(
  asset: AssetMeta,
  keys: Keys,
  amount: BigNumber,
  recipient: string,
  deployBlock: number,
  onProgress: ProgressFn,
): Promise<{ args: ProofArgs; extData: ExtData; inEpoch: number }> {
  const info = await relayInfo()
  const fee = feeForAsset(info, asset.assetId)

  onProgress(tr('status.scanning'))
  const notes = await allNotes(readProvider, asset, keys, deployBlock)
  const sel = selectNotes(notes.notes, amount.add(fee), notes.liveEpoch)
  if (sel.needsMigration) {
    // Caller must migrate first; buildWithdrawProof is only ever reached with a
    // selection that fits in one tree.
    throw new MigrationRequired(sel.epoch)
  }
  const inSum = sel.inputs.reduce((s, n) => s.add(n.amount), BigNumber.from(0))
  const change = new Utxo({ amount: inSum.sub(amount).sub(fee), keypair: keys.keypair, assetId: asset.assetId })

  onProgress(tr('status.proving'))
  const built = await prepareTransaction({
    tree: treeForEpoch(notes, sel.epoch),
    inputs: sel.inputs,
    outputs: [change],
    recipient,
    fee,
    feeRecipient: info.relayer,
    encryptionKey: keys.encryptionKey,
    assetId: asset.assetId,
  })
  return { ...built, inEpoch: sel.epoch }
}

export async function withdraw(
  asset: AssetMeta,
  keys: Keys,
  amount: BigNumber,
  recipient: string,
  deployBlock: number,
  onProgress: ProgressFn = () => {},
): Promise<string> {
  if (!ethers.utils.isAddress(recipient)) throw new Error('Enter a valid address')
  // The balance may be split across epochs. Pull it forward first — the user only ever
  // sees extra confirmation steps, never the word "epoch".
  await migrateUntilSpendable(asset, keys, amount, deployBlock, onProgress)
  const { args, extData, inEpoch } = await buildWithdrawProof(asset, keys, amount, recipient, deployBlock, onProgress)
  onProgress(tr('status.relaying'))
  const { txHash } = await relayWithdraw({ assetId: asset.assetId.toString(), inEpoch, proof: args, extData })
  markConsumedNotes(asset, keys, args)
  // The withdrawn note's nullifier is on-chain now; drop the held spent set so a follow-up
  // action re-reads it rather than reusing the note it just spent.
  invalidateNullifiers()
  rememberTradedAsset(accountTag(keys), asset.assetId.toString())
  return txHash
}

// ---------------------------------------------------------------- swap
// Spend an input-asset note into the vault (recipient = vault), route amountIn
// through a whitelisted Uniswap router, and mint the measured output note. The
// output amount Y is unknown at proof time: we supply only the output note's
// ownership fields (pubkey P = our keypair, blinding r), then recover Y from the
// Swap/NewCommitment event and store the note locally for later withdraw/re-swap.
export interface SwapArgs {
  from: AssetMeta
  to: AssetMeta
  amountIn: BigNumber
  minOut: BigNumber
  route: SwapRoute
  deadlineSecs?: number // default 20 minutes
}

// keccak256(abi.encode(SwapParams)) — must match SherwoodVault._requireSwapParams
// byte for byte. This digest goes into extData.swapParamsHash, which is folded into
// extDataHash, which the proof commits to: that chain is what stops a relayer or a
// front-runner from replaying our proof with their own outPubkey / minOut / routeData.
export function hashSwapParams(p: RelaySwapParams): string {
  const abi = new ethers.utils.AbiCoder()
  return ethers.utils.keccak256(abi.encode([SWAP_PARAMS_TUPLE], [p]))
}

export async function swap(
  signer: ethers.Signer,
  keys: Keys,
  args: SwapArgs,
  onProgress: ProgressFn = () => {},
): Promise<{ txHash: string; amountOut: BigNumber }> {
  const { from, to, amountIn, minOut, route } = args
  // Contract is used only to decode events from the receipt (parseLog is pure);
  // the swap is submitted by the RELAYER, never signed by the user's wallet.
  const vault = new ethers.Contract(DEPLOYMENT.vault, VAULT_ABI, signer)

  // The swap goes through the relayer, exactly like a withdrawal: if the user
  // submitted executeSwap themselves, their address would be msg.sender and the
  // swap would be deanonymised on-chain. The relayer pays gas and reimburses
  // itself in the INPUT asset via extData.fee / extData.feeRecipient.
  const info = await relayInfo()
  // The vault pays the relayer on whichever leg is a quote, so the fee rides on the
  // input when selling a quote and on the proceeds when selling a memecoin. Exactly one
  // of the two must be zero or executeSwap reverts.
  const sellingAQuote = isQuoteAsset(from)
  const relayFee = feeForAsset(info, sellingAQuote ? from.assetId : to.assetId)
  const fee = sellingAQuote ? relayFee : BigNumber.from(0)
  const relayerFeeOut = sellingAQuote ? BigNumber.from(0) : relayFee

  onProgress(tr('status.scanning'))
  // The input balance may be split across epochs; pull it forward before proving.
  await migrateUntilSpendable(from, keys, amountIn, DEPLOYMENT.deployBlock, onProgress)
  const notes = await allNotes(readProvider, from, keys, DEPLOYMENT.deployBlock)
  // Cover amountIn (routed through Uniswap by the vault) + the relayer fee — both
  // are debited from the spent input note; the change note keeps the remainder.
  const sel = selectNotes(notes.notes, amountIn.add(fee), notes.liveEpoch)
  if (sel.needsMigration) {
    // Only reachable for a non-quote input, where migration is deliberately skipped.
    // The balance exists but sits in more than one tree, so it sells in several passes.
    const inThisEpoch = sel.inputs.reduce((s, n) => s.add(n.amount), BigNumber.from(0))
    throw new Error(
      `This amount is spread across more than one batch of your ${from.symbol} notes. Sell up to ${ethers.utils.formatUnits(inThisEpoch, from.decimals)} ${from.symbol} now, then repeat for the rest.`,
    )
  }
  const inSum = sel.inputs.reduce((s, n) => s.add(n.amount), BigNumber.from(0))
  const change = new Utxo({ amount: inSum.sub(amountIn).sub(fee), keypair: keys.keypair, assetId: from.assetId })

  // SwapParams must be fully decided BEFORE proving: the proof commits to their hash, so
  // nothing here may depend on the proof.
  //
  // P is a ONE-TIME key, never our wallet pubkey: it travels in the clear in the calldata,
  // so reusing the wallet's would make every swap we ever do linkable to each other and
  // scannable across every asset tree. It is derived from our key + this note's blinding,
  // so the note stays ours and stays recoverable anywhere. See deriveTemporaryKeypair.
  const outBlinding = new Utxo({ assetId: to.assetId }).blinding
  const outKeypair = deriveTemporaryKeypair(keys.keypair.privkey, outBlinding)
  const outPubkey = outKeypair.pubkey
  const deadline = Math.floor(Date.now() / 1000) + (args.deadlineSecs ?? 1200)

  // Stringify BigNumber fields: this tuple is POSTed to the relayer as JSON, and a
  // raw BigNumber would serialise to {type,hex} and fail the relayer's parsing.
  const swapParams: RelaySwapParams = {
    assetIn: from.assetId.toString(),
    tokenOut: assetTokenAddr(to),
    version: route.version, // 0=V2,1=V3,2=V4
    routeData: route.routeData,
    minOut: minOut.toString(),
    deadline,
    outPubkey: toFixedHex(outPubkey),
    outBlinding: toFixedHex(outBlinding),
    relayerFeeOut: relayerFeeOut.toString(),
    // The note's own encrypted copy, so it survives on any device with the user's key.
    //
    // Y is unknown here — the vault measures it on-chain after this blob is already
    // fixed — so the amount field is a placeholder. That is fine: Y is published in the
    // clear by the Swap event anyway, and the indexer pins it to this leaf. What the blob
    // must carry is the BLINDING, which nothing on-chain reveals and which we do know,
    // having just picked it. Leaving this empty is what used to make a swap note
    // unrecoverable away from the browser that created it.
    encryptedOutput: await new Utxo({
      amount: 0,
      keypair: outKeypair,
      blinding: outBlinding,
      assetId: to.assetId,
    }).encrypt(keys.encryptionKey),
  }

  // The withdrawal-into-vault proof: recipient = vault, extAmount = -(amountIn).
  // swapParamsHash binds the swap destination to this proof — see hashSwapParams.
  onProgress(tr('status.proving'))
  const { args: proofArgs, extData } = await prepareTransaction({
    tree: treeForEpoch(notes, sel.epoch),
    inputs: sel.inputs,
    outputs: [change],
    recipient: DEPLOYMENT.vault,
    fee,
    feeRecipient: info.relayer,
    encryptionKey: keys.encryptionKey,
    assetId: from.assetId,
    swapParamsHash: hashSwapParams(swapParams),
  })

  // Both legs are now trees this account has notes in.
  rememberTradedAssets(accountTag(keys), [from.assetId.toString(), to.assetId.toString()])

  onProgress(tr('status.relayingSwap'))
  const { txHash } = await relaySwap({ inEpoch: sel.epoch, proof: proofArgs, extData, params: swapParams })
  // The relayer waits for 1 confirmation before responding; re-fetch the receipt on
  // our read RPC to recover Y (amountOut) + the output-note leaf index from events.
  const receipt = await readProvider.waitForTransaction(txHash, 1)

  // Recover Y + the output leaf index from the Swap / NewCommitment events.
  const { amountOut, index } = parseSwapReceipt(vault, receipt, to.assetId)

  // Persist the output note locally (Y, P, r, index, assetId) so it's spendable.
  saveSwapNote(keys.keypair, {
    assetId: to.assetId.toString(),
    amount: amountOut.toString(),
    blinding: outBlinding.toString(),
    index,
    spent: false,
  })
  markConsumedNotes(from, keys, proofArgs)
  // The input note's nullifier is spent on-chain; drop the held spent set so the next
  // scan sees it and never offers the same note twice.
  invalidateNullifiers()

  return { txHash, amountOut }
}

// Read amountOut (Y) + the output-note leaf index from a swap receipt.
function parseSwapReceipt(
  vault: ethers.Contract,
  receipt: ethers.providers.TransactionReceipt,
  assetOut: BigNumber,
): { amountOut: BigNumber; index: number } {
  let amountOut: BigNumber | null = null
  let commitment: string | null = null
  let index: number | null = null

  for (const log of receipt.logs) {
    let parsed: ethers.utils.LogDescription
    try {
      parsed = vault.interface.parseLog(log)
    } catch {
      continue
    }
    if (parsed.name === 'Swap' && (parsed.args.assetOut as BigNumber).eq(assetOut)) {
      amountOut = parsed.args.amountOut as BigNumber
      commitment = parsed.args.commitment as string
    }
  }
  if (amountOut === null || commitment === null) {
    throw new Error('Swap event not found in receipt — cannot recover output note')
  }
  // The output note's leaf index comes from the matching NewCommitment.
  for (const log of receipt.logs) {
    let parsed: ethers.utils.LogDescription
    try {
      parsed = vault.interface.parseLog(log)
    } catch {
      continue
    }
    if (
      parsed.name === 'NewCommitment' &&
      (parsed.args.assetId as BigNumber).eq(assetOut) &&
      (parsed.args.commitment as string).toLowerCase() === commitment.toLowerCase()
    ) {
      index = (parsed.args.index as BigNumber).toNumber()
      break
    }
  }
  if (index === null) throw new Error('NewCommitment for the swap output not found')
  return { amountOut, index }
}

// ---------------------------------------------- local swap-output note handling
// Swap-output notes carry a server-unknown amount Y, so they aren't recoverable by
// trial-decryption. We keep them in localStorage keyed by the wallet's keypair and
// merge them into the spendable set (re-verifying on-chain spent state).

// Reconstruct Utxo objects for the user's stored, still-unspent swap notes for one
// asset, dropping any whose nullifier has since been spent on-chain.
async function loadUsableSwapNotes(
  provider: ethers.providers.Provider,
  asset: AssetMeta,
  keys: Keys,
): Promise<Utxo[]> {
  const stored = loadSwapNotes(keys.keypair).filter(
    (n) => !n.spent && n.assetId === asset.assetId.toString(),
  )
  if (!stored.length) return []
  const utxos = stored.map((n) => swapNoteToUtxo(keys.keypair, n))
  const nullifiers = utxos.map((u) => toFixedHex(u.getNullifier()))

  // One Multicall3 round-trip for every stored swap note's isSpent, instead of one
  // eth_call per note — which got heavy for a wallet holding many swap notes.
  let spentFlags: boolean[]
  try {
    const vaultIface = new ethers.utils.Interface(VAULT_ABI)
    const mc = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, provider)
    const calls = nullifiers.map((nf) => ({
      target: DEPLOYMENT.vault,
      allowFailure: true,
      callData: vaultIface.encodeFunctionData('isSpent', [nf]),
    }))
    const results: { success: boolean; returnData: string }[] = await mc.callStatic.aggregate3(calls)
    spentFlags = results.map((r) =>
      // A failed read degrades to "unspent": keep the note (a truly spent one just fails
      // later at proof/submit) rather than hiding a spendable balance.
      r.success && r.returnData !== '0x'
        ? (ethers.utils.defaultAbiCoder.decode(['bool'], r.returnData)[0] as boolean)
        : false,
    )
  } catch {
    // Multicall unavailable — fall back to per-note reads.
    const vault = new ethers.Contract(DEPLOYMENT.vault, VAULT_ABI, provider)
    spentFlags = []
    for (const nf of nullifiers) spentFlags.push((await vault.isSpent(nf)) as boolean)
  }

  const out: Utxo[] = []
  stored.forEach((n, i) => {
    if (spentFlags[i]) markSwapNoteSpent(keys.keypair, n.index, n.assetId)
    else out.push(utxos[i])
  })
  return out
}

// `keypair` is the WALLET's; the note itself is owned by the one-time key derived from it
// and the note's blinding, which is what the vault hashed into the leaf.
function swapNoteToUtxo(keypair: Keypair, n: StoredSwapNote): Utxo {
  return new Utxo({
    amount: BigNumber.from(n.amount),
    blinding: BigNumber.from(n.blinding),
    keypair: deriveTemporaryKeypair(keypair.privkey, n.blinding),
    index: n.index,
    assetId: BigNumber.from(n.assetId),
  })
}

// The full spendable set for an asset = decryptable notes + local swap-output
// notes, sharing one reconstructed tree.
async function allNotes(
  provider: ethers.providers.Provider,
  asset: AssetMeta,
  keys: Keys,
  deployBlock: number,
  // Forwarded to scanNotes so a batched multi-asset scan can share one currentEpoch
  // multicall and one /nullifiers fetch across every asset (see getShieldedBalances).
  prefetch?: { liveEpoch?: number | null; spentSet?: Set<string> },
): Promise<OwnedNotes> {
  const scanned = await scanNotes(asset.assetId, keys.keypair, keys.encryptionKey, prefetch)
  const swapNotes = await loadUsableSwapNotes(provider, asset, keys)
  // Locally-stored swap-output notes carry their own epoch (set when the Swap event was
  // read); default them to the live epoch so selection can bucket them.
  for (const n of swapNotes) if (n.epoch === undefined) n.epoch = scanned.liveEpoch

  // The two sources OVERLAP, and concatenating them counted a swap note twice.
  //
  // A swap note used to be invisible to the scan: the vault emitted an empty blob for it,
  // so localStorage was its only home. Now the swap writes a real encrypted blob and the
  // indexer pins the measured amount to that leaf, so trial decryption finds it like any
  // other note — and the local copy became a duplicate rather than the only copy. That
  // doubled the displayed balance, and worse, let selection pick the same note as BOTH
  // inputs, which yields two identical nullifiers and a proof the circuit refuses.
  //
  // The scan is authoritative. The local copy is kept only for the window between a swap
  // landing and the indexer seeing its leaf, so drop it as soon as the scan has it.
  const scannedCommitments = new Set(
    scanned.notes.map((n) => toFixedHex(n.getCommitment()).toLowerCase()),
  )
  const localOnly = swapNotes.filter(
    (n) => !scannedCommitments.has(toFixedHex(n.getCommitment()).toLowerCase()),
  )

  const notes = [...scanned.notes, ...localOnly]
  return { ...scanned, notes, balance: notes.reduce((s, n) => s.add(n.amount), BigNumber.from(0)) }
}

// After a spend, mark any consumed local swap notes as spent (by nullifier) so we
// don't try to reuse them before the indexer/RPC reflects the on-chain state.
function markConsumedNotes(asset: AssetMeta, keys: Keys, proof: ProofArgs) {
  const spentNullifiers = new Set(proof.inputNullifiers.map((n) => n.toLowerCase()))
  for (const n of loadSwapNotes(keys.keypair)) {
    if (n.spent || n.assetId !== asset.assetId.toString()) continue
    const utxo = swapNoteToUtxo(keys.keypair, n)
    if (spentNullifiers.has(toFixedHex(utxo.getNullifier()).toLowerCase())) {
      markSwapNoteSpent(keys.keypair, n.index, n.assetId)
    }
  }
}
