// Browser port of the test's prepareTransaction/getProof. Produces the exact
// { args, extData } the on-chain pool/controller expects.
import { BigNumber } from 'ethers'
import type { MerkleTree } from 'fixed-merkle-tree'
import { Utxo } from './utxo'
import { prove } from './prover'
import { toFixedHex, getExtDataHash, FIELD_SIZE, MERKLE_TREE_HEIGHT } from './utils'
import { NATIVE_ASSET_ID } from '../../config'

export interface ProofArgs {
  pA: [string, string]
  pB: [[string, string], [string, string]]
  pC: [string, string]
  root: string
  inputNullifiers: [string, string]
  outputCommitments: [string, string]
  publicAmount: string
  extDataHash: string
}

export interface ExtData {
  recipient: string
  extAmount: string
  feeRecipient: string
  fee: string
  encryptedOutput1: string
  encryptedOutput2: string
  // keccak256(abi.encode(SwapParams)) for executeSwap, ZERO_HASH for a plain transact.
  // Being inside ExtData is what makes the swap destination part of extDataHash, and
  // therefore part of what the proof attests to — without it the submitted SwapParams
  // are unauthenticated and anyone replaying the proof can redirect the proceeds.
  swapParamsHash: string
}

/** ExtData.swapParamsHash for non-swap transactions; the vault requires zero there. */
export const ZERO_HASH = '0x' + '0'.repeat(64)

export interface TransactionResult {
  args: ProofArgs
  extData: ExtData
  outputs: Utxo[]
}

async function getProof({
  inputs,
  outputs,
  tree,
  extAmount,
  fee,
  recipient,
  feeRecipient,
  encryptionKey,
  swapParamsHash,
}: {
  inputs: Utxo[]
  outputs: Utxo[]
  tree: MerkleTree
  extAmount: BigNumber
  fee: BigNumber
  recipient: string | number
  feeRecipient: string | number
  encryptionKey: Uint8Array
  swapParamsHash: string
}): Promise<TransactionResult> {
  const inputMerklePathIndices: number[] = []
  const inputMerklePathElements: any[] = []

  for (const input of inputs) {
    if (input.amount.gt(0)) {
      input.index = tree.indexOf(toFixedHex(input.getCommitment()))
      if (input.index < 0) {
        throw new Error(`Input commitment ${toFixedHex(input.getCommitment())} was not found`)
      }
      inputMerklePathIndices.push(input.index)
      inputMerklePathElements.push(tree.path(input.index).pathElements)
    } else {
      inputMerklePathIndices.push(0)
      inputMerklePathElements.push(new Array(MERKLE_TREE_HEIGHT).fill(0))
    }
  }

  const encryptedOutput1 = await outputs[0].encrypt(encryptionKey)
  const encryptedOutput2 = await outputs[1].encrypt(encryptionKey)

  const extData: ExtData = {
    recipient: toFixedHex(recipient, 20),
    extAmount: toFixedHex(extAmount),
    feeRecipient: toFixedHex(feeRecipient, 20),
    fee: toFixedHex(fee),
    encryptedOutput1,
    encryptedOutput2,
    swapParamsHash,
  }

  const extDataHash = getExtDataHash(extData)

  const input = {
    root: toFixedHex(tree.root),
    inputNullifier: inputs.map((x) => x.getNullifier().toString()),
    outputCommitment: outputs.map((x) => x.getCommitment().toString()),
    publicAmount: BigNumber.from(extAmount).sub(fee).add(FIELD_SIZE).mod(FIELD_SIZE).toString(),
    extDataHash: extDataHash.toString(),
    // The circuit's private input is still named `mintAddress`; here it carries the
    // per-asset id (all inputs/outputs in one tx share the same asset/tree).
    mintAddress: inputs[0].assetId.toString(),
    inAmount: inputs.map((x) => x.amount.toString()),
    inPrivateKey: inputs.map((x) => x.keypair.privkey.toString()),
    inBlinding: inputs.map((x) => x.blinding.toString()),
    inPathIndices: inputMerklePathIndices,
    inPathElements: inputMerklePathElements,
    outAmount: outputs.map((x) => x.amount.toString()),
    outBlinding: outputs.map((x) => x.blinding.toString()),
    outPubkey: outputs.map((x) => x.keypair.pubkey.toString()),
  }

  const { pA, pB, pC } = await prove(input)

  const args: ProofArgs = {
    pA,
    pB,
    pC,
    root: toFixedHex(input.root),
    inputNullifiers: inputs.map((x) => toFixedHex(x.getNullifier())) as [string, string],
    outputCommitments: outputs.map((x) => toFixedHex(x.getCommitment())) as [string, string],
    publicAmount: toFixedHex(input.publicAmount),
    extDataHash: toFixedHex(extDataHash),
  }

  return { extData, args, outputs }
}

export async function prepareTransaction({
  tree,
  inputs = [],
  outputs = [],
  fee = BigNumber.from(0),
  recipient = 0,
  feeRecipient = 0,
  encryptionKey,
  assetId,
  swapParamsHash = ZERO_HASH,
}: {
  tree: MerkleTree
  inputs?: Utxo[]
  outputs?: Utxo[]
  fee?: BigNumber
  recipient?: string | number
  feeRecipient?: string | number
  encryptionKey: Uint8Array
  // Set ONLY on the executeSwap path, to keccak256(abi.encode(SwapParams)). Must be
  // computed before proving: the proof commits to it, so the swap params have to be
  // fully decided by then.
  swapParamsHash?: string
  // Asset id for the padding notes so every note in this tx shares the tree/asset.
  // Defaults to the first real input/output's assetId, else the native sentinel.
  assetId?: BigNumber
}): Promise<TransactionResult> {
  const ins = [...inputs]
  const outs = [...outputs]
  const padAsset = assetId ?? inputs[0]?.assetId ?? outputs[0]?.assetId ?? NATIVE_ASSET_ID
  while (ins.length < 2) ins.push(new Utxo({ assetId: padAsset }))
  while (outs.length < 2) outs.push(new Utxo({ assetId: padAsset }))

  const extAmount = BigNumber.from(fee)
    .add(outs.reduce((sum, x) => sum.add(x.amount), BigNumber.from(0)))
    .sub(ins.reduce((sum, x) => sum.add(x.amount), BigNumber.from(0)))

  return getProof({
    inputs: ins,
    outputs: outs,
    tree,
    extAmount,
    fee,
    recipient,
    feeRecipient,
    encryptionKey,
    swapParamsHash,
  })
}
