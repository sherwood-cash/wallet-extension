/**
 * There is a keystore on this device but no live session key, so the only thing this
 * screen can do is take a password and run scrypt against the ciphertext.
 *
 * Two details are load-bearing. The unlock button counts up: at N = 2^15 the decrypt
 * takes a couple of seconds, and a button that just sits there reads as a crash. And
 * "forget this wallet" asks twice — it is the one irreversible action in the popup,
 * and the popup is a place people click quickly.
 */
import { useCallback, useState } from 'react'
import { Eye, EyeOff, Spinner } from '../components/ui'
import { useVault } from '../wallet/useVault'

const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`

export function Unlock() {
  const vault = useVault()
  const [password, setPassword] = useState('')
  const [shown, setShown] = useState(false)
  const [confirmingWipe, setConfirmingWipe] = useState(false)

  const submit = useCallback(() => {
    if (!password || vault.busy) return
    void vault.unlock(password).catch(() => {
      // The vault owns the message. Clearing the field means the next attempt starts
      // clean rather than by editing a password that has already been rejected.
      setPassword('')
    })
  }, [password, vault])

  const pct = Math.round(vault.progress * 100)

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto overflow-x-hidden px-4 py-5">
      <div className="flex flex-1 flex-col items-center justify-center text-center">
        <img src="./parallax/logo-mark.webp" alt="" width={56} height={56} className="rounded-2xl" />
        <span
          className="mt-3 text-[22px] font-semibold tracking-wide text-mint"
          style={{ fontFamily: "'Cinzel', Georgia, serif" }}
        >
          Sherwood
        </span>
        {vault.address && (
          <span className="mt-3 rounded-lg border border-edge bg-panel2 px-2.5 py-1 font-mono text-[11px] text-white/85">
            {short(vault.address)}
          </span>
        )}
      </div>

      <form
        className="mt-6"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="label">Password</span>
          <button
            type="button"
            onClick={() => setShown((s) => !s)}
            className="mb-1.5 flex items-center gap-1 text-[11px] text-muted transition hover:text-white"
          >
            {shown ? <EyeOff width={12} height={12} /> : <Eye width={12} height={12} />}
            {shown ? 'Hide' : 'Show'}
          </button>
        </div>
        <input
          className="input"
          type={shown ? 'text' : 'password'}
          autoFocus
          autoComplete="current-password"
          placeholder="Unlock this wallet"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {vault.error && (
          <div className="mt-3 break-words rounded-xl border border-neg/40 bg-neg/10 px-3 py-2.5 text-[12px] leading-snug text-neg">
            {vault.error}
          </div>
        )}

        <button className="btn-cta mt-4" type="submit" disabled={vault.busy || !password}>
          {vault.busy ? (
            <>
              <Spinner size={16} />
              Unlocking {pct}%
            </>
          ) : (
            'Unlock'
          )}
        </button>
      </form>

      <div className="mt-5 text-center">
        {confirmingWipe ? (
          <div className="space-y-2.5">
            <p className="text-[11.5px] leading-relaxed text-neg">
              This deletes the encrypted key from this browser. Your recovery phrase is the
              only way back to the account and anything held in it.
            </p>
            <div className="flex gap-2">
              <button
                className="btn-ghost flex-1"
                onClick={() => setConfirmingWipe(false)}
                disabled={vault.busy}
              >
                Keep it
              </button>
              <button
                className="btn-danger flex-1"
                onClick={() => void vault.wipe().catch(() => setConfirmingWipe(false))}
                disabled={vault.busy}
              >
                Remove wallet
              </button>
            </div>
          </div>
        ) : (
          <button
            className="text-[11.5px] text-moss underline underline-offset-4 transition hover:text-muted"
            onClick={() => setConfirmingWipe(true)}
          >
            Forget this wallet
          </button>
        )}
      </div>
    </div>
  )
}
