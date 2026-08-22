// Browser port of src/encryption.js.
//
// AES-256-GCM via WebCrypto (crypto-browserify lacks GCM). Wire format is kept
// identical to the contracts repo / indexer: [IV(12)] + [authTag(16)] + [ct],
// so notes written here remain decryptable by the SDK and vice-versa.
import { ethers } from 'ethers'
import { Keypair } from './keypair'

export const SIGN_IN_MESSAGE = 'Sherwood Cash account sign in'

export interface DerivedKeys {
  encryptionKey: Uint8Array
  utxoPrivateKey: string
  keypair: Keypair
}

export function deriveKeys(signature: string): DerivedKeys {
  const encryptionKeyHex = ethers.utils.keccak256(signature)
  const encryptionKey = hexToBytes(encryptionKeyHex)
  const utxoPrivateKey = ethers.utils.keccak256(encryptionKey)
  const keypair = new Keypair(utxoPrivateKey)
  return { encryptionKey, utxoPrivateKey, keypair }
}

// The sign-in message is a fixed string, so signMessage is deterministic per
// wallet: the same address always yields the same signature and thus the same
// keys. We cache that signature in sessionStorage (keyed by address) so a reload
// or an auto-reconnect within the session re-derives the keys WITHOUT popping the
// wallet's signature prompt every time. sessionStorage (not localStorage) is the
// deliberate line: the keys can spend notes, so they must never persist to disk —
// they die when the tab/browser closes, costing exactly one signature per session.
const SIG_CACHE_PREFIX = 'rhm:siwe-sig:'

function readCachedSignature(address: string): string | null {
  try {
    return sessionStorage.getItem(SIG_CACHE_PREFIX + address.toLowerCase())
  } catch {
    return null
  }
}

function writeCachedSignature(address: string, signature: string): void {
  try {
    sessionStorage.setItem(SIG_CACHE_PREFIX + address.toLowerCase(), signature)
  } catch {
    /* storage unavailable / full — just re-sign next time */
  }
}

export async function signIn(signer: ethers.Signer): Promise<DerivedKeys> {
  const address = await signer.getAddress()
  const cached = readCachedSignature(address)
  if (cached) return deriveKeys(cached)
  const signature = await signer.signMessage(SIGN_IN_MESSAGE)
  writeCachedSignature(address, signature)
  return deriveKeys(signature)
}

/** Derive the keys from a cached session signature WITHOUT prompting the wallet —
 *  null when this address hasn't signed in this session yet. Lets the app silently
 *  restore a session after a reload/reconnect while NEVER auto-popping the signature
 *  request (which scares users): a first-time sign-in must be an explicit user click. */
export function signInFromCache(address: string): DerivedKeys | null {
  const cached = readCachedSignature(address)
  return cached ? deriveKeys(cached) : null
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, '')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

async function importKey(encryptionKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encryptionKey as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
}

export async function encrypt(data: string, encryptionKey: Uint8Array): Promise<string> {
  const key = await importKey(encryptionKey)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(data)
  const buf = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plaintext as BufferSource),
  )
  // WebCrypto returns ciphertext||tag; split the trailing 16-byte tag back out.
  const tag = buf.slice(buf.length - 16)
  const ct = buf.slice(0, buf.length - 16)
  const result = new Uint8Array(iv.length + tag.length + ct.length)
  result.set(iv, 0)
  result.set(tag, iv.length)
  result.set(ct, iv.length + tag.length)
  return bytesToHex(result)
}

export async function decrypt(encryptedData: string, encryptionKey: Uint8Array): Promise<string> {
  const key = await importKey(encryptionKey)
  const buf = hexToBytes(encryptedData)
  const iv = buf.slice(0, 12)
  const tag = buf.slice(12, 28)
  const ct = buf.slice(28)
  const combined = new Uint8Array(ct.length + tag.length)
  combined.set(ct, 0)
  combined.set(tag, ct.length)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    combined as BufferSource,
  )
  return new TextDecoder().decode(plaintext)
}
