// ERC-5564 stealth addresses, scheme 1 (SECP256k1 with view tags).
//
// The whole scheme in one paragraph: the recipient publishes two public keys, a SPENDING
// key and a VIEWING key. A sender rolls a throwaway keypair, multiplies its private half by
// the recipient's viewing key to get a shared secret only the two of them can compute, and
// offsets the recipient's spending key by the hash of that secret. The result is a fresh
// address that belongs to the recipient and looks like noise to everyone else. The sender
// publishes the throwaway PUBLIC key in an announcement; the recipient replays the same
// multiplication with their viewing key to recognise the payment, and can reconstruct the
// private key because the offset is the same number on both sides.
//
// The asymmetry that makes it useful: the VIEWING key alone finds payments but cannot spend
// them. The SPENDING key is what moves money. They are separated so that scanning — the
// part that has to happen constantly, on whatever device is at hand — never needs the key
// that can steal.
//
// EVERYTHING HERE RUNS IN THE BROWSER AND MUST STAY THERE. The backend serves announcements
// and cannot tell whose they are; that is the entire privacy property. A "which of these are
// mine?" server call would hand it exactly the link the scheme exists to break.
import { secp256k1 } from '@noble/curves/secp256k1'
import { ethers } from 'ethers'

const Point = secp256k1.ProjectivePoint
const CURVE_ORDER = secp256k1.CURVE.n

/** ERC-5564 scheme 1. The only scheme Sherwood speaks. */
export const SCHEME_ID = 1

export interface StealthKeys {
  /** Moves money. Never leaves this device, and is not needed to SCAN. */
  spendingPrivateKey: string
  /** Finds payments. Cannot spend them. */
  viewingPrivateKey: string
  /** Compressed, 33 bytes. */
  spendingPublicKey: string
  viewingPublicKey: string
  /** spendingPublicKey ‖ viewingPublicKey — 66 bytes, what the registry stores. */
  metaAddress: string
}

export interface StealthPayment {
  /** The address the money is at. */
  stealthAddress: string
  /** Compressed ephemeral public key, for the recipient's side of the multiplication. */
  ephemeralPublicKey: string
  /** One byte of the shared-secret hash. Lets a scanner skip ~255/256 of announcements. */
  viewTag: number
  /** ERC-5564 metadata: scheme 1 puts the view tag in byte 0. */
  metadata: string
}

// ---------------------------------------------------------------- small helpers

const hexToBytes = (hex: string): Uint8Array => ethers.utils.arrayify(hex)
const bytesToHex = (b: Uint8Array): string => ethers.utils.hexlify(b)

/** A scalar in [1, n-1] from 32 bytes. */
function toScalar(hex: string): bigint {
  const n = BigInt(hex) % CURVE_ORDER
  // Zero is not a valid private key and the offset must not annihilate the spending key.
  // Astronomically improbable from a hash, but the failure would be a silent loss of funds
  // to an address nobody holds the key for, so it is refused rather than trusted.
  if (n === 0n) throw new Error('scalar reduced to zero')
  return n
}

const scalarToHex = (n: bigint): string => '0x' + n.toString(16).padStart(64, '0')

/** Compressed public key (33 bytes) for a private scalar. */
function publicKeyOf(priv: bigint): string {
  return bytesToHex(Point.BASE.multiply(priv).toRawBytes(true))
}

/**
 * The Ethereum address of a public key.
 *
 * keccak of the UNCOMPRESSED point without its 0x04 prefix, last 20 bytes — computed via
 * ethers so it agrees byte-for-byte with the rest of the app rather than being a second
 * implementation of the same rule.
 */
function addressOf(point: InstanceType<typeof Point>): string {
  return ethers.utils.computeAddress(bytesToHex(point.toRawBytes(false)))
}

// ---------------------------------------------------------------- key derivation

/** The message a wallet signs to derive its stealth keys. Fixed, so it is deterministic. */
export const STEALTH_SIGN_IN_MESSAGE =
  'Sherwood stealth wallet\n\nSign to derive your stealth spending and viewing keys.\n\nThis signature never leaves your device.'

