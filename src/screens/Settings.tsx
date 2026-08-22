/**
 * Everything about the wallet that is not a transaction: who it is, how to get back into
 * it, what chain it is pointed at, and how to remove it.
 *
 * The two destructive doors — revealing the recovery phrase and wiping the keystore —
 * are both behind a deliberate second step. Neither is rare enough to hide and neither
 * is safe enough to leave one click away.
 */
import { useCallback, useEffect, useState } from 'react'
import { DEPLOYMENT, EXPLORER } from '@app/config'
import { useAccountState } from '../state'
import { useVault } from '../wallet/useVault'
import {
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  InfoRow,
  LogOut,
  Plus,
  ScreenHeader,
  Shield,
} from '../components/ui'
import type { HdAccount } from '../wallet/vault'
// The version the browser actually shows in chrome://extensions comes from the manifest,
// so it is read from there rather than kept in a second place that can drift.
import manifest from '../../manifest.json'

/** Where the full app lives — the same origin the web build is served from. */
const WEB_APP = 'https://sherwood.cash'

function short(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}

export function Settings() {
  const { go } = useAccountState()
  const vault = useVault()

  return (
    <div className="space-y-3">
      <ScreenHeader title="Settings" onBack={() => go('home')} />

      <Accounts vault={vault} />
      <Security lock={vault.lock} reveal={vault.reveal} />
      <Network />
      <DangerZone wipe={vault.wipe} />

      <footer className="pb-1 text-center text-[11px] leading-relaxed text-muted">
        Sherwood Wallet {manifest.version}
        <span className="px-1.5 text-edgeLit">·</span>
        <a
          href={WEB_APP}
          target="_blank"
          rel="noreferrer"
          className="font-semibold text-mint hover:underline"
        >
          Open the web app
        </a>
      </footer>
    </div>
  )
}

/** A copy control that says so for a moment afterwards. Used for both the address and
 *  the recovery phrase, which is why it lives here rather than inside one of them. */
function CopyButton({ value, label, disabled }: { value: string; label: string; disabled?: boolean }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(t)
  }, [copied])

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(value)
    setCopied(true)
  }, [value])

  return (
    <button className="btn-ghost" onClick={copy} disabled={disabled}>
      <Copy width={13} height={13} />
      {copied ? 'Copied' : label}
    </button>
  )
}

/** The default name for an account with no label of its own: "Account 1" for index 0,
 *  and so on, so the list never shows a blank row. */
const accountName = (a: HdAccount): string => a.label?.trim() || `Account ${a.index + 1}`

/**
 * The account switcher: every HD account this wallet holds, which one is active, and the
 * controls to add, switch and rename them. A wallet imported from a raw private key has
 * a single account and no phrase to derive more from, so "Add account" is disabled with
 * a short reason rather than hidden — hiding it would read as a missing feature.
 */
