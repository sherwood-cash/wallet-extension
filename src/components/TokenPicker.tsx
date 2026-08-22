/**
 * The popup's asset selector. A trimmed cousin of the web app's `TokenSelect`: same
 * row anatomy (logo, symbol, secondary line) and the same "after migration" greying,
 * but the discovery surface — import-by-address, the Uniswap search, trending — is
 * left out. A 360px popup is where you move funds you already hold; finding a brand
 * new token is a job for the full site.
 *
 * Opens as a sheet over the whole popup rather than a dropdown: at this width a
 * floating menu covers the field it belongs to anyway, so it may as well commit.
 */
import { useMemo, useState } from 'react'
import type { AssetMeta } from '@app/config'
import { ChevronDown, Close, TokenIcon } from './ui'

export function TokenPicker({
  assets,
  value,
  onChange,
  /** Optional per-asset trailing line — usually a balance. */
  subtitle,
  /** Assets that are selectable in principle but not for this flow (no pool yet). */
  isDisabled,
  disabledLabel = 'after migration',
  label,
}: {
  assets: AssetMeta[]
  value: string
  onChange: (key: string) => void
  subtitle?: (asset: AssetMeta) => string | null | undefined
  isDisabled?: (asset: AssetMeta) => boolean
  disabledLabel?: string
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const selected = useMemo(
    () => assets.find((a) => a.key === value) ?? assets[0],
    [assets, value],
  )

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return assets
    return assets.filter(
      (a) => a.symbol.toLowerCase().includes(q) || a.name.toLowerCase().includes(q),
    )
  }, [assets, query])

  if (!selected) return null

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="select" aria-label={label}>
        <span className="flex min-w-0 items-center gap-2">
          <TokenIcon symbol={selected.symbol} accent={selected.accent} size={24} src={selected.logoUrl} plain />
          <span className="min-w-0 leading-tight">
            <span className="block truncate text-[13px] font-semibold text-white">{selected.symbol}</span>
          </span>
        </span>
        <ChevronDown width={14} height={14} className="shrink-0 text-muted" />
      </button>

      {open && (
        <div className="animate-fade-in fixed inset-0 z-50 flex flex-col bg-ink/95 backdrop-blur-md">
          <div className="flex items-center gap-2 border-b border-edge/70 px-3 py-3">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search assets"
              className="input h-11 min-h-[44px] flex-1 text-[13px]"
            />
            <button
              onClick={() => {
                setOpen(false)
                setQuery('')
              }}
              aria-label="Close"
              className="press grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-edge bg-panel2 text-muted transition hover:border-edgeLit hover:text-white"
            >
              <Close width={14} height={14} />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {shown.length === 0 && (
              <p className="px-4 py-6 text-center text-[12px] text-muted">No asset matches “{query}”.</p>
            )}
            {shown.map((a) => {
              const blocked = isDisabled?.(a) ?? false
              const sub = subtitle?.(a)
              return (
                <button
                  key={a.key}
                  type="button"
                  disabled={blocked}
                  onClick={() => {
                    onChange(a.key)
                    setOpen(false)
                    setQuery('')
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors duration-150 ${
                    blocked ? 'cursor-default border-transparent opacity-50' : 'border-transparent hover:bg-white/[0.04]'
                  } ${
                    a.key === value
                      ? 'border-mint/40 bg-mint/[0.08] shadow-[0_1px_0_0_rgba(227,209,153,0.06)_inset]'
                      : ''
                  }`}
                >
                  <TokenIcon symbol={a.symbol} accent={a.accent} size={28} src={a.logoUrl} plain />
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className={`block truncate text-[13px] font-semibold ${a.key === value ? 'text-mint' : 'text-white'}`}>
                      {a.symbol}
                    </span>
                    <span className="block truncate text-[11px] text-muted">{a.name}</span>
                  </span>
                  {blocked ? (
                    <span className="shrink-0 rounded-md border border-edge px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted">
                      {disabledLabel}
                    </span>
                  ) : (
                    sub && <span className="shrink-0 font-mono text-[11px] tabular-nums text-white/80">{sub}</span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </>
  )
}
