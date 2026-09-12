// The address currently on offer in Receive, remembered between reopens.
//
// Opening Receive used to mint a fresh address every time, so a user who opened it, closed it,
// and opened it again produced three addresses and was paid at none of them. So an address is
// reused until it has actually been PAID. A new one is minted when the current one receives
// money — reusing THEN would link the two payments, the whole thing this feature prevents — or
// when the user asks for one.
//
// Held on disk (chrome.storage.local, see storage.ts) and scoped by chainId+vault, because two
// accounts on one browser must never be handed each other's address.
import { diskGet, diskRemove, diskSet, scopedKey } from './storage'

const PREFIX = 'sherwood:ext:stealth-recv:'

export interface HeldAddress {
  address: string
  ephemeralPublicKey: string
  viewTag: number
  /** When it was handed out. Used to drop it once the backend has stopped watching it. */
  at: number
}

const key = (owner: string) => scopedKey(PREFIX, owner)

/**
 * The address currently on offer, or null.
 *
 * `windowHours` is the backend's own figure: past it the watcher has stopped looking, so
 * continuing to show the address would be offering one whose payments nobody would announce.
 */
export async function heldAddress(owner: string, windowHours: number): Promise<HeldAddress | null> {
  try {
    const raw = await diskGet(key(owner))
    if (!raw) return null
    const held = JSON.parse(raw) as HeldAddress
    if (
      typeof held?.address !== 'string' ||
      typeof held?.ephemeralPublicKey !== 'string' ||
      typeof held?.viewTag !== 'number' ||
      typeof held?.at !== 'number'
    ) {
      return null
    }
    // Expire a touch EARLY rather than late. An address shown in its final minutes would be
    // copied, paid a few minutes later, and never announced.
    const usable = windowHours * 3600_000 * 0.9
    if (Date.now() - held.at > usable) {
      await clearHeldAddress(owner)
      return null
    }
    return held
  } catch {
    return null
  }
}

export async function holdAddress(owner: string, held: Omit<HeldAddress, 'at'>): Promise<void> {
  await diskSet(key(owner), JSON.stringify({ ...held, at: Date.now() }))
}

export async function clearHeldAddress(owner: string): Promise<void> {
  await diskRemove(key(owner))
}

/**
 * Should the held address be replaced?
 *
 * Only when it has been PAID. An address that received something must never be offered again —
 * a second payment to it would be publicly linked to the first.
 */
export const shouldRotate = (held: HeldAddress | null, paidAddresses: Set<string>): boolean =>
  held !== null && paidAddresses.has(held.address.toLowerCase())
