/**
 * The chrome around every unlocked screen: a header that never scrolls, a scrolling
 * body, and a bottom rail for the three flows. Sized for a 360px popup — in the
 * popped-out tab the same markup just centres itself in a wider column.
 */
import type { ReactNode } from 'react'
import { useAccountState, type WalletMode } from '../state'
import type { Screen } from '../types'
import {
  ArrowDown,
  ArrowUp,
  Cog,
  Copy,
  ExternalLink,
  LogOut,
  Refresh,
  Shield,
  SwapArrows,
  Wallet,
} from './ui'

/** The Sherwood mark. Bundled webp, so the popup renders it with no network at all. */
function Wordmark() {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <img src="./parallax/logo-mark.webp" alt="" width={22} height={22} className="shrink-0 rounded-md" />
      <span
        className="truncate text-[15px] font-semibold tracking-wide text-mint"
        style={{ fontFamily: "'Cinzel', Georgia, serif" }}
      >
        Sherwood
      </span>
    </span>
  )
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
  return (
    <header className="flex shrink-0 flex-col gap-2 border-b border-edge bg-panel/80 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Wordmark />
        <div className="ml-auto flex items-center gap-1">
          {address && (
            <button
              onClick={onCopy}
              title="Copy address"
              className="press flex items-center gap-1.5 rounded-lg border border-edge bg-panel2 px-2 py-1.5 font-mono text-[11px] text-white/85 transition hover:border-edgeLit"
            >
              {copied ? <span className="text-mint">copied</span> : short(address)}
              <Copy width={12} height={12} className="text-muted" />
            </button>
          )}
          <IconBtn label="Refresh balances" onClick={refresh} spin={refreshing}>
            <Refresh width={14} height={14} />
          </IconBtn>
          <IconBtn label="Open in a tab" onClick={expand}>
            <ExternalLink width={14} height={14} />
          </IconBtn>
          <IconBtn label="Settings" onClick={() => go('settings')}>
            <Cog width={14} height={14} />
          </IconBtn>
          <IconBtn label="Lock wallet" onClick={onLock}>
            <LogOut width={14} height={14} />
          </IconBtn>
        </div>
      </div>
      <ModeToggle mode={mode} onChange={setMode} />
    </header>
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
      className="relative grid grid-cols-2 gap-1 rounded-xl border border-edge bg-panel2 p-1"
    >
      <button
        role="tab"
        aria-selected={!priv}
        onClick={() => onChange('normal')}
        className={`press flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] font-semibold transition ${
          !priv
            ? 'bg-mint/15 text-mint ring-1 ring-inset ring-mint/40'
            : 'text-muted hover:text-white/80'
        }`}
      >
        <Wallet width={13} height={13} />
        <span>Normal</span>
      </button>
      <button
        role="tab"
        aria-selected={priv}
        onClick={() => onChange('private')}
        className={`press flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] font-semibold transition ${
          priv
            ? 'bg-gold/15 text-gold ring-1 ring-inset ring-gold/40'
            : 'text-muted hover:text-white/80'
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
      className="press grid h-7 w-7 place-items-center rounded-lg border border-edge bg-panel2 text-muted transition hover:border-edgeLit hover:text-white"
    >
      <span className={spin ? 'inline-block animate-spin' : undefined}>{children}</span>
    </button>
  )
}

type RailItem = { id: Screen; label: string; icon: ReactNode }

const WALLET_ITEM: RailItem = {
  id: 'home',
  label: 'Wallet',
  icon: <span className="text-[13px] leading-none">◈</span>,
}

// Normal mode is a plain EOA wallet: money in (Receive) and money out (Send), no pool.
const NORMAL_RAIL: RailItem[] = [
  WALLET_ITEM,
  { id: 'send', label: 'Send', icon: <ArrowUp width={13} height={13} /> },
  { id: 'receive', label: 'Receive', icon: <ArrowDown width={13} height={13} /> },
  { id: 'settings', label: 'Settings', icon: <Cog width={13} height={13} /> },
]

// Private mode is the shielded pool: the three pool flows.
const PRIVATE_RAIL: RailItem[] = [
  WALLET_ITEM,
  { id: 'deposit', label: 'Deposit', icon: <ArrowDown width={13} height={13} /> },
  { id: 'swap', label: 'Swap', icon: <SwapArrows width={13} height={13} /> },
  { id: 'withdraw', label: 'Withdraw', icon: <ArrowUp width={13} height={13} /> },
]

const RAIL_FOR: Record<WalletMode, RailItem[]> = {
  normal: NORMAL_RAIL,
  private: PRIVATE_RAIL,
}

export function BottomRail({ screen, onGo }: { screen: Screen; onGo: (s: Screen) => void }) {
  const { mode } = useAccountState()
  const rail = RAIL_FOR[mode]
  return (
    <nav className="shrink-0 border-t border-edge bg-panel/90 px-2 py-2">
      <div className="seg-rail">
        {rail.map((item) => (
          <button
            key={item.id}
            onClick={() => onGo(item.id)}
            className={`seg flex items-center justify-center gap-1 ${
              screen === item.id ? 'seg-on' : 'seg-off'
            }`}
          >
            {item.icon}
            <span className="truncate">{item.label}</span>
          </button>
        ))}
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
