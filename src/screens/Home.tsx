/**
 * The wallet's landing screen: what you hold, what you can do with it, and what you
 * did last.
 *
 * The hero leads with the SHIELDED figure rather than the plain one. That inversion is
 * the whole point of the product — the private balance is the balance that matters, and
 * the wallet balance is the staging area you top it up from — so the layout says so
 * before any copy has to.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { fmtUnits, useAccountState } from '../state'
import type { ActivityItem } from '../types'
import { txUrl, type AssetMeta } from '@app/config'
import {
  ArrowDown,
  ArrowUp,
  EmptyNote,
  ExternalLink,
  Plus,
  Shield,
  SwapArrows,
  TokenIcon,
  Wallet,
} from '../components/ui'
import { AddToken } from '../components/AddToken'

/** A small trash glyph — the icon set ships no delete, so this one lives here. Pure
 *  `currentColor` SVG so it takes the row's colour like every other icon. */
function Trash({ width = 13, height = 13 }: { width?: number; height?: number }) {
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V7m3 4v6m4-6v6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Balances are only ever missing while they are being fetched, so a null reads as
 *  "still loading" everywhere on this screen — never as a zero. */
function Amount({ value, className = '' }: { value: string | null; className?: string }) {
  if (value === null) return <span className={`skeleton h-3 w-12 ${className}`} />
  return <span className={className}>{value}</span>
}

export function Home() {
  const {
    mode,
    setMode,
    asset,
    assets,
    shielded,
    wallet,
    shieldedBalanceOf,
    walletBalanceOf,
    isDefaultAsset,
    removeToken,
    loading,
    shieldedLoading,
    signingIn,
    activity,
    go,
  } = useAccountState()
  const priv = mode === 'private'
  const [addOpen, setAddOpen] = useState(false)

  // In private mode a balance is only knowable once the scan (and the sign-in that
  // gates it) has run; in normal mode it is the plain wallet fetch. Passed to each row
  // so a not-yet-fetched figure reads as "unlocking/loading" rather than a hard zero.
  const balancesLoading = priv ? shieldedLoading || signingIn : loading

  // In private mode the assets you hold privately float to the top; in normal mode the
  // ones with a wallet balance do. Below that the configured order stands, so the list
  // does not reshuffle itself every time a scan lands.
  const rows = useMemo(() => {
    const held = priv
      ? (a: AssetMeta) => shielded.get(a.key)?.balance.gt(0) ?? false
      : (a: AssetMeta) => wallet.get(a.key)?.token.gt(0) ?? false
    return [...assets].sort((a, b) => Number(held(b)) - Number(held(a)))
  }, [priv, assets, shielded, wallet])

  return (
    <div className="space-y-3">
      <BalanceHero />

      {priv ? (
        <div className="grid grid-cols-3 gap-1.5">
          <QuickAction label="Deposit" onClick={() => go('deposit')}>
            <ArrowDown width={15} height={15} />
          </QuickAction>
          <QuickAction label="Swap" onClick={() => go('swap')}>
            <SwapArrows width={15} height={15} />
          </QuickAction>
          <QuickAction label="Withdraw" onClick={() => go('withdraw')}>
            <ArrowUp width={15} height={15} />
          </QuickAction>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-1.5">
          <QuickAction label="Send" onClick={() => go('send')}>
            <ArrowUp width={15} height={15} />
          </QuickAction>
          <QuickAction label="Receive" onClick={() => go('receive')}>
            <ArrowDown width={15} height={15} />
          </QuickAction>
        </div>
      )}

      <section className="panel overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2.5">
          <span className="eyebrow">Assets</span>
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-muted">
              {priv ? 'Private · Wallet' : 'Wallet'}
            </span>
            {/* Add is available in BOTH modes: import/list in normal, import/delete in private. */}
            <button
              onClick={() => setAddOpen(true)}
              aria-label="Add a token"
              title="Add a token"
              className="press grid h-6 w-6 place-items-center rounded-lg border border-edge bg-panel2 text-muted transition hover:border-mint/50 hover:text-mint"
            >
              <Plus width={13} height={13} />
            </button>
          </div>
        </div>
        <div className="border-t border-edge">
          {rows.map((a) => (
            <AssetRow
              key={a.key}
              asset={a}
              selected={a.key === asset.key}
              privateBalance={shieldedBalanceOf(a)}
              walletBalance={walletBalanceOf(a)}
              showPrivate={priv}
              loading={balancesLoading}
              removable={!isDefaultAsset(a.key)}
              onRemove={() => removeToken(a.key)}
            />
          ))}
          <button
            onClick={() => setAddOpen(true)}
            className="row w-full text-left text-muted transition hover:text-mint"
          >
            <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-lg border border-dashed border-edge text-current">
              <Plus width={14} height={14} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold">Add a token</span>
          </button>
        </div>
      </section>

      <AddToken open={addOpen} onClose={() => setAddOpen(false)} />

      <section className="panel overflow-hidden">
        <div className="px-3 py-2.5">
          <span className="eyebrow">Activity</span>
        </div>
        {activity.length === 0 ? (
          <div className="px-3 pb-3">
            <EmptyNote>
              Nothing yet. Deposits, swaps and withdrawals you make here will show up in this
              list, with a link to each transaction.
            </EmptyNote>
          </div>
        ) : (
          <div className="border-t border-edge">
            {activity.map((item, i) => (
              <ActivityRow key={`${item.hash ?? 'local'}-${i}`} item={item} />
            ))}
          </div>
        )}
      </section>

      {priv ? (
        // In private mode a plain transfer is the one thing the rail has no room for —
        // it hangs off the wallet figure it spends.
        <p className="pb-1 text-center text-[11px] text-muted">
          Moving funds without the pool?{' '}
          <button onClick={() => go('send')} className="font-semibold text-mint hover:underline">
            Send from the wallet
          </button>
        </p>
      ) : (
        // In normal mode the way "up" is into the pool — the deposit flow, which is
        // only reachable from private mode's rail, so point at it here.
        <p className="pb-1 text-center text-[11px] text-muted">
          Want to shield your balance?{' '}
          <button onClick={() => setMode('private')} className="font-semibold text-gold hover:underline">
            Go private
          </button>
        </p>
      )}
    </div>
  )
}

/** The selected asset's headline balance, large. In private mode that is the shielded
 *  figure; in normal mode the plain wallet figure. Everything else on the screen is a way
 *  of getting to this number or of pointing it at a different asset. */
function BalanceHero() {
  const { mode } = useAccountState()
  return mode === 'private' ? <PrivateHero /> : <NormalHero />
}

/** Private face: the shielded balance leads, with the plain wallet as the staging area
 *  below it and the note breakdown that explains a capped single spend. */
function PrivateHero() {
  const { asset, shieldedBalanceOf, walletBalanceOf, shielded, signingIn, keys } =
    useAccountState()
  const priv = shieldedBalanceOf(asset)
  const summary = shielded.get(asset.key)
  // The shielded scan can only run once note-spending keys exist; until then the figure
  // is genuinely unknown rather than zero, so keep it as a "still unlocking" skeleton.
  const unlocking = signingIn || !keys

  return (
    <section className="card">
      <div className="relative flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-gold">
          <Shield width={13} height={13} />
          <span className="text-[11px] font-semibold uppercase tracking-wider">Private</span>
        </span>
        <TokenIcon symbol={asset.symbol} accent={asset.accent} size={26} src={asset.logoUrl} />
      </div>

      <div className="relative mt-2 flex items-baseline gap-2">
        {priv === null ? (
          <span className="skeleton h-7 w-32" />
        ) : (
          <span className="num min-w-0 truncate text-[28px] font-semibold leading-none">{priv}</span>
        )}
        <span className="shrink-0 text-[13px] font-semibold text-muted">{asset.symbol}</span>
      </div>

      <div className="relative mt-3 flex items-baseline justify-between gap-2 border-t border-edge pt-2.5 text-[11.5px]">
        <span className="text-moss">In the wallet</span>
        <span className="min-w-0 truncate text-right">
          <Amount value={walletBalanceOf(asset)} className="num text-[12px] text-white/85" />{' '}
          <span className="text-muted">{asset.symbol}</span>
        </span>
      </div>

      {/* Note counts explain why a private balance can be there while a single spend is
          capped, so they belong next to the figure rather than inside the flows. */}
      {summary && summary.count > 0 && (
        <div className="relative mt-1 text-[11px] text-moss">
          {summary.count} {summary.count === 1 ? 'note' : 'notes'} · most you can spend at once{' '}
          <span className="num text-[11px] text-white/80">
            {fmtUnits(summary.spendable, asset.decimals)}
          </span>
        </div>
      )}
      {unlocking && priv === null && (
        <div className="relative mt-1 text-[11px] text-moss">Unlocking your private balances…</div>
      )}
    </section>
  )
}

/** Normal face: a plain EOA wallet. The wallet balance leads, and the private balance is
 *  demoted to a one-line hint — a place to go, not the headline. */
function NormalHero() {
  const { asset, walletBalanceOf, shieldedBalanceOf } = useAccountState()
  const bal = walletBalanceOf(asset)
  const priv = shieldedBalanceOf(asset)

  return (
    <section className="card">
      <div className="relative flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-mint">
          <Wallet width={13} height={13} />
          <span className="text-[11px] font-semibold uppercase tracking-wider">Wallet</span>
        </span>
        <TokenIcon symbol={asset.symbol} accent={asset.accent} size={26} src={asset.logoUrl} />
      </div>

      <div className="relative mt-2 flex items-baseline gap-2">
        {bal === null ? (
          <span className="skeleton h-7 w-32" />
        ) : (
          <span className="num min-w-0 truncate text-[28px] font-semibold leading-none">{bal}</span>
        )}
        <span className="shrink-0 text-[13px] font-semibold text-muted">{asset.symbol}</span>
      </div>

      {priv !== null && priv !== '0' && (
        <div className="relative mt-3 flex items-baseline justify-between gap-2 border-t border-edge pt-2.5 text-[11.5px]">
          <span className="flex items-center gap-1 text-gold">
            <Shield width={11} height={11} />
            <span>Private</span>
          </span>
          <span className="min-w-0 truncate text-right">
            <span className="num text-[12px] text-white/85">{priv}</span>{' '}
            <span className="text-muted">{asset.symbol}</span>
          </span>
        </div>
      )}
    </section>
  )
}

function QuickAction({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className="press flex flex-col items-center gap-1.5 rounded-xl border border-edge bg-panel2 px-1 py-2.5 text-muted transition hover:border-mint/50 hover:text-mint"
    >
      {children}
      <span className="w-full truncate text-center text-[10.5px] font-semibold text-white/85">
        {label}
      </span>
    </button>
  )
}

/** One asset. Tapping re-points the hero rather than navigating: at this width the list
 *  and the figure it feeds are on screen together, so a jump would be a jump to nowhere. */
function AssetRow({
  asset,
  selected,
  privateBalance,
  walletBalance,
  showPrivate,
  loading,
  removable,
  onRemove,
}: {
  asset: AssetMeta
  selected: boolean
  privateBalance: string | null
  walletBalance: string | null
  showPrivate: boolean
  loading: boolean
  removable: boolean
  onRemove: () => void
}) {
  const { selectAsset } = useAccountState()
  // While balances are still loading a not-yet-arrived figure is genuinely unknown, so
  // force the skeleton rather than letting a stray value read as final.
  const priv = loading ? null : privateBalance
  const plain = loading ? null : walletBalance

  // The row is a group: tap the body to re-point the hero, tap the trash to drop a
  // user-added token. A button can't nest a button, so the body is the button and the
  // trash sits beside it.
  return (
    <div
      className={`row group w-full ${selected ? 'bg-mint/[0.06]' : ''}`}
    >
      <button
        onClick={() => selectAsset(asset.key)}
        aria-current={selected}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <TokenIcon symbol={asset.symbol} accent={asset.accent} size={26} src={asset.logoUrl} plain />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[13px] font-semibold text-white">{asset.symbol}</span>
          <span className="block truncate text-[10.5px] text-muted">{asset.name}</span>
        </span>
        {/* The emphasised line is whichever balance the current mode is about; the other
            rides underneath as context. In normal mode we lead with the wallet figure. */}
        <span className="shrink-0 text-right leading-tight">
          {showPrivate ? (
            <>
              <Amount value={priv} className="num block text-[12px] text-gold" />
              <Amount value={plain} className="num block text-[10.5px] text-muted" />
            </>
          ) : (
            <Amount value={plain} className="num block text-[12px] text-white" />
          )}
        </span>
      </button>
      {/* Only user-added tokens get a delete — ETH/USDG/$SHERWOOD are guarded upstream by
          isDefaultAsset, and removeToken is a no-op on them anyway. */}
      {removable && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          aria-label={`Remove ${asset.symbol}`}
          title={`Remove ${asset.symbol}`}
          className="press grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-transparent text-muted transition hover:border-neg/40 hover:bg-neg/10 hover:text-neg"
        >
          <Trash width={13} height={13} />
        </button>
      )}
    </div>
  )
}

