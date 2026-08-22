/**
 * The wallet's landing screen: what you hold, what you can do with it, and what you
 * did last.
 *
 * The hero leads with the SHIELDED figure rather than the plain one. That inversion is
 * the whole point of the product — the private balance is the balance that matters, and
 * the wallet balance is the staging area you top it up from — so the layout says so
 * before any copy has to.
 */
import { useMemo, type ReactNode } from 'react'
import { fmtUnits, useAccountState } from '../state'
import type { ActivityItem } from '../types'
import { txUrl, type AssetMeta } from '@app/config'
import {
  ArrowDown,
  ArrowUp,
  EmptyNote,
  ExternalLink,
  Shield,
  SwapArrows,
  TokenIcon,
  Wallet,
} from '../components/ui'

/** Balances are only ever missing while they are being fetched, so a null reads as
 *  "still loading" everywhere on this screen — never as a zero. */
function Amount({ value, className = '' }: { value: string | null; className?: string }) {
  if (value === null) return <span className={`skeleton h-3 w-12 ${className}`} />
  return <span className={className}>{value}</span>
}

export function Home() {
  const { asset, assets, shielded, shieldedBalanceOf, walletBalanceOf, activity, go } =
    useAccountState()

  // Assets you actually hold privately float to the top; below that the configured order
  // stands, so the list does not reshuffle itself every time a scan lands.
  const rows = useMemo(() => {
    const held = (a: AssetMeta) => shielded.get(a.key)?.balance.gt(0) ?? false
    return [...assets].sort((a, b) => Number(held(b)) - Number(held(a)))
  }, [assets, shielded])

  return (
    <div className="space-y-3">
      <BalanceHero />

      <div className="grid grid-cols-4 gap-1.5">
        <QuickAction label="Deposit" onClick={() => go('deposit')}>
          <ArrowDown width={15} height={15} />
        </QuickAction>
        <QuickAction label="Swap" onClick={() => go('swap')}>
          <SwapArrows width={15} height={15} />
        </QuickAction>
        <QuickAction label="Withdraw" onClick={() => go('withdraw')}>
          <ArrowUp width={15} height={15} />
        </QuickAction>
        {/* Receive is the plain wallet's own address, not a pool action — the wallet
            glyph keeps it from reading as a fourth privacy flow. */}
        <QuickAction label="Receive" onClick={() => go('receive')}>
          <Wallet width={15} height={15} />
        </QuickAction>
      </div>

      <section className="panel overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2.5">
          <span className="eyebrow">Assets</span>
          <span className="text-[10px] uppercase tracking-wider text-muted">Private · Wallet</span>
        </div>
        <div className="border-t border-edge">
          {rows.map((a) => (
            <AssetRow
              key={a.key}
              asset={a}
              selected={a.key === asset.key}
              privateBalance={shieldedBalanceOf(a)}
              walletBalance={walletBalanceOf(a)}
            />
          ))}
        </div>
      </section>

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

      {/* The plain balances above are unaffected by the pool, and a plain transfer is the
          one thing the rail has no room for — it hangs off the wallet figure it spends. */}
      <p className="pb-1 text-center text-[11px] text-muted">
        Moving funds without the pool?{' '}
        <button onClick={() => go('send')} className="font-semibold text-mint hover:underline">
          Send from the wallet
        </button>
      </p>
    </div>
  )
}

/** The selected asset's private balance, large. Everything else on the screen is a way
 *  of getting to this number or of pointing it at a different asset. */
function BalanceHero() {
  const { asset, shieldedBalanceOf, walletBalanceOf, shielded, signingIn } = useAccountState()
  const priv = shieldedBalanceOf(asset)
  const summary = shielded.get(asset.key)

  return (
    <section className="card">
      <div className="relative flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-mint">
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
      {signingIn && priv === null && (
        <div className="relative mt-1 text-[11px] text-moss">Unlocking your private balances…</div>
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
}: {
  asset: AssetMeta
  selected: boolean
  privateBalance: string | null
  walletBalance: string | null
}) {
  const { selectAsset } = useAccountState()
  return (
    <button
      onClick={() => selectAsset(asset.key)}
      aria-current={selected}
      className={`row w-full text-left ${selected ? 'bg-mint/[0.06]' : ''}`}
    >
      <TokenIcon symbol={asset.symbol} accent={asset.accent} size={26} src={asset.logoUrl} plain />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-[13px] font-semibold text-white">{asset.symbol}</span>
        <span className="block truncate text-[10.5px] text-muted">{asset.name}</span>
      </span>
      <span className="shrink-0 text-right leading-tight">
        <Amount value={privateBalance} className="num block text-[12px] text-mint" />
        <Amount value={walletBalance} className="num block text-[10.5px] text-muted" />
      </span>
    </button>
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
