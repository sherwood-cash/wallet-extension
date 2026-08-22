/**
 * First run: there is no keystore on this device, so the popup is one of three things
 * at a time — a choice, a create flow, or an import flow. They live in one component
 * because they share a password field, an error slot and a back arrow, and splitting
 * them into three files would mean lifting all of that into a fourth.
 *
 * The create flow has a step the import flow does not: the recovery phrase is shown
 * once, behind a checkbox, and the wallet is only opened after that checkbox is
 * ticked. See `useVault().activate()` for why that is a separate call.
 */
import { useCallback, useState, type ReactNode } from 'react'
import { Copy, Eye, EyeOff, ScreenHeader, StatusNote, SubmitButton } from '../components/ui'
import { MIN_PASSWORD_LENGTH, validatePassword } from '../wallet/vault'
import { useVault } from '../wallet/useVault'

type Step = 'choose' | 'create' | 'phrase' | 'import'

export function Onboarding() {
  const vault = useVault()
  const [step, setStep] = useState<Step>('choose')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [secret, setSecret] = useState('')
  const [mnemonic, setMnemonic] = useState('')
  const [saved, setSaved] = useState(false)
  /** Client-side complaints (too short, no match) that never reach the vault. */
  const [invalid, setInvalid] = useState<string | null>(null)

  // Editing a field retracts the complaint about it — a "too short" note that outlives
  // the password it described reads as the form being stuck.
  const editPassword = useCallback((v: string) => {
    setPassword(v)
    setInvalid(null)
  }, [])
  const editConfirm = useCallback((v: string) => {
    setConfirm(v)
    setInvalid(null)
  }, [])

  const back = useCallback(() => {
    setStep('choose')
    setPassword('')
    setConfirm('')
    setSecret('')
    setInvalid(null)
  }, [])

  const submitCreate = useCallback(async () => {
    const complaint = validatePassword(password, confirm)
    setInvalid(complaint)
    if (complaint) return
    try {
      setMnemonic(await vault.create(password))
      setStep('phrase')
    } catch {
      // `vault.error` already carries the sentence; staying put keeps the form filled.
    }
  }, [password, confirm, vault])

  const submitImport = useCallback(async () => {
    const complaint = validatePassword(password, confirm)
    setInvalid(complaint)
    if (complaint) return
    try {
      await vault.importSecret(secret, password)
    } catch {
      /* same as above — the vault owns the message */
    }
  }, [secret, password, confirm, vault])

  const error = invalid ?? vault.error
  const pct = Math.round(vault.progress * 100)

  if (step === 'choose')
    return (
      <Frame>
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <Mark />
          <p className="mt-5 text-[13px] leading-relaxed text-muted">
            A private wallet for the Sherwood pools. The key is generated on this device and
            encrypted with a password only you know.
          </p>
        </div>
        <div className="mt-6 space-y-2.5">
          <button className="btn-cta" onClick={() => setStep('create')}>
            Create a new wallet
          </button>
          <button className="btn-ghost w-full py-3" onClick={() => setStep('import')}>
            Import an existing wallet
          </button>
          <p className="pt-1 text-center text-[11px] leading-relaxed text-moss">
            Nothing leaves this browser. There is no account to recover from.
          </p>
        </div>
      </Frame>
    )

  if (step === 'create')
    return (
      <Frame>
        <ScreenHeader
          title="Create a wallet"
          subtitle="The password encrypts the key on this device. It cannot be reset."
          onBack={back}
        />
        <div className="card mt-4 space-y-3">
          <PasswordFields
            password={password}
            confirm={confirm}
            onPassword={editPassword}
            onConfirm={editConfirm}
            onSubmit={submitCreate}
          />
          <StatusNote error={error} />
        </div>
        <SubmitButton
          busy={vault.busy}
          busyLabel={`Encrypting ${pct}%`}
          disabled={!password || !confirm}
          onClick={submitCreate}
        >
          Create wallet
        </SubmitButton>
      </Frame>
    )

  if (step === 'phrase')
    return (
      <Frame>
        <ScreenHeader
          title="Your recovery phrase"
          subtitle="Twelve words, in this order. Written down, they are the only way back into this wallet."
        />
        <PhraseGrid mnemonic={mnemonic} />
        <label className="press mt-3 flex cursor-pointer items-start gap-2.5 rounded-xl border border-edge bg-panel2 px-3 py-2.5">
          <input
            type="checkbox"
            checked={saved}
            onChange={(e) => setSaved(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-mint"
          />
          <span className="text-[12px] leading-snug text-white/90">
            I have saved my recovery phrase somewhere safe
          </span>
        </label>
        <p className="mt-2 text-[11px] leading-relaxed text-moss">
          This screen will not come back on its own. You can read the phrase again from
          Settings, with your password.
        </p>
        <SubmitButton disabled={!saved} onClick={vault.activate}>
          Open my wallet
        </SubmitButton>
      </Frame>
    )

  return (
    <Frame>
      <ScreenHeader
        title="Import a wallet"
        subtitle="A 12 or 24 word recovery phrase, or a private key."
        onBack={back}
      />
      <div className="card mt-4 space-y-3">
        <div>
          <span className="label">Recovery phrase or private key</span>
          <textarea
            className="input min-h-[88px] resize-none font-mono text-[12px] leading-relaxed"
            placeholder="word word word… or 0x…"
            spellCheck={false}
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </div>
        <PasswordFields
          password={password}
          confirm={confirm}
          onPassword={editPassword}
          onConfirm={editConfirm}
          onSubmit={submitImport}
        />
        <StatusNote error={error} />
      </div>
      <SubmitButton
        busy={vault.busy}
        busyLabel={`Encrypting ${pct}%`}
        disabled={!secret.trim() || !password || !confirm}
        onClick={submitImport}
      >
        Import wallet
      </SubmitButton>
    </Frame>
  )
}

/** The onboarding shell. Every step is a column that fills the popup and scrolls on
 *  its own, so nothing shifts as steps swap a field in or out. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto overflow-x-hidden px-4 py-5">
      {children}
    </div>
  )
}

/** The Sherwood mark at first-run size. Same treatment as the header wordmark — the
 *  bundled webp and Cinzel — just larger, since this screen is all it has to hold. */
function Mark() {
  return (
    <div className="flex flex-col items-center gap-3">
      <img src="./parallax/logo-mark.webp" alt="" width={64} height={64} className="rounded-2xl" />
      <span
        className="text-[26px] font-semibold tracking-wide text-mint"
        style={{ fontFamily: "'Cinzel', Georgia, serif" }}
      >
        Sherwood
      </span>
    </div>
  )
}

/** Password + confirm, sharing one reveal toggle. Both are `type=password` until the
 *  eye is clicked: a popup is often opened in a room with other people in it. */
function PasswordFields({
  password,
  confirm,
  onPassword,
  onConfirm,
  onSubmit,
}: {
  password: string
  confirm: string
  onPassword: (v: string) => void
  onConfirm: (v: string) => void
  onSubmit: () => void
}) {
  const [shown, setShown] = useState(false)
  return (
    <>
      <div>
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
          autoComplete="new-password"
          placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
          value={password}
          onChange={(e) => onPassword(e.target.value)}
        />
      </div>
      <div>
        <span className="label">Confirm password</span>
        <input
          className="input"
          type={shown ? 'text' : 'password'}
          autoComplete="new-password"
          placeholder="Type it again"
          value={confirm}
          onChange={(e) => onConfirm(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
        />
      </div>
    </>
  )
}

/** The phrase itself: numbered, monospaced, three to a row so twelve words fit the
 *  360px popup without wrapping mid-word or scrolling sideways. */
function PhraseGrid({ mnemonic }: { mnemonic: string }) {
  const [copied, setCopied] = useState(false)
  const words = mnemonic.split(' ')

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(mnemonic)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }, [mnemonic])

  return (
    <div className="panel mt-4 p-3">
      <div className="grid grid-cols-3 gap-1.5">
        {words.map((word, i) => (
          <div
            key={`${i}-${word}`}
            className="flex items-baseline gap-1 rounded-lg border border-edge bg-ink px-1.5 py-1.5"
          >
            <span className="w-3 shrink-0 text-right font-mono text-[9px] tabular-nums text-moss">
              {i + 1}
            </span>
            <span className="min-w-0 truncate font-mono text-[11.5px] text-white">{word}</span>
          </div>
        ))}
      </div>
      <button
        onClick={copy}
        className="press mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-xl border border-edge bg-panel2 py-2 text-[12px] font-semibold text-white transition hover:border-edgeLit"
      >
        <Copy width={13} height={13} className="text-muted" />
        {copied ? 'Copied to the clipboard' : 'Copy phrase'}
      </button>
    </div>
  )
}
