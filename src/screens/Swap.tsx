/**
 * The popup's swap screen — the web app's `SwapCard` at 360px.
 *
 * Same protocol path, none of it re-implemented: a shielded input note is spent into
 * the vault, routed through a whitelisted Uniswap router, and the measured output is
 * minted as a fresh private note. Every guard the web app carries (quote-only pairs,
 * the ETH dust minimum, the 2-note spend ceiling, slippage → minOut) is carried here
 * too, because they all describe what the vault will accept, not how a card looks.
 *
 * What changes is the frame: the two legs stack instead of sitting side by side, the
 * discovery surface (import-by-address, Uniswap search, trending) is dropped with the
 * rest of `TokenSelect`, and the fee/rate breakdown folds into a disclosure so the
 * amount and the CTA are always both on screen.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ethers } from 'ethers'
import { swap } from '@app/lib/actions'
import { quoteAmountOut, resolveRoute } from '@app/lib/swap'
import { feeForAsset, relayInfo, relayerEnabled } from '@app/lib/relayer'
import {
  DEPLOYMENT,
  MIN_SWAP_ETH,
  ZERO,
  belowSwapMin,
  isQuoteAsset,
  isSwapEnabled,
  type AssetMeta,
} from '@app/config'
import { fmtUnits, useAccountState } from '../state'
import { TokenPicker } from '../components/TokenPicker'
import {
  ArrowDown,
  ChevronDown,
  InfoRow,
  ProvingNotice,
  Refresh,
  ScreenHeader,
  StatusNote,
  SubmitButton,
  SwapArrows,
  TxLink,
} from '../components/ui'

const Zero = ethers.constants.Zero

/** Slippage presets, in percent. Matches the web app: 2% default, 5% for thin pools. */
const SLIPPAGE_PRESETS = [2, 5]

/** Parse a typed amount without throwing: a half-typed "1." or "0.0000001" on a
 *  6-decimal token both reach `parseUnits`, and a throw there would blank the screen. */
function parseAmount(value: string, decimals: number): ethers.BigNumber | null {
  try {
    const v = ethers.utils.parseUnits(value.trim() || '0', decimals)
    return v.gt(0) ? v : null
  } catch {
    return null
  }
}

/** Format a base-units amount for the estimate line. */
function fmtOut(v: ethers.BigNumber, decimals: number): string {
  const n = Number(ethers.utils.formatUnits(v, decimals))
  if (!isFinite(n)) return '—'
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 })
}

/**
 * Turn a raw relayer/vault error into something a user can act on: drop the
 * "Relayer /relay/swap:" prefix and the "| data=0x…" ABI blob, and rewrite the known
 * too-small revert into plain language. Ported from the web app — without it the
 * commonest failure reads as a hex dump.
 */
function cleanSwapError(raw: string): string {
  const msg = raw
    .replace(/^Relayer\s+\/relay\/\S+:\s*/i, '')
    .replace(/\s*\|\s*data=0x[0-9a-f]*/i, '')
    .trim()
  if (/ext amount must exceed fee|amount_below_fee|below the relayer fee/i.test(msg))
    return `Amount too small — a swap must be at least ${MIN_SWAP_ETH} ETH to cover the relayer fee.`
  if (/simulation_reverted/i.test(msg))
    return 'The swap was rejected by the network (simulation failed). Try a larger amount or another token.'
  return msg
}

const errText = (e: unknown): string => {
  const err = e as { reason?: string; message?: string } | null
  return err?.reason || err?.message || String(e)
}

