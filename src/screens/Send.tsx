/**
 * An ordinary transfer out of the plain wallet — the boring wallet function every other
 * wallet has, kept deliberately separate from Withdraw.
 *
 * Withdraw exits the pool and hides where the money came from; this signs a transfer in
 * the open, from this address, for anyone to read. Both move funds out, so the only
 * thing stopping someone reaching for the wrong one is the screen saying which is which.
 */
import { useCallback, useMemo, useState } from 'react'
import { ethers } from 'ethers'
import { ERC20_ABI } from '@app/lib/contracts/abis'
import { DEPLOYMENT, isNativeAsset } from '@app/config'
import { fmtUnits, useAccountState } from '../state'
import { TokenPicker } from '../components/TokenPicker'
import {
  ExternalLink,
  Field,
  InfoRow,
  ScreenHeader,
  StatusNote,
  SubmitButton,
  TxLink,
} from '../components/ui'

// The shared ABI is the read/approve surface the app needs elsewhere; it has no
// `transfer`, because nothing in the web app ever moves tokens in the clear. A plain
// send is the one flow that does, so it carries the one extra signature itself.
const TRANSFER_ABI = [...ERC20_ABI, 'function transfer(address to, uint256 amount) returns (bool)']

/** Gas held back from MAX on native ETH when the chain will not quote a price: enough
 *  for a 21k transfer at a generous price, and small enough not to strand real funds. */
const FALLBACK_GAS_RESERVE = '0.0002'

/** Matches the web app's history lines, so the two feeds read alike. */
function fmtDelta(amount: string, symbol: string) {
  const n = Number(amount)
  return `- ${n.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${symbol}`
}

export function Send() {
  const { signer, asset, assets, selectAsset, wallet, walletBalanceOf, nativeBalance, pushActivity, go } =
    useAccountState()

  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hash, setHash] = useState<string | null>(null)

  const balance = wallet.get(asset.key)?.token ?? null
  const native = isNativeAsset(asset)
  const recipient = to.trim()
  const recipientOk = ethers.utils.isAddress(recipient)
  const showRecipientError = recipient.length > 0 && !recipientOk

  // An ERC-20 transfer still costs gas in ETH, and running the token balance to zero
  // with an empty gas tank is a wallet that can no longer move anything.
  const noGas = !native && nativeBalance !== null && Number(nativeBalance) === 0

  const parsed = useMemo(() => {
    if (!amount.trim()) return null
    try {
      return ethers.utils.parseUnits(amount.trim(), asset.decimals)
    } catch {
      return null
    }
  }, [amount, asset.decimals])

  const overBalance = parsed !== null && balance !== null && parsed.gt(balance)

  // MAX on native ETH has to leave the transfer's own gas behind — this wallet submits
  // the transaction itself, so a balance sent down to zero could not pay for the send.
  // The reserve is quoted from the chain rather than guessed, because a fixed number is
  // either wasteful when gas is cheap or short when it is not.
  const setMax = useCallback(async () => {
    if (!balance) return
    if (!native) return setAmount(ethers.utils.formatUnits(balance, asset.decimals))
    let reserve = ethers.utils.parseUnits(FALLBACK_GAS_RESERVE, asset.decimals)
    try {
      if (signer) {
        // Twice a bare 21k transfer, so a base fee that ticks up between the quote and
        // the send does not turn MAX into a rejected transaction.
        reserve = (await signer.getGasPrice()).mul(21_000).mul(2)
      }
    } catch {
      /* no quote from the node — the fixed reserve above is the conservative answer */
    }
    const max = balance.gt(reserve) ? balance.sub(reserve) : ethers.constants.Zero
    setAmount(max.isZero() ? '' : ethers.utils.formatUnits(max, asset.decimals))
  }, [balance, native, asset.decimals, signer])

  async function submit() {
    if (!signer) return
    setError(null)
    setHash(null)
    setBusy(true)
    try {
      if (!recipientOk) throw new Error('Enter a valid recipient address.')
      if (parsed === null) throw new Error('Enter an amount to send.')
      if (parsed.lte(0)) throw new Error('Enter an amount to send.')
      if (balance !== null && parsed.gt(balance))
        throw new Error('That is more than this wallet holds.')

      setStatus('Submitting the transfer…')
      const tx = native
        ? await signer.sendTransaction({ to: recipient, value: parsed })
        : ((await new ethers.Contract(asset.token, TRANSFER_ABI, signer).transfer(
            recipient,
            parsed,
          )) as ethers.providers.TransactionResponse)

      setHash(tx.hash)
      setStatus('Waiting for the transaction to confirm…')
      await tx.wait(1)

      pushActivity({
        kind: 'send',
        label: 'Sent',
        delta: fmtDelta(amount.trim(), asset.symbol),
        positive: false,
        hash: tx.hash,
      })
      setAmount('')
      setTo('')
    } catch (e) {
      const err = e as { reason?: string; message?: string }
      setError(err.reason || err.message || String(e))
    } finally {
      setBusy(false)
      setStatus(null)
    }
  }

  return (
    <div className="space-y-3">
      <ScreenHeader
        title="Send"
        subtitle="A plain transfer from your wallet"
        icon={<ExternalLink width={16} height={16} />}
        onBack={() => go('home')}
      />

      <section className="card">
        <div className="space-y-3">
          <Field label="Asset">
            <TokenPicker
              assets={assets}
              value={asset.key}
              onChange={selectAsset}
              label="Asset to send"
              subtitle={(a) => walletBalanceOf(a)}
            />
          </Field>

          <Field
            label="Amount"
            hint={
              <>
                Wallet <span className="font-mono text-mint">{walletBalanceOf(asset) ?? '—'}</span>{' '}
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
              {balance !== null && !balance.isZero() && (
                <button className="max-btn absolute right-3 top-1/2 -translate-y-1/2" onClick={setMax}>
                  MAX
                </button>
              )}
            </div>
            {overBalance && (
              <p className="mt-1.5 text-[11px] text-neg">That is more than this wallet holds.</p>
            )}
            {native && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                MAX leaves a little {DEPLOYMENT.nativeCurrency.symbol} behind: this wallet
                submits the transfer itself, so it has to be able to pay the gas.
              </p>
            )}
          </Field>

          <Field label="Recipient">
            <input
              className="input font-mono text-[12px]"
              placeholder="0x…"
              spellCheck={false}
              autoComplete="off"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
            {showRecipientError && (
              <p className="mt-1 text-[11px] text-neg">That is not a valid address.</p>
            )}
          </Field>
        </div>

        <div className="mt-3 border-t border-edge pt-2">
          <InfoRow
            label="Wallet balance"
            value={`${balance ? fmtUnits(balance, asset.decimals) : '—'} ${asset.symbol}`}
          />
        </div>

        {noGas && (
          <p className="mt-2 text-[11px] leading-relaxed text-moss">
            This wallet holds no {DEPLOYMENT.nativeCurrency.symbol}. A token transfer still
            pays its gas in {DEPLOYMENT.nativeCurrency.symbol}, so send a little here first.
          </p>
        )}

        <SubmitButton
          busy={busy}
          busyLabel="Sending…"
          disabled={!signer || !recipientOk || parsed === null || parsed.lte(0) || overBalance}
          onClick={submit}
        >
          Send {asset.symbol}
        </SubmitButton>

        <StatusNote status={status} error={error} />
        {hash && <TxLink hash={hash} label="Transfer sent" />}
      </section>
    </div>
  )
}
