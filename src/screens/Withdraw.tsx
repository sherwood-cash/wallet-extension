/**
 * Withdraw: spend shielded notes out to any address, through the relayer.
 *
 * A port of the web app's WithdrawCard to a 360px popup. Everything that decides whether
 * an exit is possible — the relayer fee, the 2-note ceiling, the native minimum — is
 * imported from the same protocol code the site runs, so the two front-ends can never
 * disagree about what will prove.
 *
 * The web app's cross-chain (Relay bridge) leg is deliberately absent: it is commented
 * out there too, and a bridge quote does not belong in a popup that has to survive losing
 * focus mid-proof.
 */
import { useEffect, useMemo, useState } from 'react'
import { ethers } from 'ethers'
import { consolidate, withdraw } from '@app/lib/actions'
import { feeForAsset, relayInfo, relayerEnabled } from '@app/lib/relayer'
import {
  DEPLOYMENT,
  MIN_NATIVE_ETH,
  belowNativeMin,
  isNativeAsset,
  isQuoteAsset,
} from '@app/config'
import { fmtUnits, useAccountState } from '../state'
import { TokenPicker } from '../components/TokenPicker'
import {
  ArrowUp,
  Field,
  InfoRow,
  ProvingNotice,
  ScreenHeader,
  StatusNote,
  SubmitButton,
  TxLink,
} from '../components/ui'

