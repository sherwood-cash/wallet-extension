/**
 * The chrome around every unlocked screen: a header that never scrolls, a scrolling
 * body, and a bottom rail for the three flows. Sized for a 360px popup — in the
 * popped-out tab the same markup just centres itself in a wider column.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAccountState, type WalletMode } from '../state'
import { useVault } from '../wallet/useVault'
import type { HdAccount } from '../wallet/vault'
import type { Screen } from '../types'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Cog,
  Copy,
  ExternalLink,
  LogOut,
  Refresh,
  Shield,
  SwapArrows,
  Wallet,
} from './ui'

/** The Sherwood mark. Bundled webp, so the popup renders it with no network at all. The
 *  wordmark text was dropped — it truncated to "SHERWO…" in the popup and the logo alone
 *  reads clearly. */
function Wordmark() {
  return <img src="./parallax/logo-mark.webp" alt="Sherwood" width={28} height={28} className="shrink-0 rounded-md" />
}

function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export function Header({
  address,
  onLock,
  onCopy,
  copied,
}: {
  address: string | null
  onLock: () => void
  onCopy: () => void
  copied: boolean
}) {
  const { refresh, refreshing, expand, go, mode, setMode } = useAccountState()
  const { reveal, play } = useModeReveal()

  const changeMode = (m: WalletMode) => {
    if (m !== mode) play(m)
    setMode(m)
  }

  return (
    <header className="flex shrink-0 flex-col gap-2 border-b border-edge bg-panel/80 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Wordmark />
        <div className="ml-auto flex items-center gap-1.5">
          {address && <AccountSwitcher address={address} onCopy={onCopy} copied={copied} />}
          <div className="flex items-center gap-0.5 rounded-full border border-edge/60 bg-ink/50 p-0.5 shadow-soft">
            <IconBtn label="Refresh balances" onClick={refresh} spin={refreshing}>
              <Refresh width={15} height={15} />
            </IconBtn>
            <IconBtn label="Lock wallet" onClick={onLock}>
              <LogOut width={15} height={15} />
            </IconBtn>
          </div>
        </div>
      </div>
      <ModeToggle mode={mode} onChange={changeMode} />
      <ModeReveal reveal={reveal} />
    </header>
  )
}

const accountName = (a: HdAccount): string => a.label?.trim() || `Account ${a.index + 1}`

/** A deterministic accent for an account, derived from its address — a cheap stand-in for a
 *  full identicon so each account reads as distinct at a glance in the switcher. */
function avatarColor(address: string): string {
  let h = 0
  for (let i = 2; i < address.length; i++) h = (h * 31 + address.charCodeAt(i)) % 360
  return `hsl(${h} 55% 45%)`
}

/** The circular colour chip that stands in for an account avatar. */
function AccountDot({ address, size }: { address: string; size: number }) {
  return (
    <span
      aria-hidden="true"
      className="shrink-0 rounded-full"
      style={{ width: size, height: size, background: avatarColor(address), boxShadow: '0 0 0 1.5px #0b0d0a' }}
    />
  )
}