/**
 * Derive both keys from one wallet signature.
 *
 * Deterministic, so the same wallet always recovers the same stealth identity: there is no
 * backup to lose, and a user who clears their browser re-signs and gets everything back.
 * That is the whole reason not to generate random keys here — random keys would mean a seed
 * phrase to store, and a payment that is unrecoverable the moment it is lost.
 *
 * The two keys are derived through SEPARATE domain-separated hashes rather than one from
 * the other. If the viewing key were `hash(spending key)` the split would be decorative in
 * one direction; deriving both from a common root keeps the useful direction — hand someone
 * your viewing key and they can audit your incoming payments without being able to spend a
 * single one.
 */
export function deriveStealthKeys(signature: string): StealthKeys {
  const root = ethers.utils.keccak256(signature)
  const spending = toScalar(ethers.utils.keccak256(ethers.utils.concat([root, ethers.utils.toUtf8Bytes('spend')])))
  const viewing = toScalar(ethers.utils.keccak256(ethers.utils.concat([root, ethers.utils.toUtf8Bytes('view')])))

  const spendingPublicKey = publicKeyOf(spending)
  const viewingPublicKey = publicKeyOf(viewing)

  return {
    spendingPrivateKey: scalarToHex(spending),
    viewingPrivateKey: scalarToHex(viewing),
    spendingPublicKey,
    viewingPublicKey,
    metaAddress: ethers.utils.hexConcat([spendingPublicKey, viewingPublicKey]),
  }
}

// ---------------------------------------------------------------- meta-addresses

/**
 * Parse `0x<33-byte spending><33-byte viewing>` — the shareable form.
 *
 * Also accepts the ERC-5564 `st:eth:0x…` prefix, so a meta-address copied out of another
 * wallet pastes in without the user having to know which spelling they are holding.
 *
 * Returns null rather than throwing: this parses whatever a user pasted into a text field,
 * and a half-typed key is the normal state of that field, not an error.
 */
export function parseMetaAddress(
  raw: string,
): { spendingPublicKey: string; viewingPublicKey: string; metaAddress: string } | null {
  if (!raw) return null
  const clean = raw.trim().replace(/^st:eth:/i, '').toLowerCase()
  if (!/^0x[0-9a-f]{132}$/.test(clean)) return null

  const spendingPublicKey = '0x' + clean.slice(2, 68)
  const viewingPublicKey = '0x' + clean.slice(68, 134)

  // Well-formed length is not well-formed KEYS. A 33-byte string that is not a curve point
  // would fail later, deep inside a multiplication, on a screen that has already told the
  // user their payment is being sent.
  try {
    Point.fromHex(spendingPublicKey.slice(2))
    Point.fromHex(viewingPublicKey.slice(2))
  } catch {
    return null
  }

  return { spendingPublicKey, viewingPublicKey, metaAddress: clean }
}

/** The canonical shareable string: `0x<spending><viewing>`. */
export const formatMetaAddress = (spendingPublicKey: string, viewingPublicKey: string): string =>
  ethers.utils.hexConcat([spendingPublicKey, viewingPublicKey]).toLowerCase()

// ---------------------------------------------------------------- the scheme itself

/**
 * The shared secret hash, from one private scalar and one public point.
 *
 * Both sides of the protocol call this: the sender with (ephemeral private, viewing
 * public), the recipient with (viewing private, ephemeral public). They agree because
 * `r·(v·G) == v·(r·G)` — which is the whole trick.
 *
 * The point is serialised COMPRESSED before hashing. Sender and recipient must agree on
 * that byte-for-byte; hashing the uncompressed form on one side would produce a different
 * offset and an address whose key nobody holds.
 */
function sharedSecretHash(privateScalar: bigint, publicKey: string): string {
  const shared = Point.fromHex(publicKey.replace(/^0x/, '')).multiply(privateScalar)
  return ethers.utils.keccak256(shared.toRawBytes(true))
}

/**
 * Generate a stealth address to pay a recipient's meta-address.
 *
 * `ephemeralPrivateKey` is injectable for tests ONLY. In production it must be freshly
 * random per payment: reusing one across two payments to the same recipient produces the
 * same stealth address, which links them — the exact thing the scheme is for.
 */
