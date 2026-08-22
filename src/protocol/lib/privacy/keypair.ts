// Browser port of src/keypair.js
import { ethers, BigNumber } from 'ethers'
import { poseidonHash, toFixedHex, FIELD_SIZE } from './utils'

// Domain tag for swap-output note keys. Derived from a string rather than written as a
// literal so this and the contracts repo cannot drift apart.
const SWAP_NOTE_KEY_DOMAIN = BigNumber.from(
  ethers.utils.keccak256(ethers.utils.toUtf8Bytes('sherwood.swap.notekey.v1')),
).mod(FIELD_SIZE)

const swapNoteKeySeed = (privkey: BigNumber | string) =>
  poseidonHash([BigNumber.from(privkey), SWAP_NOTE_KEY_DOMAIN])

export class Keypair {
  privkey: string
  pubkey: BigNumber

  constructor(privkey: string = ethers.Wallet.createRandom().privateKey) {
    this.privkey = privkey
    this.pubkey = poseidonHash([this.privkey])
  }

  toString() {
    return toFixedHex(this.pubkey)
  }

  address() {
    return this.toString()
  }

  sign(commitment: any, merklePath: any): BigNumber {
    return poseidonHash([this.privkey, commitment, merklePath])
  }
}

/**
 * The ONE-TIME keypair that owns a swap-output note. Must stay byte-identical to
 * deriveSwapKeypair in the contracts repo (src/keypair.js).
 *
 * `SwapParams.outPubkey` is the only place a note's P appears in the clear: the vault
 * mints C_out = Poseidon4(Y, P, r, assetOut) on-chain, from a Y nobody knows at proving
 * time, so it needs P as plaintext calldata. Putting the wallet's long-term pubkey there
 * makes P a permanent pseudonym — every swap the wallet ever makes carries the same P, and
 * since the vault's second leaf is Poseidon4(0, P, 0, assetOut), whose every input is
 * public once P is, anyone who sees P once can scan every asset tree and pick out that
 * wallet's entire swap history, retroactively. A fresh P per swap removes that link.
 *
 * The blinding is the nonce: random per swap, already inside the note's encrypted blob (so
 * any device with the wallet key recovers the note with no local state and no wire-format
 * change), known before proving (so it can go into the SwapParams the proof commits to),
 * and never public on-chain (so an observer who learns the wallet pubkey still cannot
 * recompute P). The note index cannot serve here: the vault assigns it during the tx,
 * long after swapParamsHash has frozen P.
 *
 * @param privkey the WALLET's utxo private key
 * @param blinding the output note's blinding
 */
export function deriveSwapKeypair(privkey: BigNumber | string, blinding: BigNumber | string): Keypair {
  return new Keypair(toFixedHex(poseidonHash([swapNoteKeySeed(privkey), BigNumber.from(blinding)])))
}