const ACTIVITY_ICON: Record<ActivityItem['kind'], ReactNode> = {
  deposit: <ArrowDown width={13} height={13} />,
  withdraw: <ArrowUp width={13} height={13} />,
  swap: <SwapArrows width={13} height={13} />,
  // A plain send leaves the wallet entirely rather than the pool, so it gets the
  // "off to somewhere else" glyph instead of a second up-arrow.
  send: <ExternalLink width={13} height={13} />,
}

/** Ages rather than clock times: the feed is read as "how long ago", and a popup that
 *  lives for twenty seconds never needs a date. */
function ago(at: number | undefined): string {
  if (!at) return ''
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (secs < 45) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function ActivityRow({ item }: { item: ActivityItem }) {
  return (
    <div className="row">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-mint/30 bg-mint/10 text-mint">
        {ACTIVITY_ICON[item.kind]}
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-[12.5px] font-medium text-white">{item.label}</span>
        <span className="flex min-w-0 items-baseline gap-1.5 text-[10.5px] text-muted">
          <span className="shrink-0">{ago(item.at)}</span>
          {item.hash && (
            <a
              href={txUrl(item.hash)}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="min-w-0 truncate font-mono hover:text-mint"
            >
              {item.hash.slice(0, 6)}…{item.hash.slice(-4)}
            </a>
          )}
        </span>
      </span>
      <span
        className={`shrink-0 font-mono text-[11.5px] font-semibold tabular-nums ${
          item.positive ? 'text-pos' : 'text-neg'
        }`}
      >
        {item.delta}
      </span>
    </div>
  )
}
