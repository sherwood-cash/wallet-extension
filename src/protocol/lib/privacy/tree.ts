// Rebuild the user's Merkle trees from NewCommitment events and recover their spendable
// notes by trial-decrypting each commitment.
//
// The vault keeps one tree per (assetId, epoch) pair: a full tree is sealed and a fresh
// one opened. Notes never move — a spend proves membership in the tree its note lives in,
// and the output notes land in the live epoch.
//
// The index in NewCommitment is global across epochs:
//     epoch = index / TREE_CAPACITY        localIndex = index % TREE_CAPACITY
// Only localIndex may reach the circuit: merkleProof.circom applies
// Num2Bits(MERKLE_TREE_HEIGHT) to pathIndices, so a global index is unprovable. It also
// feeds the nullifier, so getting it wrong yields a note nobody can spend.
import { ethers, BigNumber } from 'ethers'
import { MerkleTree } from 'fixed-merkle-tree'
import { Utxo } from './utxo'
import { Keypair, deriveTemporaryKeypair } from './keypair'
import { getScanAnchor } from './syncCache'
import { readProvider } from '../rpc'
import { poseidonHash2, toFixedHex, MERKLE_TREE_HEIGHT, MERKLE_TREE_ZERO_VALUE } from './utils'
import {
  indexerEnabled,
  fetchCommitmentsFromIndexer,
  fetchNullifiersFromIndexer,
} from './indexer'
import { DEPLOYMENT } from '../../config'
import { VAULT_ABI } from '../contracts/abis'

/** Leaves per tree — must equal SherwoodVault.capacity() (2**levels). */
export const TREE_CAPACITY = 2 ** MERKLE_TREE_HEIGHT

export const epochOf = (globalIndex: number): number => Math.floor(globalIndex / TREE_CAPACITY)
export const localIndexOf = (globalIndex: number): number => globalIndex % TREE_CAPACITY

export function emptyTree(): MerkleTree {
  return new MerkleTree(MERKLE_TREE_HEIGHT, [], {
    hashFunction: poseidonHash2,
    zeroElement: MERKLE_TREE_ZERO_VALUE,
  })
}

export interface CommitmentEvent {
  commitment: string
  index: number // GLOBAL index as emitted by the vault
  encryptedOutput: string
  /**
   * Set only on a swap output note: the amount the vault measured on-chain.
   *
   * Such a note's blob is written before the swap runs, so its amount field is a
   * placeholder — the real one is published by the Swap event and pinned here by the
   * indexer. The blob still carries the blinding, which is the part nothing on-chain
   * reveals. Everything else about the note behaves normally.
   */
  swapAmount?: string | null
  /** set on a reward-claim output: owned by a one-time key, like a swap output */
  claimNote?: boolean
}

/** Build one tree per epoch. Leaves are placed at their LOCAL index within each epoch. */
export function buildTrees(commitments: CommitmentEvent[]): Map<number, MerkleTree> {
  const byEpoch = new Map<number, CommitmentEvent[]>()
  for (const c of commitments) {
    const e = epochOf(c.index)
    const bucket = byEpoch.get(e)
    if (bucket) bucket.push(c)
    else byEpoch.set(e, [c])
  }

  const trees = new Map<number, MerkleTree>()
  for (const [epoch, events] of byEpoch) {
    const ordered = [...events].sort((a, b) => a.index - b.index)
    trees.set(
      epoch,
      new MerkleTree(
        MERKLE_TREE_HEIGHT,
        ordered.map((c) => c.commitment),
        { hashFunction: poseidonHash2, zeroElement: MERKLE_TREE_ZERO_VALUE },
      ),
    )
  }
  return trees
}

export interface OwnedNotes {
  /** epoch -> that epoch's reconstructed tree */
  trees: Map<number, MerkleTree>
  /** the epoch new notes are currently written to, per the vault (see fetchLiveEpoch) */
  liveEpoch: number
  /** unspent notes, amount > 0, each tagged with its epoch and LOCAL index */
  notes: Utxo[]
  balance: ethers.BigNumber
}

/** The tree a note must be proved against, or an empty one if that epoch has no leaves. */
export function treeForEpoch(owned: OwnedNotes, epoch: number): MerkleTree {
  return owned.trees.get(epoch) ?? emptyTree()
}