function Accounts({ vault }: { vault: ReturnType<typeof useVault> }) {
  const { accounts, activeIndex, canAddAccount, busy, switchAccount, addAccount, renameAccount } = vault
  const [renaming, setRenaming] = useState<number | null>(null)
  const [draft, setDraft] = useState('')

  const active = accounts.find((a) => a.index === activeIndex) ?? accounts[0] ?? null

  function startRename(a: HdAccount) {
    setRenaming(a.index)
    setDraft(a.label ?? '')
  }

  async function commitRename(index: number) {
    await renameAccount(index, draft)
    setRenaming(null)
    setDraft('')
  }

  return (
    <section className="card">
      <span className="label">Accounts</span>

      {active && (
        <p className="inset select-all break-all px-3 py-2.5 font-mono text-[12px] leading-relaxed text-white">
          {active.address}
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <CopyButton value={active?.address ?? ''} label="Copy address" disabled={!active} />
        <a
          className="btn-ghost flex-1"
          href={active ? `${EXPLORER}/address/${active.address}` : EXPLORER}
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink width={13} height={13} />
          Explorer
        </a>
      </div>

      <div className="mt-3 space-y-1.5">
        {accounts.map((a) => {
          const isActive = a.index === activeIndex
          if (renaming === a.index) {
            return (
              <div key={a.index} className="inset flex items-center gap-2 px-2.5 py-2">
                <input
                  className="input flex-1 text-[12px]"
                  autoFocus
                  maxLength={40}
                  placeholder={`Account ${a.index + 1}`}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRename(a.index)
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                />
                <button
                  className="btn-primary shrink-0 px-3 py-1.5 text-[12px]"
                  disabled={busy}
                  onClick={() => void commitRename(a.index)}
                >
                  Save
                </button>
              </div>
            )
          }
          return (
            <div
              key={a.index}
              className={`inset flex items-center gap-2 px-2.5 py-2 ${
                isActive ? 'border-mint/40' : ''
              }`}
            >
              <button
                className="min-w-0 flex-1 text-left"
                disabled={busy || isActive}
                onClick={() => void switchAccount(a.index)}
              >
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[12.5px] font-semibold text-white">
                    {accountName(a)}
                  </span>
                  {isActive && (
                    <span className="rounded-full border border-mint/40 bg-mint/10 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide text-mint">
                      Active
                    </span>
                  )}
                </div>
                <span className="block truncate font-mono text-[11px] text-muted">
                  {short(a.address)}
                </span>
              </button>
              <button
                className="btn-ghost shrink-0 px-2.5 py-1.5 text-[11px]"
                disabled={busy}
                onClick={() => startRename(a)}
              >
                Rename
              </button>
            </div>
          )
        })}
      </div>

      <button
        className="btn-ghost mt-2 w-full"
        disabled={busy || !canAddAccount}
        onClick={() => void addAccount()}
      >
        <Plus width={13} height={13} />
        Add account
      </button>
      {!canAddAccount && accounts.length > 0 && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
          This wallet was imported from a private key, so it holds a single account. Import
          a recovery phrase to derive more.
        </p>
      )}
    </section>
  )
}

function Security({
  lock,
  reveal,
}: {
  lock: () => void
  reveal: (password: string) => Promise<{ mnemonic: string | null; privateKey: string }>
}) {
  const [asking, setAsking] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [secret, setSecret] = useState<{ mnemonic: string | null; privateKey: string } | null>(null)
  // Revealed and shown are two different things: the phrase is decrypted here but stays
  // blurred until it is asked for, so unlocking it in a coffee shop is not the same as
  // putting it on the screen.
  const [shown, setShown] = useState(false)

  async function submit() {
    setError(null)
    setBusy(true)
    try {
      setSecret(await reveal(password))
      setPassword('')
    } catch (e) {
      const err = e as { message?: string }
      setError(err.message || 'That password did not work.')
    } finally {
      setBusy(false)
    }
  }

  function hide() {
    setAsking(false)
    setSecret(null)
    setShown(false)
    setPassword('')
    setError(null)
  }

  // An imported private key has no phrase behind it, so the label has to follow what the
  // wallet actually holds rather than promise twelve words that do not exist.
  const isPhrase = secret?.mnemonic != null
  const value = secret ? (secret.mnemonic ?? secret.privateKey) : ''

  return (
    <section className="card">
      <span className="label">Security</span>

      <button className="btn-ghost w-full" onClick={lock}>
        <LogOut width={13} height={13} />
        Lock now
      </button>

      {!asking && !secret && (
        <button className="btn-ghost mt-2 w-full" onClick={() => setAsking(true)}>
          <Eye width={13} height={13} />
          Reveal recovery phrase
        </button>
      )}

      {asking && !secret && (
        <div className="mt-3">
          <p className="mb-2 text-[11.5px] leading-relaxed text-muted">
            Enter your password to decrypt the phrase. Anyone who has it can spend
            everything in this wallet, on any device.
          </p>
          <input
            className="input"
            type="password"
            autoFocus
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !busy && password && submit()}
          />
          {error && <p className="mt-1.5 text-[11px] text-neg">{error}</p>}
          <div className="mt-2 flex gap-2">
            <button className="btn-ghost flex-1" onClick={hide}>
              Cancel
            </button>
            <button className="btn-primary flex-1" disabled={busy || !password} onClick={submit}>
              {busy ? 'Checking…' : 'Reveal'}
            </button>
          </div>
        </div>
      )}

      {secret && (
        <div className="mt-3">
          <div className="mb-2 rounded-xl border border-neg/40 bg-neg/10 px-3 py-2.5 text-[11.5px] leading-relaxed text-neg">
            Write this down and keep it offline. Never type it into a website and never
            share it — there is no support line that can undo it.
          </div>
          <button
            type="button"
            onClick={() => setShown((s) => !s)}
            aria-label={shown ? 'Hide the recovery phrase' : 'Show the recovery phrase'}
            className="inset block w-full px-3 py-3 text-left"
          >
            <span
              className={`block break-all font-mono text-[12px] leading-relaxed text-white transition ${
                shown ? '' : 'select-none blur-[5px]'
              }`}
            >
              {value}
            </span>
          </button>
          <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-moss">
            {shown ? <EyeOff width={12} height={12} /> : <Eye width={12} height={12} />}
            {shown
              ? `Tap the ${isPhrase ? 'phrase' : 'key'} to blur it again.`
              : `Tap to show your ${isPhrase ? 'recovery phrase' : 'private key'}.`}
          </p>
          <div className="mt-2 flex gap-2">
            <CopyButton value={value} label={isPhrase ? 'Copy phrase' : 'Copy key'} />
            <button className="btn-ghost flex-1" onClick={hide}>
              Done
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

function Network() {
  // The RPC URL carries an API key in its path, so only the host is shown: the useful
  // part of this row is which provider is being talked to, not the credential.
  let rpcHost = DEPLOYMENT.rpcUrl
  try {
    rpcHost = new URL(DEPLOYMENT.rpcUrl).host
  } catch {
    /* a malformed URL is worth showing verbatim — it is the thing that is broken */
  }

  return (
    <section className="card">
      <span className="label">Network</span>
      <InfoRow label="Network" value={DEPLOYMENT.network} />
      <InfoRow label="Chain id" value={DEPLOYMENT.chainId} />
      <InfoRow
        label="Vault"
        value={
          <a
            href={`${EXPLORER}/address/${DEPLOYMENT.vault}`}
            target="_blank"
            rel="noreferrer"
            className="text-mint hover:underline"
          >
            {short(DEPLOYMENT.vault)}
          </a>
        }
      />
      <InfoRow label="RPC" value={rpcHost} />
      <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-moss">
        <Shield width={12} height={12} className="mt-0.5 shrink-0" />
        Balances and proofs are read straight from this node. Nothing about your notes
        leaves this browser.
      </p>
    </section>
  )
}

function DangerZone({ wipe }: { wipe: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  async function remove() {
    setBusy(true)
    try {
      await wipe()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <span className="label">Danger zone</span>
      {!confirming ? (
        <button className="btn-danger w-full" onClick={() => setConfirming(true)}>
          Remove this wallet from Chrome
        </button>
      ) : (
        <div>
          <div className="mb-2 rounded-xl border border-neg/40 bg-neg/10 px-3 py-2.5 text-[11.5px] leading-relaxed text-neg">
            This deletes the encrypted key from this browser. Your recovery phrase is the
            only way back into this wallet — if it is not written down somewhere safe, the
            funds in it are gone for good.
          </div>
          <div className="flex gap-2">
            <button className="btn-ghost flex-1" onClick={() => setConfirming(false)}>
              Keep it
            </button>
            <button className="btn-danger flex-1" disabled={busy} onClick={remove}>
              {busy ? 'Removing…' : 'Remove wallet'}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