export function Swap() {
  const { signer, keys, signingIn, assets, shielded, pushActivity, expand } = useAccountState()

  // The context's single `asset` drives deposit/withdraw. A swap has two legs, so the
  // pair lives here and nothing else in the popup has to know about it.
  const [fromKey, setFromKey] = useState(assets[0]?.key ?? '')
  const [toKey, setToKey] = useState(assets[1]?.key ?? assets[0]?.key ?? '')
  const [amount, setAmount] = useState('')
  const [slip, setSlip] = useState(2) // percent, one of the presets
  const [customSlip, setCustomSlip] = useState('') // overrides the preset when set
  const [details, setDetails] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hash, setHash] = useState<string | null>(null)
  const [outMsg, setOutMsg] = useState<string | null>(null)
  // Live output estimate (base units). null = not priced; `noRoute` separates "we
  // asked and there is no pool" from "we have not asked yet".
  const [quote, setQuote] = useState<ethers.BigNumber | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [noRoute, setNoRoute] = useState(false)
  const [reQuote, setReQuote] = useState(0)
  // Relayer fee for the leg the vault charges it on, in that leg's base units.
  const [relayFee, setRelayFee] = useState<{ amount: ethers.BigNumber; asset: AssetMeta } | null>(
    null,
  )

  const from = assets.find((a) => a.key === fromKey) ?? assets[0]
  const to = assets.find((a) => a.key === toKey) ?? assets[1] ?? assets[0]
  const fromNotes = shielded.get(from?.key ?? '')
  const toNotes = shielded.get(to?.key ?? '')

  const enabled = isSwapEnabled()
  // A swap is ALWAYS relayed — self-submitting would put the user's address on-chain
  // next to their nullifiers — so an unset relayer is as blocking as an unset router.
  const relayed = relayerEnabled()

  // An asset that is depositable but has no pool here yet is shown greyed in both
  // pickers, never selectable. It is a real quote asset everywhere else in the app,
  // so the gate lives in this screen rather than on the asset.
  const gated = (a: AssetMeta) => !!a.swapAfterMigration

  // The vault only lets a quote cross its boundary, so a memecoin can only be swapped
  // against a quote — never memecoin → memecoin. When the input isn't a quote, the
  // output is forced to a quote and the picker below is filtered to match.
  const outMustBeQuote = !!from && !isQuoteAsset(from)
  const toOptions = outMustBeQuote ? assets.filter((a) => isQuoteAsset(a)) : assets

  // Keep the selection legal: if the input becomes a memecoin while the output is one
  // too, snap the output to the first available quote (skipping the input itself).
  useEffect(() => {
    if (!outMustBeQuote || !to || isQuoteAsset(to)) return
    // Skip the gated ones: this snap picks the output FOR the user, so it must never
    // land on an asset they are not allowed to pick themselves.
    const q = toOptions.find((a) => a.key !== from?.key && !gated(a))
    if (q) setToKey(q.key)
  }, [outMustBeQuote, to?.key, from?.key])

  // Different from/to; not a forbidden memecoin → memecoin; neither leg awaiting a pool.
  const validPair =
    !!from &&
    !!to &&
    from.key !== to.key &&
    (isQuoteAsset(from) || isQuoteAsset(to)) &&
    !gated(from) &&
    !gated(to)

  // A dust ETH swap can't cover the relayer fee (the vault reverts with "ext amount
  // must exceed fee") — block it up-front rather than after a 20s proof.
  const belowMin = !!from && belowSwapMin(from, amount)

  const amountIn = from ? parseAmount(amount, from.decimals) : null

  /* ---------------- the spend ceiling ---------------------------------------
     `balance` is what the user owns; `spendable` is what ONE transaction can move.
     The circuit takes exactly 2 inputs against a single root, so a spend reaches at
     most the 2 largest notes of one tree. Offering the balance dead-ends the user on
     "spread across more than one batch" after the proof, so MAX offers the ceiling —
     minus the relayer fee, which is debited from the same input note when the input
     leg is a quote and would otherwise make every MAX swap fail. */
  const ceiling = fromNotes
    ? fromNotes.spendable.gt(0)
      ? fromNotes.spendable
      : fromNotes.balance
    : null
  const feeOnInput =
    from && isQuoteAsset(from) && relayFee?.asset.key === from.key ? relayFee.amount : Zero
  const maxIn = ceiling ? (ceiling.gt(feeOnInput) ? ceiling.sub(feeOnInput) : Zero) : null
  const overCeiling = !!(amountIn && ceiling && amountIn.gt(ceiling))

  function flip() {
    // The output can only ever become the input if it is itself swappable — the picker
    // and the snap effect both refuse a gated asset, and flipping must not smuggle one
    // into the input leg behind their backs.
    if (!from || !to || gated(to)) return
    setFromKey(to.key)
    setToKey(from.key)
    setAmount('')
  }

  // Effective slippage (custom overrides the preset), as bps, capped at 50%.
  const slipBps = useMemo(() => {
    const pct = customSlip.trim() !== '' ? Number(customSlip) : slip
    if (!isFinite(pct) || pct < 0) return 0
    return Math.min(5000, Math.round(pct * 100))
  }, [customSlip, slip])

  const minOut = quote && quote.gt(0) ? quote.mul(10_000 - slipBps).div(10_000) : null

  // Live estimate: re-quote (debounced) whenever the amount or the pair changes, and
  // abandon the in-flight answer when they change again — a late resolution from the
  // previous pair would otherwise overwrite the current one.
  useEffect(() => {
    setQuote(null)
    setNoRoute(false)
    if (!amountIn || !validPair || !from || !to) {
      setQuoting(false)
      return
    }
    let cancelled = false
    setQuoting(true)
    const id = setTimeout(async () => {
      try {
        const out = await quoteAmountOut(from, to, amountIn)
        if (cancelled) return
        setQuote(out)
        // quoteAmountOut returns null when nothing can price the pair. That is a
        // state of its own ("no route"), not a failure to show as an error.
        setNoRoute(out === null)
      } catch {
        if (!cancelled) {
          setQuote(null)
          setNoRoute(true)
        }
      } finally {
        if (!cancelled) setQuoting(false)
      }
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
  }, [amount, from?.key, to?.key, from?.decimals, validPair, reQuote])

  // The relayer fee rides on whichever leg is a quote: the input when selling a quote,
  // the proceeds when selling a memecoin (exactly one of the two must be zero or
  // executeSwap reverts). Mirrors `swap()` so the number shown is the number charged.
  useEffect(() => {
    if (!from || !to || !relayed) {
      setRelayFee(null)
      return
    }
    const leg = isQuoteAsset(from) ? from : to
    let alive = true
    relayInfo()
      .then((info) => {
        if (alive) setRelayFee({ amount: feeForAsset(info, leg.assetId), asset: leg })
      })
      .catch(() => {
        // Relayer unreachable: show "—" rather than blocking the flow. The fee is
        // re-quoted at submit anyway, and a stale one would be rejected there.
        if (alive) setRelayFee(null)
      })
    return () => {
      alive = false
    }
  }, [from?.key, to?.key, relayed])

  const setCustom = (v: string) => {
    // digits + one dot, capped at 50%
    const clean = v.replace(/[^0-9.]/g, '')
    if (clean === '' || (Number(clean) <= 50 && /^\d*\.?\d*$/.test(clean))) setCustomSlip(clean)
  }

  /* ---------------- protocol fee -------------------------------------------
     The vault takes `swapBps` off the swap (SherwoodVault.executeSwap), charged on the
     quote leg and only when a recipient is configured — same condition `routedAmountIn`
     applies. The estimate above is already net of it, so this row explains the gap
     rather than adding to it. */
  const protocolBps = DEPLOYMENT.protocolFee?.swapBps ?? 0
  const protocolFeeApplies =
    protocolBps > 0 && (DEPLOYMENT.protocolFee?.recipient ?? ZERO) !== ZERO

  // 1 from ≈ n to, read off the live estimate rather than a spot price, so it carries
  // the same price impact the user is actually going to get.
  const rate = useMemo(() => {
    if (!quote || !amountIn || !from || !to) return null
    const inHuman = Number(ethers.utils.formatUnits(amountIn, from.decimals))
    const outHuman = Number(ethers.utils.formatUnits(quote, to.decimals))
    if (!inHuman || !isFinite(outHuman)) return null
    return (outHuman / inHuman).toLocaleString('en-US', { maximumFractionDigits: 6 })
  }, [quote, amountIn, from?.key, to?.key])

  async function submit() {
    if (!signer || !keys || !from || !to) return
    setError(null)
    setHash(null)
    setOutMsg(null)
    setStatus(null)
    setBusy(true)
    try {
      if (from.key !== to.key && !isQuoteAsset(from) && !isQuoteAsset(to))
        throw new Error('A memecoin can only be swapped against a quote asset (ETH or USDG).')
      if (!validPair) throw new Error('Pick two different assets')
      const inAmount = parseAmount(amount, from.decimals)
      if (!inAmount) throw new Error('Enter an amount')
      if (belowSwapMin(from, amount))
        throw new Error(
          `Minimum swap is ${MIN_SWAP_ETH} ETH — a smaller amount can't cover the relayer's fee.`,
        )

      // Turn the live estimate + slippage into a real minOut floor. If we couldn't
      // price the pair, fall back to 0 so the swap still goes through (accepts any
      // output) rather than blocking on a missing estimate.
      const floor = quote && quote.gt(0) ? quote.mul(10_000 - slipBps).div(10_000) : Zero

      setStatus('Finding the deepest pool…')
      // Pass amounts so a V4 route (which embeds them, unlike V2/V3) can be built.
      const route = await resolveRoute(from, to, inAmount, floor)

      const res = await swap(signer, keys, { from, to, amountIn: inAmount, minOut: floor, route }, setStatus)
      setHash(res.txHash)
      const outHuman = Number(ethers.utils.formatUnits(res.amountOut, to.decimals)).toLocaleString(
        'en-US',
        { maximumFractionDigits: 6 },
      )
      setOutMsg(`Received ${outHuman} ${to.symbol} (private note)`)
      pushActivity({
        kind: 'swap',
        label: 'Swap',
        delta: `${from.symbol} → ${to.symbol}`,
        positive: true,
        hash: res.txHash,
      })
      setAmount('')
    } catch (e: unknown) {
      setError(cleanSwapError(errText(e)))
    } finally {
      setBusy(false)
      setStatus(null)
    }
  }

  if (!from || !to) return null

  const preparing = signingIn || !keys
  const blocked = !enabled || !relayed
  const ctaLabel = preparing
    ? 'Preparing your account'
    : belowMin
      ? `Minimum ${MIN_SWAP_ETH} ETH`
      : validPair
        ? `Swap ${from.symbol} → ${to.symbol}`
        : 'Select two assets'

  return (
    <div>
      <ScreenHeader
        title="Swap"
        subtitle="Trade one shielded note for another. Your address never appears on-chain."
        icon={<SwapArrows width={16} height={16} />}
      />

      <div className="card mt-3">
        {/* ---- from leg ---- */}
        <div className="inset px-3 py-2.5">
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="shrink-0 font-semibold text-moss">From</span>
            <span className="flex min-w-0 items-center gap-1 text-muted">
              <span className="shrink-0">Shielded</span>
              <span className="num truncate text-[11px] !text-mint">
                {fromNotes ? fmtUnits(fromNotes.balance, from.decimals) : '—'}
              </span>
              {maxIn && maxIn.gt(0) && (
                <button
                  className="max-btn ml-1 shrink-0"
                  onClick={() => setAmount(fmtUnits(maxIn, from.decimals))}
                >
                  MAX
                </button>
              )}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <input
              className="num min-w-0 flex-1 bg-transparent text-[22px] font-semibold outline-none placeholder:text-muted/40"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <div className="w-[7rem] shrink-0">
              <TokenPicker
                label="Asset to sell"
                assets={assets}
                value={from.key}
                onChange={setFromKey}
                isDisabled={(a) => gated(a) || a.key === to.key}
                subtitle={(a) => {
                  const s = shielded.get(a.key)
                  return s ? fmtUnits(s.balance, a.decimals) : null
                }}
              />
            </div>
          </div>
        </div>

        {/* ---- flip ----
            btn-primary carries the ledge and the on-mint ink colour, so the button can
            overlap both legs without re-declaring either. */}
        <div className="relative z-10 -my-2.5 flex justify-center">
          <button
            onClick={flip}
            title="Flip the pair"
            aria-label="Flip the pair"
            disabled={gated(to)}
            className="btn-primary grid h-8 w-8 place-items-center rounded-lg border-2 border-panel px-0 py-0"
          >
            <ArrowDown width={16} height={16} />
          </button>
        </div>

        {/* ---- to leg ---- */}
        <div className="inset px-3 py-2.5">
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="shrink-0 font-semibold text-moss">To</span>
            <span className="flex min-w-0 items-center gap-1 text-muted">
              <span className="shrink-0">Shielded</span>
              <span className="num truncate text-[11px] !text-mint">
                {toNotes ? fmtUnits(toNotes.balance, to.decimals) : '—'}
              </span>
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <div className="num min-w-0 flex-1 truncate text-[22px] font-semibold !text-muted/60">
              {!amountIn || !validPair
                ? '0.00'
                : quoting
                  ? '…'
                  : quote
                    ? `≈ ${fmtOut(quote, to.decimals)}`
                    : '≈ —'}
            </div>
            <div className="w-[7rem] shrink-0">
              <TokenPicker
                label="Asset to buy"
                assets={toOptions}
                value={to.key}
                onChange={setToKey}
                isDisabled={(a) => gated(a) || a.key === from.key}
                subtitle={(a) => {
                  const s = shielded.get(a.key)
                  return s ? fmtUnits(s.balance, a.decimals) : null
                }}
              />
            </div>
          </div>
        </div>

        {outMustBeQuote && (
          <p className="mt-2 text-[11px] leading-snug text-muted">
            {from.symbol} is a memecoin — it can only be swapped into a quote asset (ETH or USDG).
          </p>
        )}

        {/* ---- slippage: 2 / 5 / custom ---- */}
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold text-moss">Slippage</span>
          <div className="flex items-center gap-1">
            {SLIPPAGE_PRESETS.map((s) => {
              const on = customSlip.trim() === '' && slip === s
              return (
                <button
                  key={s}
                  onClick={() => {
                    setSlip(s)
                    setCustomSlip('')
                  }}
                  className={`press rounded-lg border px-2 py-1 text-[11px] font-bold ${
                    on
                      ? 'border-mint bg-mint/20 text-mintBright'
                      : 'border-edge text-muted hover:border-edgeLit hover:text-white'
                  }`}
                >
                  {s}%
                </button>
              )
            })}
            <div
              className={`flex items-center rounded-lg border px-1.5 py-1 text-[11px] font-bold transition ${
                customSlip.trim() !== '' ? 'border-mint text-mintBright' : 'border-edge text-muted'
              }`}
            >
              <input
                className="w-9 bg-transparent text-right outline-none placeholder:text-muted/50"
                inputMode="decimal"
                placeholder="Custom"
                value={customSlip}
                onChange={(e) => setCustom(e.target.value)}
              />
              <span className="pl-0.5">%</span>
            </div>
          </div>
        </div>

        {/* ---- the quote, and everything that explains it ----
            Minimum received is the one number that changes what the user gets, so it
            stays out; the rate and the two fees fold away — at 360px they would push
            the CTA under the fold on every render, quoted or not. */}
        {(quote || noRoute || quoting) && (
          <div className="mt-3 rounded-xl border border-edge bg-ink/50 px-3 py-1.5">
            <InfoRow
              label="Minimum received"
              value={
                minOut ? (
                  `${fmtOut(minOut, to.decimals)} ${to.symbol}`
                ) : noRoute ? (
                  <span className="text-amber-200/90">no estimate</span>
                ) : (
                  '—'
                )
              }
            />
            <div className="flex items-center justify-between gap-2">
              <button
                onClick={() => setDetails((v) => !v)}
                className="flex min-w-0 items-center gap-1 py-1 text-[11px] text-moss transition hover:text-white"
              >
                Rate and fees
                <ChevronDown
                  width={11}
                  height={11}
                  className={`transition-transform ${details ? 'rotate-180' : ''}`}
                />
              </button>
              {/* A popup can sit open for minutes on a quote that has moved. */}
              <button
                onClick={() => setReQuote((n) => n + 1)}
                aria-label="Refresh the quote"
                title="Refresh the quote"
                className="press grid h-5 w-5 shrink-0 place-items-center rounded-md border border-edge text-muted transition hover:border-edgeLit hover:text-white"
              >
                <Refresh width={10} height={10} className={quoting ? 'animate-spin' : undefined} />
              </button>
            </div>
            {details && (
              <div className="border-t border-edge/60 pb-0.5 pt-1">
                <InfoRow
                  label="Rate"
                  value={rate ? `1 ${from.symbol} ≈ ${rate} ${to.symbol}` : '—'}
                />
                {protocolFeeApplies && (
                  <InfoRow label="Protocol fee" value={`${(protocolBps / 100).toFixed(2)}%`} />
                )}
                <InfoRow
                  label="Relayer fee"
                  value={
                    relayFee
                      ? `${fmtUnits(relayFee.amount, relayFee.asset.decimals)} ${relayFee.asset.symbol}`
                      : '—'
                  }
                />
              </div>
            )}
          </div>
        )}

        {/* ---- warnings ---- */}
        {blocked && (
          <Warning>
            {!enabled
              ? 'Swaps need the SwapLogic proxy and a Uniswap router wired in deployment.json.'
              : 'Swaps are submitted through the relayer, which is not configured in this build.'}
          </Warning>
        )}

        {belowMin && (
          <Warning>
            Minimum swap is {MIN_SWAP_ETH} ETH — a smaller amount can&apos;t cover the relayer&apos;s
            fee.
          </Warning>
        )}

        {/* One transaction reaches the 2 largest notes of a single tree, so a balance
            held in more notes cannot be sold in one go. Say so before the proof rather
            than dead-ending on it after 20 seconds of work. */}
        {overCeiling && ceiling && fromNotes && (
          <Warning>
            Held in {fromNotes.count} notes — one swap can spend at most{' '}
            {fmtUnits(ceiling, from.decimals)} {from.symbol}. Sell that much now, then repeat for
            the rest.
          </Warning>
        )}

        {/* Not an error: a pair with no quoter and no readable pool state still has a
            route often enough that the web app submits anyway, with minOut = 0. Say
            what that costs — an unpriced swap has no slippage floor — and leave the
            decision where the web app leaves it. */}
        {noRoute && !quoting && (
          <Warning>
            No pool prices {from.symbol} → {to.symbol} right now. You can still submit, but
            without an estimate the swap accepts any output — there is no slippage floor.
          </Warning>
        )}

        <SubmitButton
          busy={busy}
          disabled={preparing || blocked || belowMin || !validPair}
          icon={<SwapArrows width={16} height={16} />}
          busyLabel="Working…"
          onClick={submit}
        >
          {ctaLabel}
        </SubmitButton>

        {/* Proving takes 10–30s and Chrome tears the popup down the moment it loses
            focus, so the way out has to be on screen while it happens. */}
        {busy && <ProvingNotice onExpand={expand} />}
        <StatusNote status={status} error={error} />
        {outMsg && <div className="mt-3 text-[12px] text-mint">{outMsg}</div>}
        {hash && <TxLink hash={hash} />}
      </div>
    </div>
  )
}

/** The amber "you can proceed, but read this first" note the flows share. */
function Warning({ children }: { children: ReactNode }) {
  return (
    <div className="mt-3 rounded-xl border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-amber-200/90">
      {children}
    </div>
  )
}
