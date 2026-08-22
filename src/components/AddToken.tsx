/**
 * The "add a token" sheet — the discovery surface the TokenPicker deliberately leaves
 * out. Two ways in: tap one of the deployment's other known tokens (the `catalog`), or
 * paste any ERC-20 address and let the store read its symbol/name/decimals on-chain.
 *
 * Opens as a full-popup sheet, the same anatomy as TokenPicker: a backdrop-blurred
 * panel with a header, a scrolling body and a close. Added tokens land in `assets`
 * (persisted by the store), so they show up on Home and in every picker at once.
 */
import { useMemo, useState } from 'react'
import type { AssetMeta } from '@app/config'
import { useAccountState } from '../state'
import { Close, Plus, Spinner, TokenIcon } from './ui'

/** A short ok/bad address check so the button can gate before we hit the RPC. */
function looksLikeAddress(v: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(v.trim())
}

export function AddToken({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { catalog, addToken, addTokenByAddress } = useAccountState()

  const [query, setQuery] = useState('')
  const [address, setAddress] = useState('')
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState<AssetMeta | null>(null)

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return catalog
    return catalog.filter(
      (a) => a.symbol.toLowerCase().includes(q) || a.name.toLowerCase().includes(q),
    )
  }, [catalog, query])

  if (!open) return null

  const close = () => {
    setQuery('')
    setAddress('')
    setError(null)
    setAdded(null)
    setImporting(false)
    onClose()
  }

  const pick = (a: AssetMeta) => {
    addToken(a)
    close()
  }

  const importByAddress = async () => {
    const v = address.trim()
    if (!looksLikeAddress(v) || importing) return
    setError(null)
    setAdded(null)
    setImporting(true)
    try {
      const meta = await addTokenByAddress(v)
      setAdded(meta)
      // Give the resolved symbol a beat on screen, then dismiss.
      setTimeout(close, 700)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add that token')
    } finally {
      setImporting(false)
    }
  }

  const canImport = looksLikeAddress(address) && !importing

  return (
    <div className="animate-fade-in fixed inset-0 z-50 flex flex-col bg-ink/95 backdrop-blur-md">
      <div className="flex items-center gap-2 border-b border-edge/70 px-3 py-3">
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-semibold text-white">Add a token</span>
          <span className="block text-[11px] text-muted">
            Pick a known token, or import any ERC-20 by address.
          </span>
        </span>
        <button
          onClick={close}
          aria-label="Close"
          className="press grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-edge bg-panel2 text-muted transition hover:border-edgeLit hover:text-white"
        >
          <Close width={14} height={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {/* ---- import by address ---- */}
        <div className="card">
          <span className="label">Import by address</span>
          <div className="flex items-center gap-2">
            <input
              value={address}
              onChange={(e) => {
                setAddress(e.target.value)
                setError(null)
                setAdded(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void importByAddress()
              }}
              spellCheck={false}
              placeholder="0x… token contract address"
              className="input h-11 min-h-[44px] flex-1 font-mono text-[12px]"
            />
            <button
              type="button"
              onClick={() => void importByAddress()}
              disabled={!canImport}
              aria-label="Import token"
              className="btn-primary grid h-11 w-11 shrink-0 place-items-center px-0 py-0"
            >
              {importing ? <Spinner size={16} /> : <Plus width={16} height={16} />}
            </button>
          </div>

          {added && (
            <div className="mt-2.5 flex items-center gap-2 rounded-xl border border-mint/40 bg-mint/10 px-3 py-2.5 text-[12px] font-medium text-mint">
              <TokenIcon symbol={added.symbol} accent={added.accent} size={22} src={added.logoUrl} plain />
              <span className="min-w-0 flex-1 truncate">
                Added <span className="font-semibold">{added.symbol}</span> · {added.name}
              </span>
            </div>
          )}
          {error && (
            <div className="mt-2.5 break-words rounded-xl border border-neg/40 bg-neg/10 px-3 py-2.5 text-[12px] leading-snug text-neg">
              {error}
            </div>
          )}
        </div>

        {/* ---- catalog suggestions ---- */}
        <div className="mt-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="eyebrow">Known tokens</span>
            {catalog.length > 0 && (
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                className="input h-8 min-h-0 w-28 py-1 text-[12px]"
              />
            )}
          </div>

          {catalog.length === 0 ? (
            <div className="rounded-xl border border-edge bg-panel2 px-3 py-6 text-center text-[12px] leading-relaxed text-muted">
              You already hold every token this deployment knows about. Import one by
              address above to add anything else.
            </div>
          ) : shown.length === 0 ? (
            <p className="px-4 py-6 text-center text-[12px] text-muted">
              No known token matches “{query}”. Try importing it by address.
            </p>
          ) : (
            <div className="space-y-1">
              {shown.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  onClick={() => pick(a)}
                  className="flex w-full items-center gap-2.5 rounded-xl border border-transparent px-3 py-2.5 text-left transition-colors duration-150 hover:bg-white/[0.04]"
                >
                  <TokenIcon symbol={a.symbol} accent={a.accent} size={28} src={a.logoUrl} plain />
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block truncate text-[13px] font-semibold text-white">{a.symbol}</span>
                    <span className="block truncate text-[11px] text-muted">{a.name}</span>
                  </span>
                  <span className="press grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-mint/35 bg-mint/10 text-mint">
                    <Plus width={14} height={14} />
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
