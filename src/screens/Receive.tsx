/**
 * The wallet's own address, so funds can be sent in from an exchange or another wallet.
 *
 * This screen has one job beyond showing 42 characters: making it unmistakable that the
 * address is PUBLIC. Everything arriving here is visible on-chain to anyone watching,
 * and only becomes private once it is deposited into the pool. A wallet whose whole
 * pitch is privacy has to be the one telling you that, plainly and up front.
 */
import { useCallback, useEffect, useState } from 'react'
import { useAccountState } from '../state'
import { Copy, ScreenHeader, Shield } from '../components/ui'

export function Receive() {
  const { address, go } = useAccountState()
  const [copied, setCopied] = useState(false)

  const copy = useCallback(() => {
    if (!address) return
    void navigator.clipboard.writeText(address)
    setCopied(true)
  }, [address])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(t)
  }, [copied])

  return (
    <div className="space-y-3">
      <ScreenHeader
        title="Receive"
        subtitle="Your wallet address on Sherwood"
        onBack={() => go('home')}
      />

      <section className="card">
        <span className="label">Address</span>
        {/* Broken across lines rather than truncated: this is the one place the whole
            string has to be readable, because it is what gets checked character by
            character against whatever is sending the funds. */}
        <p className="inset select-all break-all px-3 py-2.5 font-mono text-[12px] leading-relaxed text-white">
          {address ?? '—'}
        </p>
        <button className="btn-cta mt-3" onClick={copy} disabled={!address}>
          <Copy width={15} height={15} />
          {copied ? 'Copied to the clipboard' : 'Copy address'}
        </button>
      </section>

      <section className="rounded-xl border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2.5 text-[11.5px] leading-relaxed text-amber-200/90">
        <span className="font-semibold text-amber-200">This address is public.</span> Anything sent
        to it lands in the plain part of your wallet, where the amount and the sender are
        visible on the block explorer like any other transfer.
      </section>

      <section className="card">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-mint/35 bg-mint/10 text-mint">
            <Shield width={14} height={14} />
          </span>
          <div className="min-w-0 text-[11.5px] leading-relaxed text-muted">
            To make funds private, deposit them into the pool once they arrive. After that
            your balance is held as notes only you can spend, and no one can link it back to
            this address.
          </div>
        </div>
        <button className="btn-ghost mt-3 w-full" onClick={() => go('deposit')}>
          Go to deposit
        </button>
      </section>
    </div>
  )
}