// ---- live epoch ------------------------------------------------------------
//
// The vault is the only authority on which epoch is live. Leaf data cannot answer it:
// forceRotate() opens a fresh epoch that holds no leaves, so an indexer (or a log scan)
// still reports the previous epoch until someone deposits into the new tree.
//
// This is ONE eth_call, which is why it does not contradict the indexer-only rule below:
// that rule exists because rebuilding a tree from logs costs thousands of windowed
// queries, not because chain reads are off-limits.
function vaultReader(): ethers.Contract {
  return new ethers.Contract(DEPLOYMENT.vault, VAULT_ABI, readProvider)
}

/** `currentEpoch(assetId)` straight from the vault, or null when the RPC is unreachable. */
export async function fetchLiveEpoch(assetId: BigNumber): Promise<number | null> {
  try {
    // uint32 — ethers may hand back a number or a BigNumber, so normalise both.
    const raw = await vaultReader().currentEpoch(assetId)
    return BigNumber.from(raw).toNumber()
  } catch {
    return null // fall back to the leaves; a stale epoch is worse than no epoch here
  }
}

// Decrypt every commitment in this asset's trees with the user's key; keep the ones that
// belong to them and are still unspent (nullifier not yet seen on-chain).
//
// The indexer is the ONLY source. There is deliberately no eth_getLogs fallback:
// rebuilding a tree from logs means thousands of windowed RPC calls per asset on every
// scan. If the indexer can't answer we surface that rather than silently falling back.
export async function scanNotes(
  assetId: BigNumber,
  keypair: Keypair,
  encryptionKey: Uint8Array,
  // Batch-wide reads a multi-asset caller may have fetched ONCE for every asset, so a scan
  // over N assets doesn't repeat them per asset: the live epoch (from a single Multicall3
  // currentEpoch aggregate across all assets) and the global spent-nullifier set. Either
  // may be omitted — the scan then fetches it itself, exactly as a single-asset scan always
  // has. A `liveEpoch` of null is a real value ("no chain epoch, fall back to the leaves"),
  // distinct from undefined ("not prefetched — go read currentEpoch").
  prefetch?: { liveEpoch?: number | null; spentSet?: Set<string> },
): Promise<OwnedNotes> {
  if (!indexerEnabled()) {
    throw new Error('Indexer not configured — cannot fetch notes (set VITE_INDEXER_URL)')
  }
  const [commitments, chainEpoch] = await Promise.all([
    fetchCommitmentsFromIndexer(assetId),
    prefetch?.liveEpoch !== undefined ? Promise.resolve(prefetch.liveEpoch) : fetchLiveEpoch(assetId),
  ])
  const spentSet = prefetch?.spentSet ?? (await fetchNullifiersFromIndexer(assetId))

  const trees = buildTrees(commitments)
  // The highest epoch holding a leaf. Not spread into Math.max: an asset's tree can hold
  // millions of leaves and `Math.max(...arr)` blows the argument limit well before that.
  let highestSeen = 0
  for (const c of commitments) {
    const e = epochOf(c.index)
    if (e > highestSeen) highestSeen = e
  }
  // The vault's answer wins, but take the max anyway: an RPC node lagging behind the
  // indexer would otherwise report an epoch older than leaves we already hold. Rotation
  // only ever moves forward, so the max is always the safe direction.
  const liveEpoch = Math.max(highestSeen, chainEpoch ?? 0)

  // Trial decryption is the expensive half of a scan — one AES-GCM open per leaf — and a
  // wallet cannot own a note minted before its own first deposit. The anchor says where its
  // notes can start; leaves below it are still FETCHED (the tree above needs every one of
  // them, or the root is wrong) but never opened. Absent anchor: open everything, which is
  // correct, just slower.
  const anchor = getScanAnchor(keypair.toString())?.[assetId.toString()] ?? 0

  const candidates: Utxo[] = []
  for (const c of commitments) {
    if (c.index < anchor) continue
    const epoch = epochOf(c.index)
    const local = localIndexOf(c.index)
    try {
      const utxo = await Utxo.decrypt(encryptionKey, c.encryptedOutput, local, keypair, epoch)
      // A swap output note differs from every other note in exactly two ways, both
      // rebuilt here rather than read from the blob:
      //  - its amount. The blob was sealed before the swap ran, so it holds a placeholder;
      //    the vault measured the real Y on-chain, the Swap event published it, and the
      //    indexer pinned it to this leaf.
      //  - its owner. A swap's P is plaintext calldata, so it is a one-time key rather
      //    than this wallet's pubkey (see deriveTemporaryKeypair). The blinding the blob just
      //    gave us is the nonce it was derived from, so we recompute it.
      // The blinding itself came out of the blob like any other note's.
      if (c.swapAmount) {
        utxo.amount = BigNumber.from(c.swapAmount)
        utxo.keypair = deriveTemporaryKeypair(keypair.privkey, utxo.blinding)
      } else if (c.claimNote) {
        // A reward-claim output: its blob holds the real amount, but its pubkey went public
        // with the claim, so it is a one-time key derived the same way.
        utxo.keypair = deriveTemporaryKeypair(keypair.privkey, utxo.blinding)
      }
      // Confirm the decrypted note actually reproduces this commitment (i.e. it is really
      // ours, the index lines up, and its assetId matches this tree).
      if (
        toFixedHex(utxo.getCommitment()) === c.commitment &&
        utxo.amount.gt(0) &&
        utxo.assetId.eq(assetId)
      ) {
        candidates.push(utxo)
      }
    } catch {
      // not our note (AES auth failure) — skip
    }
  }

  const notes = candidates.filter((n) => !spentSet.has(toFixedHex(n.getNullifier()).toLowerCase()))
  const balance = notes.reduce((s, n) => s.add(n.amount), ethers.BigNumber.from(0))
  return { trees, liveEpoch, notes, balance }
}

