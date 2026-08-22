// Browser port of src/utxo.js — adapted for the multi-asset PrivacyVault.
//
// commitment = Poseidon4(amount, pubkey, blinding, assetId)
//
// The circuit's private `mintAddress` input IS the assetId here: assetId =
// uint256(uint160(token)), native ETH = 1 (NATIVE_ASSET_ID). Because each asset
// lives in its own Merkle tree, the on-chain output-note convention (the vault
// mints C_out = Poseidon4(Y, P, r, assetId(tokenOut)) after a swap) uses exactly
// the same field order, so notes minted by a swap are spendable by this wallet.
import { BigNumber } from 'ethers'
import { randomBN, poseidonHash } from './utils'
import { Keypair } from './keypair'
import { encrypt, decrypt } from './encryption'
import { NATIVE_ASSET_ID } from '../../config'

export class Utxo {
  amount: BigNumber
  blinding: BigNumber
  keypair: Keypair
  // LOCAL leaf index inside its (assetId, epoch) tree — never the global index the
  // vault emits. The circuit does Num2Bits(MERKLE_TREE_HEIGHT) on pathIndices, so a
  // global index is literally unprovable, and the nullifier is derived from this too.
  index: number | null
  // The 4th commitment field: assetId = uint256(uint160(token)) (ETH = 1).
  assetId: BigNumber
  // Which epoch's tree this note lives in. Notes never move: a spend proves membership
  // in this epoch's tree, and the resulting outputs land in the asset's LIVE epoch.
  epoch: number

  constructor({
    amount = 0,
    blinding = randomBN(),
    keypair = new Keypair(),
    index = null,
    assetId = NATIVE_ASSET_ID,
    epoch = 0,
  }: {
    amount?: any
    blinding?: any
    keypair?: Keypair
    index?: number | null
    assetId?: any
    epoch?: number
  } = {}) {
    this.amount = BigNumber.from(amount)
    this.blinding = BigNumber.from(blinding)
    this.keypair = keypair
    this.index = index
    this.assetId = BigNumber.from(assetId)
    this.epoch = epoch
  }

  getCommitment(): BigNumber {
    return poseidonHash([this.amount, this.keypair.pubkey, this.blinding, this.assetId])
  }

  getNullifier(): BigNumber {
    if (this.amount.gt(0)) {
      if (this.index == null) throw new Error('Can not compute nullifier without utxo index')
      if (this.keypair.privkey == null) throw new Error('Can not compute nullifier without private key')
    }
    const commitment = this.getCommitment()
    const idx = this.index || 0
    const signature = this.keypair.sign(commitment, idx)
    return poseidonHash([commitment, idx, signature])
  }

  encrypt(encryptionKey: Uint8Array): Promise<string> {
    const utxoString = `${this.amount.toString()}|${this.blinding.toString()}|${this.index || 0}|${this.assetId.toString()}`
    return encrypt(utxoString, encryptionKey)
  }

  /** @param index LOCAL leaf index in the note's (assetId, epoch) tree. */
  static async decrypt(
    encryptionKey: Uint8Array,
    data: string,
    index: number,
    keypair: Keypair,
    epoch = 0,
  ): Promise<Utxo> {
    const decrypted = await decrypt(data, encryptionKey)
    const parts = decrypted.split('|')
    if (parts.length !== 4) throw new Error('Invalid UTXO format after decryption')
    const [amount, blinding, , assetId] = parts
    return new Utxo({
      amount: BigNumber.from(amount),
      blinding: BigNumber.from(blinding),
      keypair,
      index,
      assetId: BigNumber.from(assetId),
      epoch,
    })
  }
}
