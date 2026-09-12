/**
 * The wallet's own address, so funds can be sent in from an exchange or another wallet.
 *
 * This screen has one job beyond showing 42 characters: making it unmistakable that the
 * address is PUBLIC. Everything arriving here is visible on-chain to anyone watching,
 * and only becomes private once it is deposited into the pool. A wallet whose whole
 * pitch is privacy has to be the one telling you that, plainly and up front.
 */
import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { useAccountState } from '../state'
import { Copy, ScreenHeader, Shield } from '../components/ui'

export function Receive() {
  const { address, go } = useAccountState()
  const [copied, setCopied] = useState(false)
  const [qr, setQr] = useState<string | null>(null)

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

  useEffect(() => {
    if (!address) {
      setQr(null)
      return
    }
    let alive = true
    QRCode.toDataURL(address, {
      margin: 1,
      width: 320,
      errorCorrectionLevel: 'M',
      color: { dark: '#0b0d0a', light: '#ffffff' },
    })
      .then((url) => {
        if (alive) setQr(url)
      })
      .catch(() => {
        if (alive) setQr(null)
      })
    return () => {
      alive = false
    }
  }, [address])

  return (
    <div className="space-y-3">
      <ScreenHeader
        title="Receive"
        onBack={() => go('home')}
      />

      <section className="card flex flex-col items-center">
        {/* The QR encodes the plain address — scan it from a phone or another wallet. */}
        <div className="rounded-2xl bg-white p-3 shadow-card">
          {qr ? (
            <img src={qr} alt="Wallet address QR code" width={188} height={188} className="block h-[188px] w-[188px]" />
          ) : (
            <div className="h-[188px] w-[188px] animate-pulse rounded-lg bg-black/10" />
          )}
        </div>
        <span className="label mt-3 self-start">Address</span>
        {/* Broken across lines rather than truncated: this is the one place the whole
            string has to be readable, because it is what gets checked character by
            character against whatever is sending the funds. */}
        <p className="inset w-full select-all break-all px-3 py-2.5 font-mono text-[12px] leading-relaxed text-white">
          {address ?? '—'}
        </p>
        <button className="btn-cta mt-3 w-full" onClick={copy} disabled={!address}>
          <Copy width={15} height={15} />
          {copied ? 'Copied to the clipboard' : 'Copy address'}
        </button>
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