const desc = (a: Utxo, b: Utxo) => (b.amount.gt(a.amount) ? 1 : -1)
const sum = (ns: Utxo[]) => ns.reduce((s, n) => s.add(n.amount), ethers.BigNumber.from(0))

export interface NoteSelection {
  /** epoch of the tree the chosen inputs live in — goes on the wire as `inEpoch` */
  epoch: number
  /** at most 2 notes, all from `epoch` (the circuit has ONE public root) */
  inputs: Utxo[]
  /**
   * Set when the balance is there but split across epochs. The caller must first send a
   * migration transaction (extAmount == 0) spending `inputs`, which reissues their value
   * in the live epoch, then re-scan and select again.
   */
  needsMigration: boolean
}

/**
 * Pick the notes to spend for `amount` (fee included).
 *
 * Two hard constraints, both from the circuit: at most 2 inputs, and all inputs must
 * share ONE tree — so one asset AND one epoch. When no single epoch can cover the amount
 * but the total can, we return a migration step instead of failing: spending old-epoch
 * notes reissues their value in the live epoch, after which the balance consolidates and
 * the real spend goes through.
 */
export function selectNotes(notes: Utxo[], amount: ethers.BigNumber, liveEpoch = 0): NoteSelection {
  if (sum(notes).lt(amount)) {
    throw new Error('Insufficient shielded balance for this amount plus the relayer fee')
  }

  const byEpoch = new Map<number, Utxo[]>()
  for (const n of notes) {
    const bucket = byEpoch.get(n.epoch)
    if (bucket) bucket.push(n)
    else byEpoch.set(n.epoch, [n])
  }

  // Prefer the live epoch, then the most recent — it keeps notes where new ones land.
  const epochs = [...byEpoch.keys()].sort((a, b) =>
    a === liveEpoch ? -1 : b === liveEpoch ? 1 : b - a,
  )

  for (const epoch of epochs) {
    const sorted = [...byEpoch.get(epoch)!].sort(desc)
    // Take the largest note alone when it already covers the amount, so we burn one
    // note instead of two and leave the balance less fragmented.
    const inputs = sorted[0].amount.gte(amount) ? [sorted[0]] : sorted.slice(0, 2)
    if (sum(inputs).gte(amount)) return { epoch, inputs, needsMigration: false }
  }

  // No single epoch covers it. Pull the oldest epoch's two largest notes forward; each
  // migration consolidates two notes into the live epoch, so repeating converges.
  const oldest = epochs.filter((e) => e !== liveEpoch).sort((a, b) => a - b)[0]
  if (oldest === undefined) {
    // Everything is already in one epoch, so this is plain 2-input fragmentation.
    throw new Error(
      'Your shielded balance is split across more than 2 notes; a single transaction can only spend your 2 largest. Consolidate first, or spend a smaller amount.',
    )
  }
  return {
    epoch: oldest,
    inputs: [...byEpoch.get(oldest)!].sort(desc).slice(0, 2),
    needsMigration: true,
  }
}
