// Finding the stealth addresses that belong to you, and what is in them.
//
// Two halves, deliberately separate:
//
//   scanAnnouncements  pure crypto over a list of announcements. No network, no chain, no
//                      wallet — just "which of these does this viewing key own?". Testable
//                      on its own, which matters because a bug here loses money silently:
//                      a payment this misses is one its owner never learns they have.
//
//   loadBalances       one Multicall3 read for every owned address at once.
//
// The scan is O(announcements), not O(your payments), and that is unavoidable: the whole
// point is that nobody — including this app's own backend — can tell which announcements
// are yours without your viewing key. The view tag is what keeps it cheap.
import { BigNumber, ethers } from 'ethers'
import { checkAnnouncement, computeStealthPrivateKey, type StealthKeys } from './crypto'
import type { RawAnnouncement } from './api'

export interface OwnedStealthAddress {
  address: string
  /** Where the payment was announced — for the explorer link and for scan resumption. */
  blockNumber: number
  txHash: string
  ephemeralPubKey: string
  /** Kept so the spending key can be derived later, on demand, rather than held for every
   *  address the moment it is found. */
  secretHash: string
}

export interface StealthBalance {
  native: BigNumber
  /** token address (lowercased) -> balance */
  tokens: Record<string, BigNumber>
}

export interface StealthWallet extends OwnedStealthAddress, StealthBalance {
  /**
   * True when the address holds no native coin.
   *
   * The flag the whole gas-less path hangs off. An address paid only in USDG cannot pay for
   * its own transaction, so it cannot be CONSOLIDATED (that is an ordinary transfer it would
   * have to sign and submit itself) — but it CAN still be deposited into the vault, because
   * there the stealth key only has to sign an EIP-3009 authorisation and a relayer submits
   * it. Sending it gas to "fix" this is the one thing that must never happen: the funding
   * transaction publicly links the funder to the address.
   */
  noGas: boolean
  /** Nothing at all in it — worth showing dimmed rather than hiding, so a user can see the
   *  address was used and then emptied. */
  empty: boolean
  /**
   * Holds something, but less than it would cost to move.
   *
   * Hidden from the main list by default rather than dropped: the row is real, and a wallet
   * that disagrees with the chain about what somebody was sent is worse than a long list.
   */
  dust: boolean
}

/**
 * Which of these announcements are ours?
 *
 * Needs the PUBLIC spending key and the PRIVATE viewing key — enough to find money, not
 * enough to move it. The spending private key is deliberately not a parameter.
 */
export function scanAnnouncements(
  keys: Pick<StealthKeys, 'spendingPublicKey' | 'viewingPrivateKey'>,
  announcements: RawAnnouncement[],
): OwnedStealthAddress[] {
  const found: OwnedStealthAddress[] = []
  const seen = new Set<string>()

  for (const a of announcements) {
    const hit = checkAnnouncement(keys, {
      stealthAddress: a.stealthAddress,
      ephemeralPubKey: a.ephemeralPubKey,
      viewTag: a.viewTag,
    })
    if (!hit) continue

    // The same address can be announced more than once — a re-announcement, a reorg
    // replay, or simply two payments made with the same ephemeral key by a careless
    // sender. It is ONE wallet either way, and listing it twice would double-count the
    // balance on screen.
    const key = hit.stealthAddress.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    found.push({
      address: hit.stealthAddress,
      blockNumber: a.blockNumber,
      txHash: a.txHash,
      ephemeralPubKey: a.ephemeralPubKey,
      secretHash: hit.secretHash,
    })
  }

  return found
}

/** The spending key for one owned address, derived on demand. */
export const privateKeyFor = (keys: StealthKeys, owned: OwnedStealthAddress): string =>
  computeStealthPrivateKey(keys.spendingPrivateKey, owned.secretHash)

// ---------------------------------------------------------------- balances

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
const MULTICALL3_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
  'function getEthBalance(address addr) view returns (uint256)',
]
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)']

const multicallIface = new ethers.utils.Interface(MULTICALL3_ABI)
const erc20Iface = new ethers.utils.Interface(ERC20_ABI)

/**
 * Native + token balances for every address, in ONE eth_call.
 *
 * A user with thirty stealth addresses and two tokens is ninety balance reads done
 * naively, which on a public RPC is a rate-limit and a visibly slow page. Multicall3
 * collapses them into one; `allowFailure` is set so a single reverting token (a
 * self-destructed contract, a token that reverts on a zero balance) degrades to 0 rather
 * than emptying the whole page.
 */