/** A small checkmark for the active row. No shared Check icon exists, so it is inline. */
function Check({ width = 13, height = 13 }: { width?: number; height?: number }) {
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

/**
 * The address pill, now a dropdown: it shows the active account and, on tap, drops a compact
 * list of every account in the wallet so you can switch without opening Settings. Switching
 * needs no password (see useVault.switchAccount → switchActiveAccount). Copying the current
 * address moved into the menu so the one pill carries both jobs.
 */
function AccountSwitcher({ address, onCopy, copied }: { address: string; onCopy: () => void; copied: boolean }) {
  const { accounts, activeIndex, switchAccount, busy } = useVault()
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  // Close on any click outside the widget, and on Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function pick(index: number) {
    if (index !== activeIndex) await switchAccount(index)
    setOpen(false)
  }

  const multiple = accounts.length > 1

  return (
    <div ref={wrap} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Switch account"
        aria-haspopup="menu"
        aria-expanded={open}
        className="group flex items-center gap-1.5 whitespace-nowrap rounded-full border border-edge/70 bg-ink/60 px-2 py-1.5 font-mono text-[11px] leading-none text-white/80 shadow-soft transition active:scale-[0.97] hover:border-gold/45 hover:text-white"
      >
        <AccountDot address={address} size={14} />
        {copied ? (
          <span className="font-sans text-mint">copied</span>
        ) : (
          <span className="tracking-tight">{short(address)}</span>
        )}
        <ChevronDown
          width={12}
          height={12}
          className={`text-muted transition group-hover:text-gold ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-1.5 w-60 rounded-xl border border-edge bg-panel p-1.5 shadow-card"
        >
          {multiple && (
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {accounts.map((a) => {
                const isActive = a.index === activeIndex
                return (
                  <button
                    key={a.index}
                    role="menuitem"
                    disabled={busy}
                    onClick={() => void pick(a.index)}
                    className={`row w-full ${isActive ? 'bg-mint/[0.06]' : ''}`}
                  >
                    <AccountDot address={a.address} size={22} />
                    <span className="min-w-0 flex-1 text-left leading-tight">
                      <span className="block truncate text-[12.5px] font-semibold text-white">
                        {accountName(a)}
                      </span>
                      <span className="block truncate font-mono text-[11px] text-muted">
                        {short(a.address)}
                      </span>
                    </span>
                    {isActive && <span className="shrink-0 text-mint"><Check /></span>}
                  </button>
                )
              })}
            </div>
          )}
          <button
            role="menuitem"
            onClick={() => {
              onCopy()
              setOpen(false)
            }}
            className={`row w-full ${multiple ? 'mt-1 border-t border-edge pt-2' : ''}`}
          >
            <Copy width={15} height={15} className="shrink-0 text-muted" />
            <span className="flex-1 text-left text-[12px] font-semibold text-white/85">Copy address</span>
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Drives the transient full-popup reveal that fires on a mode switch. `play(m)`
 * mounts an overlay tagged with the mode being entered; a timer clears it once the
 * keyframe has run, so the element only lives for the beat it animates and can
 * never linger or trap a click. A fresh switch mid-animation just restarts it.
 */
function useModeReveal() {
  const [reveal, setReveal] = useState<WalletMode | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const play = (m: WalletMode) => {
    if (timer.current) clearTimeout(timer.current)
    // Remount so the animation replays even on a rapid back-to-back toggle.
    setReveal(null)
    requestAnimationFrame(() => setReveal(m))
    timer.current = setTimeout(() => setReveal(null), m === 'private' ? 640 : 500)
  }

  return { reveal, play }
}

/** The cosmetic overlay itself, portalled onto <body> so it blankets the whole popup. */
function ModeReveal({ reveal }: { reveal: WalletMode | null }) {
  if (!reveal) return null
  return createPortal(
    <div
      className={`mode-reveal ${reveal === 'normal' ? 'mode-reveal-normal' : ''}`}
      aria-hidden="true"
    >
      <span className="mode-reveal-ring" />
      <img src="./parallax/logo-mark.webp" alt="" className="mode-reveal-logo" />
    </div>,
    document.body,
  )
}

/**
 * The one switch that decides which wallet you are looking at. A two-segment pill: the
 * active side lifts onto a filled pad — mint for the plain wallet, gold for private —
 * so the current mode reads at a glance without a label having to say "you are here".
 */
function ModeToggle({ mode, onChange }: { mode: WalletMode; onChange: (m: WalletMode) => void }) {
  const priv = mode === 'private'
  return (
    <div
      role="tablist"
      aria-label="Wallet mode"
      className="relative grid grid-cols-2 rounded-xl border border-edge bg-panel2 p-1"
    >
      {/* The sliding pad that lives under the active side and glides between them. */}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-lg border transition-[transform,background-color,border-color,box-shadow] duration-300 ease-out ${
          priv
            ? 'translate-x-[calc(100%+0.25rem)] border-gold/40 bg-gold/15 shadow-[0_2px_8px_-3px_rgba(205,179,96,0.5)]'
            : 'translate-x-0 border-mint/40 bg-mint/15 shadow-[0_2px_8px_-3px_rgba(120,224,178,0.5)]'
        }`}
      />
      <button
        role="tab"
        aria-selected={!priv}
        onClick={() => onChange('normal')}
        className={`relative z-10 flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] font-semibold transition-colors duration-200 ${
          !priv ? 'text-mint' : 'text-muted hover:text-white/80'
        }`}
      >
        <Wallet width={13} height={13} />
        <span>Normal</span>
      </button>
      <button
        role="tab"
        aria-selected={priv}
        onClick={() => onChange('private')}
        className={`relative z-10 flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] font-semibold transition-colors duration-200 ${
          priv ? 'text-gold' : 'text-muted hover:text-white/80'
        }`}
      >
        <Shield width={13} height={13} />
        <span>Private</span>
      </button>
    </div>
  )
}