export function Withdraw() {
  const {
    address,
    keys,
    signingIn,
    assets,
    asset: selected,
    selectAsset,
    shielded: summaries,
    pushActivity,
    expand,
  } = useAccountState()

  const [amount, setAmount] = useState('')
  const [recipient, setRecipient] = useState('')
  const [busy, setBusy] = useState(false)
  const [merging, setMerging] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hash, setHash] = useState<string | null>(null)

  // Quote assets are the only ones the vault lets out, and the relayer must be paid in the
  // note's own asset — a memecoin exit has no path at all. Mirrors the QUOTE_ASSETS list
  // the web app hands this card.
  const withdrawable = useMemo(() => assets.filter(isQuoteAsset), [assets])
  const asset = isQuoteAsset(selected) ? selected : (withdrawable[0] ?? selected)

  const summary = summaries.get(asset.key) ?? null
  const balance = summary ? fmtUnits(summary.balance, asset.decimals) : null
  // The most a SINGLE transaction can spend: the 2 largest notes of one tree. Below the
  // balance whenever it sits in 3+ notes.
  const spendable = summary ? fmtUnits(summary.spendable, asset.decimals) : null
  const noteCount = summary ? summary.count : null

  // Default the recipient to this wallet (until the user types their own).
  useEffect(() => {
    if (address && !recipient) setRecipient(address)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address])

  // The relayer publishes its fee per asset and re-quotes it against live gas at submit,
  // so read it here rather than caching it for the session.
  const [fee, setFee] = useState<ethers.BigNumber | null>(null)
  useEffect(() => {
    let alive = true
    setFee(null)
    void (async () => {
      try {
        const f = feeForAsset(await relayInfo(), asset.assetId)
        if (alive) setFee(f)
      } catch {
        // Relayer unreachable: leave the fee unknown rather than blocking the flow. MAX
        // falls back to the raw ceiling below, which is only ever too generous.
        if (alive) setFee(null)
      }
    })()
    return () => {
      alive = false
    }
  }, [asset.assetId])

  // The relayer fee is debited ON TOP of the amount — the recipient receives exactly what
  // is typed here — so the largest withdrawable amount is the ceiling MINUS that fee.
  // Filling MAX with the raw balance produced a value that could never be proven.
  //
  // The ceiling is NOT the balance either: a transaction spends at most the 2 largest
  // notes of one tree, so a balance held in 3+ notes cannot leave in one go. `spendable`
  // is recomputed on every scan, so a consolidation immediately raises it.
  const maxOut = useMemo(() => {
    const ceiling = spendable ?? balance
    if (!ceiling) return null
    if (!fee) return ceiling
    try {
      const bal = ethers.utils.parseUnits(ceiling, asset.decimals)
      const max = bal.gt(fee) ? bal.sub(fee) : ethers.constants.Zero
      return ethers.utils.formatUnits(max, asset.decimals)
    } catch {
      return ceiling
    }
  }, [spendable, balance, fee, asset.decimals])

  const value = useMemo(() => {
    try {
      const v = ethers.utils.parseUnits(amount || '0', asset.decimals)
      return v.gt(0) ? v : null
    } catch {
      return null
    }
  }, [amount, asset.decimals])

  const canRelay = relayerEnabled()
  // A dust ETH withdrawal can't cover the relayer's gas fee and reverts with an opaque
  // error — block it before submit and tell the user the minimum.
  const belowMin = belowNativeMin(asset, amount)
  const validRecipient = ethers.utils.isAddress(recipient)
  const ready = !!keys

  /* ---------------- consolidate (raise the 2-note ceiling) ---------------- */
  // Only offered when it would change anything: 3+ notes means the ceiling is below the
  // balance, and each merge turns the 2 largest into one, so repeating converges.
  const fragmented = noteCount !== null && noteCount > 2

  async function onConsolidate() {
    if (!keys) return
    setMerging(true)
    setError(null)
    setHash(null)
    try {
      const h = await consolidate(asset, keys, DEPLOYMENT.deployBlock, setStatus)
      setHash(h)
      // Report it like any other action so the balance/ceiling re-scan runs and MAX moves.
      // No delta: nothing left the vault, the notes were only merged.
      pushActivity({
        kind: 'withdraw',
        label: 'Consolidate notes',
        delta: `${asset.symbol} notes merged`,
        positive: false,
        hash: h,
      })
    } catch (e: any) {
      setError(e?.reason || e?.message || String(e))
    } finally {
      setMerging(false)
      setStatus(null)
    }
  }

  async function submit() {
    if (!keys) return
    setError(null)
    setHash(null)
    setBusy(true)
    try {
      const v = ethers.utils.parseUnits(amount || '0', asset.decimals)
      if (v.lte(0)) throw new Error('Enter an amount')
      if (belowNativeMin(asset, amount)) {
        throw new Error(
          `Minimum withdrawal is ${MIN_NATIVE_ETH} ETH — a smaller amount can't cover the relayer's gas fee.`,
        )
      }
      if (!ethers.utils.isAddress(recipient)) throw new Error('Enter a valid address')

      const h = await withdraw(asset, keys, v, recipient, DEPLOYMENT.deployBlock, setStatus)
      setHash(h)
      pushActivity({
        kind: 'withdraw',
        label: 'Withdraw',
        delta: `- ${Number(amount).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${asset.symbol}`,
        positive: false,
        hash: h,
      })
      setAmount('')
    } catch (e: any) {
      const raw = e?.reason || e?.message || String(e)
      // A bare simulation revert is opaque; for a native withdrawal the usual cause is a
      // too-small amount that can't cover the relayer fee — say so.
      setError(
        /simulation_reverted|reverted/i.test(raw) && isNativeAsset(asset)
          ? `Withdrawal was rejected by the network. If the amount is small, note the minimum is ${MIN_NATIVE_ETH} ETH — below that it can't cover the relayer's gas fee.`
          : raw,
      )
    } finally {
      setBusy(false)
      setStatus(null)
    }
  }

  return (
    <div className="space-y-3">
      <ScreenHeader
        title="Withdraw"
        subtitle="Send shielded funds to any address. The relayer submits it, so the exit is not tied to this wallet."
        icon={<ArrowUp width={16} height={16} />}
      />

      <div className="card">
        <div className="space-y-3">
          <Field label="Asset">
            <TokenPicker
              assets={withdrawable}
              value={asset.key}
              onChange={selectAsset}
              label="Asset to withdraw"
              subtitle={(a) => {
                const s = summaries.get(a.key)
                return s ? fmtUnits(s.balance, a.decimals) : null
              }}
            />
          </Field>

          <Field
            label="Amount"
            hint={
              <>
                Shielded <span className="font-mono text-mint">{balance ?? '—'}</span>{' '}
                {asset.symbol}
              </>
            }
          >
            <div className="relative">
              <input
                className="input pr-16 font-mono text-[15px]"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              {balance && (
                <button
                  className="max-btn absolute right-3 top-1/2 -translate-y-1/2"
                  onClick={() => setAmount(maxOut ?? balance)}
                >
                  MAX
                </button>
              )}
            </div>
            {/* The balance above is real, but it is not all reachable at once: a
                transaction spends at most the 2 largest notes. Say so where the number
                is, and offer the way out inline rather than as an error after the fact. */}
            {fragmented && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                Held in {noteCount} notes — one withdrawal can send at most{' '}
                <span className="font-mono">{spendable ?? '—'}</span> {asset.symbol}.{' '}
                <button
                  className="underline underline-offset-2 hover:text-mint disabled:opacity-50"
                  onClick={onConsolidate}
                  disabled={merging || busy}
                >
                  {merging ? 'Consolidating…' : 'Consolidate'}
                </button>
              </p>
            )}
          </Field>

          <Field label="Recipient">
            <div className="relative">
              <input
                className="input pr-16 font-mono text-[12px]"
                placeholder="0x…"
                spellCheck={false}
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
              />
              {address && recipient.toLowerCase() !== address.toLowerCase() && (
                <button
                  className="max-btn absolute right-3 top-1/2 -translate-y-1/2"
                  onClick={() => setRecipient(address)}
                >
                  MINE
                </button>
              )}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
              Sent to this address. Leftover funds stay private as a change note.
            </p>
            {recipient !== '' && !validRecipient && (
              <p className="mt-1 text-[11px] text-neg">That is not a valid address.</p>
            )}
          </Field>

          {/* The fee rides ON TOP of the amount: the recipient is paid in full and the
              vault reimburses the relayer out of the same spend, so the balance moves by
              the total below — not by what was typed. */}
          {fee && (
            <div className="inset px-3 py-1.5">
              <InfoRow label="Relayer fee" value={`${fmtUnits(fee, asset.decimals)} ${asset.symbol}`} />
              <InfoRow
                label="Recipient receives"
                value={value ? `${fmtUnits(value, asset.decimals)} ${asset.symbol}` : '—'}
              />
              <InfoRow
                label="Taken from your balance"
                value={value ? `${fmtUnits(value.add(fee), asset.decimals)} ${asset.symbol}` : '—'}
              />
            </div>
          )}

          {!canRelay && (
            <div className="rounded-xl border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-amber-200/90">
              Relayer not configured — withdrawals need a relayer so the gas payer and timing
              don’t deanonymise the exit. Set deployment.relayerUrl.
            </div>
          )}

          {belowMin && (
            <div className="rounded-xl border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-amber-200/90">
              Minimum withdrawal is {MIN_NATIVE_ETH} ETH — a smaller amount can’t cover the
              relayer’s gas fee.
            </div>
          )}
        </div>

        <SubmitButton
          busy={busy}
          disabled={merging || !canRelay || belowMin || !ready}
          icon={<ArrowUp width={16} height={16} />}
          onClick={submit}
        >
          {signingIn ? 'Preparing your account' : 'Withdraw privately'}
        </SubmitButton>

        {/* Proving takes 10–30s and Chrome tears the popup down the moment it loses focus,
            which throws away the half-built transaction. Offer the tab before that. */}
        {(busy || merging) && <ProvingNotice onExpand={expand} />}
        <StatusNote status={status} error={error} />
        {hash && <TxLink hash={hash} />}
      </div>
    </div>
  )
}
