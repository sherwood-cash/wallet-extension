// Local persistence for swap-output notes.
//
// A swap's output amount Y is measured on-chain and isn't known at proof time, so
// the vault emits an EMPTY encryptedOutput for that note — it can't be recovered
// by the usual trial-decryption scan. We therefore store the note (Y, r, index,
// assetId) in localStorage, keyed by the wallet's UTXO pubkey, and merge it back
// into the spendable set. The note's own pubkey P is a ONE-TIME key (see
// deriveSwapKeypair), recomputed from the wallet key plus the blinding stored below — so
// spending later still needs only the wallet's private key, never persisted here.
import type { Keypair } from './privacy/keypair'

export interface StoredSwapNote {
  assetId: string // decimal uint256 string
  amount: string // Y, base units
  blinding: string // r, decimal string
  index: number // leaf index in the asset's tree
  spent: boolean
}

const PREFIX = 'rhm:swapNotes:'

function key(keypair: Keypair): string {
  // pubkey is unique per wallet; safe as a namespace (no private material).
  return `${PREFIX}${keypair.toString().toLowerCase()}`
}

export function loadSwapNotes(keypair: Keypair): StoredSwapNote[] {
  try {
    const raw = localStorage.getItem(key(keypair))
    const parsed = raw ? (JSON.parse(raw) as StoredSwapNote[]) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeSwapNotes(keypair: Keypair, notes: StoredSwapNote[]) {
  try {
    localStorage.setItem(key(keypair), JSON.stringify(notes))
  } catch {
    /* storage unavailable / full — ignore */
  }
}

export function saveSwapNote(keypair: Keypair, note: StoredSwapNote) {
  const notes = loadSwapNotes(keypair)
  // De-dupe on (assetId, index) — a note leaf is unique in its tree.
  const existing = notes.findIndex((n) => n.assetId === note.assetId && n.index === note.index)
  if (existing >= 0) notes[existing] = note
  else notes.push(note)
  writeSwapNotes(keypair, notes)
}

export function markSwapNoteSpent(keypair: Keypair, index: number, assetId: string) {
  const notes = loadSwapNotes(keypair)
  const i = notes.findIndex((n) => n.assetId === assetId && n.index === index)
  if (i >= 0) {
    notes[i] = { ...notes[i], spent: true }
    writeSwapNotes(keypair, notes)
  }
}