export async function loadBalances(
  provider: ethers.providers.Provider,
  addresses: string[],
  tokens: string[],
): Promise<Record<string, StealthBalance>> {
  const out: Record<string, StealthBalance> = {}
  for (const a of addresses) out[a.toLowerCase()] = { native: BigNumber.from(0), tokens: {} }
  if (addresses.length === 0) return out

  const erc20s = tokens.map((t) => t.toLowerCase()).filter((t) => t && t !== ethers.constants.AddressZero)

  type Call = { target: string; allowFailure: boolean; callData: string }
  const calls: Call[] = []
  // Parallel to `calls`, so a result can be attributed without re-deriving what it was.
  const plan: { address: string; token: string | null }[] = []

  for (const address of addresses) {
    calls.push({
      target: MULTICALL3,
      allowFailure: true,
      callData: multicallIface.encodeFunctionData('getEthBalance', [address]),
    })
    plan.push({ address, token: null })

    for (const token of erc20s) {
      calls.push({
        target: token,
        allowFailure: true,
        callData: erc20Iface.encodeFunctionData('balanceOf', [address]),
      })
      plan.push({ address, token })
    }
  }

  const multicall = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, provider)

  // Chunked: one aggregate3 with a few thousand sub-calls exceeds what many RPCs will
  // return, and the failure is an opaque 500 rather than anything actionable.
  const CHUNK = 400
  for (let i = 0; i < calls.length; i += CHUNK) {
    const slice = calls.slice(i, i + CHUNK)
    let results: { success: boolean; returnData: string }[]
    try {
      results = await multicall.callStatic.aggregate3(slice)
    } catch {
      // A failed chunk leaves those balances at zero rather than throwing away the page.
      continue
    }

    results.forEach((r, j) => {
      if (!r.success || !r.returnData || r.returnData === '0x') return
      const { address, token } = plan[i + j]
      let value: BigNumber
      try {
        value = BigNumber.from(r.returnData)
      } catch {
        return
      }
      const entry = out[address.toLowerCase()]
      if (!entry) return
      if (token === null) entry.native = value
      else entry.tokens[token] = value
    })
  }

  return out
}

/**
 * The smallest native balance worth showing as a wallet.
 *
 * Anything under this is dust: it costs more to move than it is worth, and a list padded
 * with it buries the payments that matter. 0.00005 ETH by default — well under any real
 * payment, well over a spam transfer.
 *
 * Dust is HIDDEN, not discarded: `toWallets` still returns the row with `dust: true` so a
 * user who goes looking can be shown it. Silently dropping a row would mean a wallet that
 * disagrees with the chain about what somebody was sent.
 */
export const DUST_NATIVE = BigNumber.from('50000000000000') // 0.00005 ETH

/** token (lowercased) -> the smallest balance worth showing, in that token's base units. */
export type DustFloors = { native?: BigNumber; tokens?: Record<string, BigNumber> }

/** Join owned addresses with their balances, and flag the states the UI acts on. */
export function toWallets(
  owned: OwnedStealthAddress[],
  balances: Record<string, StealthBalance>,
  floors: DustFloors = {},
): StealthWallet[] {
  const nativeFloor = floors.native ?? DUST_NATIVE
  return owned.map((o) => {
    const b = balances[o.address.toLowerCase()] ?? { native: BigNumber.from(0), tokens: {} }
    const hasToken = Object.values(b.tokens).some((v) => v.gt(0))
    const empty = b.native.isZero() && !hasToken

    // Above the floor on ANY asset is enough to be a real wallet. A token floor defaults to
    // "any non-zero amount": a token's decimals are not knowable here, so guessing a
    // threshold would hide real money in a 6-decimal stablecoin.
    const nativeAboveDust = b.native.gte(nativeFloor)
    const tokenAboveDust = Object.entries(b.tokens).some(([token, v]) => {
      const floor = floors.tokens?.[token]
      return floor ? v.gte(floor) : v.gt(0)
    })

    return {
      ...o,
      native: b.native,
      tokens: b.tokens,
      noGas: b.native.isZero(),
      empty,
      dust: !empty && !nativeAboveDust && !tokenAboveDust,
    }
  })
}

/**
 * Can this wallet be consolidated — i.e. send its own transaction?
 *
 * Consolidation is an ordinary transfer signed by the stealth key and submitted from the
 * stealth address, so it needs native gas. This is what greys the checkbox and puts the
 * "No gas" marker beside it, and it is deliberately NOT the same question as "can this be
 * deposited into the vault": that path routes through a relayer and needs no gas at all.
 */
export const canConsolidate = (w: StealthWallet): boolean => !w.native.isZero()

/** Total held across a set of wallets, per asset. For the header figure. */
export function totals(wallets: StealthWallet[]): { native: BigNumber; tokens: Record<string, BigNumber> } {
  const tokens: Record<string, BigNumber> = {}
  let native = BigNumber.from(0)
  for (const w of wallets) {
    native = native.add(w.native)
    for (const [token, value] of Object.entries(w.tokens)) {
      tokens[token] = (tokens[token] ?? BigNumber.from(0)).add(value)
    }
  }
  return { native, tokens }
}


/**
 * Must the loaded wallet be thrown away?
 *
 * True the moment the connected account is not the one the keys belong to — a disconnect
 * (no address) or a switch to another account. Both used to leave the previous account's
 * addresses and balances on screen; the switch is the dangerous one, because a wrong
 * identity that looks right is worse than a stale screen that obviously is not.
 *
 * Pure so it can be pinned by tests: the component around it needs effects to exercise, this
 * does not.
 */
export const shouldResetFor = (keysOwner: string | null, address: string | null): boolean =>
  keysOwner !== null && keysOwner.toLowerCase() !== (address ?? '').toLowerCase()
