/**
 * Deposit: move a plain wallet balance into the vault, where it becomes a note only
 * this account can spend.
 *
 * A port of the web app's DepositCard to a 360px popup. The protocol side is imported
 * verbatim — `deposit()` builds the proof and submits it — so what changes here is only
 * the shape: the two-column grid stacks, and the proving wait gets a warning it does not
 * need on a page that a stray click cannot close.
 */
import { useMemo, useState } from 'react'
import { ethers } from 'ethers'
import { deposit } from '@app/lib/actions'
import { MIN_NATIVE_ETH, belowNativeMin, isNativeAsset, isQuoteAsset } from '@app/config'
import { useAccountState } from '../state'
import { TokenPicker } from '../components/TokenPicker'
import {
  ArrowDown,
  EmptyNote,
  Field,
  ProvingNotice,
  ScreenHeader,
  StatusNote,
  SubmitButton,
  TxLink,
} from '../components/ui'

// MAX on native ETH leaves a little behind for gas: a deposit is self-submitted, so
// filling the whole balance would leave nothing to pay the deposit tx's own gas.
const GAS_RESERVE_ETH = '0.0001'

export function Deposit() {
  const {
    signer,
    keys,
    signingIn,
    assets,
    asset: selected,
    selectAsset,
    walletBalanceOf,
    shieldedBalanceOf,
    pushActivity,
    expand,
  } = useAccountState()

  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hash, setHash] = useState<string | null>(null)

  // Only quote assets may enter or leave the vault at all, which is why the web app hands
  // this card its QUOTE_ASSETS list rather than every asset. The popup shares one selected
  // asset across every screen, so a memecoin picked over in Swap has to fall back here
  // instead of offering a deposit the vault would refuse.
  const depositable = useMemo(() => assets.filter(isQuoteAsset), [assets])
  const asset = isQuoteAsset(selected) ? selected : (depositable[0] ?? selected)

  const wallet = walletBalanceOf(asset)
  const shielded = shieldedBalanceOf(asset)
  const empty = wallet !== null && Number(wallet) === 0

  function setMax() {
    if (!wallet) return
    if (!isNativeAsset(asset)) return setAmount(wallet)
    try {
      const bal = ethers.utils.parseUnits(wallet, asset.decimals)
      const reserve = ethers.utils.parseUnits(GAS_RESERVE_ETH, asset.decimals)
      const max = bal.gt(reserve) ? bal.sub(reserve) : ethers.constants.Zero
      setAmount(max.isZero() ? '' : ethers.utils.formatUnits(max, asset.decimals))
    } catch {
      setAmount(wallet)
    }
  }

  // Gate dust ETH deposits: below the minimum the note cannot cover the relayer's gas fee
  // when it is later spent, and the chain rejects it with an opaque error. Say so here
  // rather than after a proof the user waited half a minute for.
  const belowMin = belowNativeMin(asset, amount)
  // The note-spending keys are derived from a signature the local wallet makes on unlock.
  // Until they land there is nothing to encrypt the output note to, so the flow can't run.
  const ready = !!signer && !!keys

  async function submit() {
    if (!signer || !keys) return
    setError(null)
    setHash(null)
    setBusy(true)
    try {
      const value = ethers.utils.parseUnits(amount || '0', asset.decimals)
      if (value.lte(0)) throw new Error('Enter an amount')
      if (belowNativeMin(asset, amount)) throw new Error(`Minimum deposit is ${MIN_NATIVE_ETH} ETH.`)
      const h = await deposit(signer, asset, keys, value, setStatus)
      setHash(h)
      pushActivity({
        kind: 'deposit',
        label: 'Deposit',
        delta: `+ ${Number(amount).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${asset.symbol}`,
        positive: true,
        hash: h,
      })
      setAmount('')
    } catch (e: any) {
      setError(e?.reason || e?.message || String(e))
    } finally {
      setBusy(false)
      setStatus(null)
    }
  }

  return (
    <div className="space-y-3">
      <ScreenHeader
        title="Deposit"
        subtitle="Move funds from your wallet into the vault, where they become private."
        icon={<ArrowDown width={16} height={16} />}
      />

      <div className="card">
        <div className="space-y-3">
          <Field
            label="Asset"
            hint={
              <>
                Private balance <span className="font-mono text-mint">{shielded ?? '—'}</span>{' '}
                {asset.symbol}
              </>
            }
          >
            <TokenPicker
              assets={depositable}
              value={asset.key}
              onChange={selectAsset}
              label="Asset to deposit"
              subtitle={(a) => walletBalanceOf(a)}
            />
          </Field>

          <Field
            label="Amount"
            hint={
              <>
                Balance <span className="num">{wallet ?? '—'}</span> {asset.symbol}
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
              {wallet && (
                <button className="max-btn absolute right-3 top-1/2 -translate-y-1/2" onClick={setMax}>
                  MAX
                </button>
              )}
            </div>
          </Field>

          {empty && <EmptyNote>You don’t have any {asset.symbol} to deposit yet.</EmptyNote>}

          {belowMin && (
            <div className="rounded-xl border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-amber-200/90">
              Minimum deposit is {MIN_NATIVE_ETH} ETH.
            </div>
          )}
        </div>

        <SubmitButton
          busy={busy}
          disabled={belowMin || !ready}
          icon={<ArrowDown width={16} height={16} />}
          onClick={submit}
        >
          {signingIn ? 'Preparing your account' : 'Deposit'}
        </SubmitButton>

        {/* Proving takes 10–30s and Chrome tears the popup down the moment it loses focus,
            which throws away the half-built transaction. Offer the tab before that. */}
        {busy && <ProvingNotice onExpand={expand} />}
        <StatusNote status={status} error={error} />
        {hash && <TxLink hash={hash} />}
      </div>
    </div>
  )
}
