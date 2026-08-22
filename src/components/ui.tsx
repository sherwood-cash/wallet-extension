/**
 * The popup's shared primitives. Every screen composes these rather than
 * re-declaring its own field/notice/button markup, so the vocabulary stays the web
 * app's: gilt on forest-black, 1px edges, a sticker ledge on the one control you press.
 *
 * The icon set is imported wholesale from the web app — it is pure `currentColor` SVG
 * with no app dependencies, so there is nothing to fork.
 */
import type { ReactNode } from 'react'
import { txUrl } from '@app/config'
import { Spinner } from '@app/components/ui/icons'

export * from '@app/components/ui/icons'

/** A labelled form row. `hint` sits opposite the label — balances, "max", counters. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="label">{label}</span>
        {hint && <span className="mb-1.5 text-[11px] text-muted">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

/**
 * The single status/error slot every flow ends with. An error wins over a status —
 * a flow that failed mid-proof still has its last progress string set, and showing
 * both reads as "it is still working" next to "it broke".
 */
export function StatusNote({ status, error }: { status?: string | null; error?: string | null }) {
  if (error)
    return (
      <div className="mt-3 break-words rounded-xl border border-neg/40 bg-neg/10 px-3 py-2.5 text-[12px] leading-snug text-neg">
        {error}
      </div>
    )
  if (status)
    return (
      <div className="mt-3 flex items-center gap-2 rounded-xl border border-mint/40 bg-mint/10 px-3 py-2.5 text-[12px] font-medium text-mint">
        <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-mint" />
        <span className="min-w-0 flex-1 leading-snug">{status}</span>
      </div>
    )
  return null
}

/** Receipt line for a landed transaction. Opens the explorer in a real tab — a
 *  popup that navigates itself away from the wallet would just close. */
export function TxLink({ hash, label = 'Transaction submitted' }: { hash: string; label?: string }) {
  return (
    <a
      className="press mt-3 block truncate rounded-xl border border-edge bg-panel2 px-3 py-2.5 text-[12px] font-medium text-mint transition hover:border-mint/50"
      href={txUrl(hash)}
      target="_blank"
      rel="noreferrer"
    >
      ✓ {label} · {hash.slice(0, 14)}…
    </a>
  )
}

/**
 * The proof-generation warning. Chrome tears a popup down the instant it loses
 * focus, and a Groth16 proof takes 10–30s — long enough that a stray click
 * elsewhere kills a half-built transaction. Every flow that proves shows this while
 * busy, with the way out (pop into a tab, where nothing can close the page).
 */
export function ProvingNotice({ onExpand }: { onExpand?: () => void }) {
  return (
    <div className="mt-3 rounded-xl border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2.5 text-[11px] leading-relaxed text-amber-200/90">
      Building the zero-knowledge proof — this takes a moment. Keep this window focused:
      Chrome closes the popup as soon as you click elsewhere.
      {onExpand && (
        <button
          onClick={onExpand}
          className="mt-1.5 block font-semibold text-amber-200 underline underline-offset-2 hover:text-amber-100"
        >
          Open in a tab instead →
        </button>
      )}
    </div>
  )
}

/** The CTA at the foot of every flow: spinner + working copy while busy. */
export function SubmitButton({
  busy,
  disabled,
  icon,
  children,
  busyLabel = 'Working…',
  onClick,
}: {
  busy?: boolean
  disabled?: boolean
  icon?: ReactNode
  children: ReactNode
  busyLabel?: string
  onClick: () => void
}) {
  return (
    <button className="btn-cta mt-4" disabled={busy || disabled} onClick={onClick}>
      {busy ? <Spinner size={16} /> : icon}
      {busy ? busyLabel : children}
    </button>
  )
}

/** A quiet key/value line — fees, rates, minimums under an amount field. */
export function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-[11px]">
      <span className="text-moss">{label}</span>
      <span className="min-w-0 truncate text-right font-mono tabular-nums text-white/90">{value}</span>
    </div>
  )
}

/** Empty/placeholder state for a list that has nothing in it yet. */
export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-edge bg-panel2 px-3 py-6 text-center text-[12px] leading-relaxed text-muted">
      {children}
    </div>
  )
}

/** Screen heading with a back affordance — used by every screen pushed over Home. */
export function ScreenHeader({
  title,
  subtitle,
  icon,
  onBack,
  right,
}: {
  title: string
  subtitle?: string
  icon?: ReactNode
  onBack?: () => void
  right?: ReactNode
}) {
  return (
    <div className="flex items-start gap-2.5">
      {onBack && (
        <button
          onClick={onBack}
          aria-label="Back"
          className="press mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-edge bg-panel2 text-muted transition hover:border-edgeLit hover:text-white"
        >
          ←
        </button>
      )}
      {icon && (
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-mint/35 bg-mint/10 text-mint">
          {icon}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-[17px] font-semibold leading-tight text-white">{title}</h2>
        {subtitle && <p className="mt-0.5 text-[11.5px] leading-snug text-muted">{subtitle}</p>}
      </div>
      {right}
    </div>
  )
}