export function generateStealthAddress(
  metaAddress: string,
  ephemeralPrivateKey?: string,
): StealthPayment & { ephemeralPrivateKey: string } {
  const parsed = parseMetaAddress(metaAddress)
  if (!parsed) throw new Error('Not a valid stealth meta-address')

  const ephemeral = ephemeralPrivateKey
    ? toScalar(ephemeralPrivateKey)
    : toScalar(bytesToHex(secp256k1.utils.randomPrivateKey()))

  const secretHash = sharedSecretHash(ephemeral, parsed.viewingPublicKey)
  const viewTag = parseInt(secretHash.slice(2, 4), 16)

  // P_stealth = P_spend + hash·G
  const stealthPoint = Point.fromHex(parsed.spendingPublicKey.slice(2)).add(
    Point.BASE.multiply(toScalar(secretHash)),
  )

  return {
    stealthAddress: addressOf(stealthPoint),
    ephemeralPublicKey: publicKeyOf(ephemeral),
    ephemeralPrivateKey: scalarToHex(ephemeral),
    viewTag,
    metadata: '0x' + viewTag.toString(16).padStart(2, '0'),
  }
}

/**
 * The view-tag check: does this announcement plausibly belong to us?
 *
 * One curve multiplication and a byte compare. ~255/256 of a stranger's announcements fail
 * here, which is the difference between a scan that finishes and one that does not. A pass
 * is NOT proof — 1/256 of foreign announcements pass by chance — so `checkAnnouncement`
 * below still verifies the derived address in full.
 */
export function matchesViewTag(viewingPrivateKey: string, ephemeralPublicKey: string, viewTag: number): boolean {
  try {
    const secretHash = sharedSecretHash(toScalar(viewingPrivateKey), ephemeralPublicKey)
    return parseInt(secretHash.slice(2, 4), 16) === viewTag
  } catch {
    return false
  }
}

/**
 * Is this announcement ours, and if so what is it?
 *
 * Verifies by DERIVING the address and comparing it to the announced one, never by trusting
 * the announcement. Announcements are permissionless: anyone may emit one naming any
 * address, so believing the `stealthAddress` field would let a stranger put arbitrary
 * addresses in someone's wallet.
 *
 * Returns null on anything malformed. A scan walks thousands of these, many written by
 * people with no obligation to be well-formed, and one bad row must not stop the walk.
 */
export function checkAnnouncement(
  keys: Pick<StealthKeys, 'spendingPublicKey' | 'viewingPrivateKey'>,
  announcement: { stealthAddress: string; ephemeralPubKey: string; viewTag?: number | null },
): { stealthAddress: string; secretHash: string } | null {
  try {
    const secretHash = sharedSecretHash(toScalar(keys.viewingPrivateKey), announcement.ephemeralPubKey)

    // Cheap reject first, when the announcer bothered to publish a tag.
    if (announcement.viewTag !== null && announcement.viewTag !== undefined) {
      if (parseInt(secretHash.slice(2, 4), 16) !== announcement.viewTag) return null
    }

    const derived = addressOf(
      Point.fromHex(keys.spendingPublicKey.slice(2)).add(Point.BASE.multiply(toScalar(secretHash))),
    )
    if (derived.toLowerCase() !== announcement.stealthAddress.toLowerCase()) return null

    return { stealthAddress: derived, secretHash }
  } catch {
    return null
  }
}

/**
 * The private key for a stealth address we own: `p_spend + hash (mod n)`.
 *
 * The one function in this file that needs the SPENDING key, which is why it is separate
 * from `checkAnnouncement` — scanning must be possible on a device that never holds it.
 */
export function computeStealthPrivateKey(spendingPrivateKey: string, secretHash: string): string {
  const key = (toScalar(spendingPrivateKey) + toScalar(secretHash)) % CURVE_ORDER
  if (key === 0n) throw new Error('derived a zero private key')
  return scalarToHex(key)
}

/**
 * Recover the whole payment from an announcement, spending key included.
 *
 * The address is re-derived FROM the private key rather than carried over from the check
 * above. It is the same value by construction, so this is a redundant computation on
 * purpose: it is the one assertion that catches a key which does not actually control the
 * address it is about to be used for, and the cost of getting that wrong is funds that
 * appear in the UI and cannot be moved.
 */
export function recoverStealthPayment(
  keys: StealthKeys,
  announcement: { stealthAddress: string; ephemeralPubKey: string; viewTag?: number | null },
): { stealthAddress: string; privateKey: string } | null {
  const hit = checkAnnouncement(keys, announcement)
  if (!hit) return null

  const privateKey = computeStealthPrivateKey(keys.spendingPrivateKey, hit.secretHash)
  if (ethers.utils.computeAddress(privateKey).toLowerCase() !== hit.stealthAddress.toLowerCase()) {
    return null
  }
  return { stealthAddress: hit.stealthAddress, privateKey }
}