function IconBtn({
  label,
  onClick,
  spin,
  children,
}: {
  label: string
  onClick: () => void
  spin?: boolean
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className="grid h-8 w-8 place-items-center rounded-full text-muted transition-colors duration-150 hover:bg-panel2 hover:text-gold active:scale-90"
    >
      <span className={spin ? 'inline-block animate-spin' : undefined}>{children}</span>
    </button>
  )
}

type RailItem = { id: Screen; label: string; icon: ReactNode }

const ICON = 18

const WALLET_ITEM: RailItem = {
  id: 'home',
  label: 'Wallet',
  icon: <Wallet width={ICON} height={ICON} />,
}

// Normal mode is a plain EOA wallet: money in (Receive) and money out (Send), no pool.
const NORMAL_RAIL: RailItem[] = [
  WALLET_ITEM,
  { id: 'send', label: 'Send', icon: <ArrowUp width={ICON} height={ICON} /> },
  { id: 'receive', label: 'Receive', icon: <ArrowDown width={ICON} height={ICON} /> },
  { id: 'settings', label: 'Settings', icon: <Cog width={ICON} height={ICON} /> },
]

// Private mode is the shielded pool: the three pool flows, plus a stealth Receive screen
// that hands out one-time addresses and shields what lands in them into the vault.
const PRIVATE_RAIL: RailItem[] = [
  WALLET_ITEM,
  { id: 'deposit', label: 'Deposit', icon: <ArrowDown width={ICON} height={ICON} /> },
  { id: 'swap', label: 'Swap', icon: <SwapArrows width={ICON} height={ICON} /> },
  { id: 'withdraw', label: 'Withdraw', icon: <ArrowUp width={ICON} height={ICON} /> },
  { id: 'stealth', label: 'Receive', icon: <Shield width={ICON} height={ICON} /> },
]

const RAIL_FOR: Record<WalletMode, RailItem[]> = {
  normal: NORMAL_RAIL,
  private: PRIVATE_RAIL,
}

export function BottomRail({ screen, onGo }: { screen: Screen; onGo: (s: Screen) => void }) {
  const { mode } = useAccountState()
  const rail = RAIL_FOR[mode]
  const priv = mode === 'private'
  return (
    <nav className="shrink-0 border-t border-edge bg-panel/90 px-2 pb-2 pt-1.5 backdrop-blur-md">
      <div className="tabbar">
        {rail.map((item) => {
          const active = screen === item.id
          return (
            <button
              key={item.id}
              onClick={() => onGo(item.id)}
              aria-current={active ? 'page' : undefined}
              className={`tab ${active ? (priv ? 'tab-on-priv' : 'tab-on') : 'tab-off'}`}
            >
              <span className="tab-icon">{item.icon}</span>
              <span className="max-w-full truncate">{item.label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}

/** The scrolling body. Fixed-height in the popup, free-flowing in the tab view. */
export function Body({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-3">
      <div className="mx-auto w-full max-w-md">{children}</div>
    </main>
  )
}
