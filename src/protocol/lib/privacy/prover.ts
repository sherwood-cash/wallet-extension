// Browser proof generation. snarkjs.groth16.fullProve fetches the circuit
// artifacts over HTTP (served from /circuits/) and runs entirely client-side —
// no secret ever leaves the browser.
import { groth16 } from 'snarkjs'
import { utils as ffutils } from 'ffjavascript'
import { toFixedHex } from './utils'

const WASM_URL = '/circuits/transaction2.wasm'
const ZKEY_URL = '/circuits/transaction2.zkey'

export interface SolidityProof {
  pA: [string, string]
  pB: [[string, string], [string, string]]
  pC: [string, string]
}

export async function prove(input: Record<string, any>): Promise<SolidityProof> {
  const { proof } = await groth16.fullProve(ffutils.stringifyBigInts(input), WASM_URL, ZKEY_URL)
  const pA: [string, string] = [toFixedHex(proof.pi_a[0]), toFixedHex(proof.pi_a[1])]
  const pB: [[string, string], [string, string]] = [
    [toFixedHex(proof.pi_b[0][1]), toFixedHex(proof.pi_b[0][0])],
    [toFixedHex(proof.pi_b[1][1]), toFixedHex(proof.pi_b[1][0])],
  ]
  const pC: [string, string] = [toFixedHex(proof.pi_c[0]), toFixedHex(proof.pi_c[1])]
  return { pA, pB, pC }
}
