/**
 * The approval popup UI. A standalone extension page (approval.html) opened by the
 * background service worker with `?approvalId=…&type=connect|sign|tx`. It reuses the
 * wallet's vault (so a LOCKED wallet is unlocked here with the normal password flow) and
 * the wallet's signer to actually sign — the background never touches a key.
 *
 * Flow:
 *   1. Fetch the pending request from the background by id.
 *   2. If the vault is locked/empty, prompt unlock (the existing <Unlock> form).
 *   3. Show origin + action; on Approve, sign with vault.signer (or just resolve for a
 *      connect) and post the result back to the background; on Reject, post 4001.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { ethers } from 'ethers'
import { useVault } from '../wallet/useVault'
import { Unlock } from '../screens/Unlock'
import { Onboarding } from '../screens/Onboarding'
import { Spinner } from '../components/ui'
import { CHAIN_ID, ERROR, type ProviderRpcError } from './protocol'

interface PendingRequest {
  approvalId: string
  type: 'connect' | 'sign' | 'tx'
  origin: string
  method?: string
  params?: unknown[]
  address?: string | null
}

const params = new URLSearchParams(location.search)
const APPROVAL_ID = params.get('approvalId') ?? ''

// ---- background messaging ---------------------------------------------------

function fetchRequest(): Promise<PendingRequest | null> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ kind: 'approval:get', approvalId: APPROVAL_ID }, (r: PendingRequest | null) => {
      void chrome.runtime.lastError
      resolve(r ?? null)
    })
  })
}

function resolveApproval(result: unknown): void {
  chrome.runtime.sendMessage({ kind: 'approval:resolve', approvalId: APPROVAL_ID, result }, () => {
    void chrome.runtime.lastError
    window.close()
  })
}

function rejectApproval(error: ProviderRpcError): void {
  chrome.runtime.sendMessage({ kind: 'approval:reject', approvalId: APPROVAL_ID, error }, () => {
    void chrome.runtime.lastError
    window.close()
  })
}

// ---- signing (reuses the vault's ethers signer) ----------------------------
//
// vault.signer is an ethers.Wallet connected to the read provider — the exact same object
// every in-wallet screen signs with. We never leave this page with a key.

async function performSign(signer: ethers.Wallet, method: string, reqParams: unknown[]): Promise<unknown> {
  switch (method) {
    case 'personal_sign': {
      // params: [message, address]  (message is hex or utf8)
      const message = reqParams[0] as string
      const bytes = ethers.utils.isHexString(message)
        ? ethers.utils.arrayify(message)
        : ethers.utils.toUtf8Bytes(message)
      return signer.signMessage(bytes)
    }
    case 'eth_sign': {
      // params: [address, message]. Same raw-bytes signing as personal_sign, args swapped.
      const message = reqParams[1] as string
      const bytes = ethers.utils.isHexString(message)
        ? ethers.utils.arrayify(message)
        : ethers.utils.toUtf8Bytes(message)
      return signer.signMessage(bytes)
    }
    case 'eth_signTypedData':
    case 'eth_signTypedData_v4': {
      // params: [address, typedDataJSON]
      const raw = reqParams[1]
      const typed = typeof raw === 'string' ? JSON.parse(raw) : raw
      const { domain, types, message } = typed as {
        domain: ethers.TypedDataDomain
        types: Record<string, ethers.TypedDataField[]>
        message: Record<string, unknown>
        primaryType?: string
      }
      // ethers derives EIP712Domain itself and rejects an explicit one in `types`.
      const cleaned = { ...types }
      delete (cleaned as Record<string, unknown>).EIP712Domain
      return (
        signer as unknown as {
          _signTypedData(
            d: ethers.TypedDataDomain,
            t: Record<string, ethers.TypedDataField[]>,
            m: Record<string, unknown>,
          ): Promise<string>
        }
      )._signTypedData(domain, cleaned, message)
    }
    case 'eth_sendTransaction': {
      const tx = (reqParams[0] as ethers.providers.TransactionRequest) ?? {}
      // Let ethers fill nonce/gas/chainId from the connected read provider, then broadcast.
      const sent = await signer.sendTransaction({
        to: tx.to,
        value: tx.value ? ethers.BigNumber.from(tx.value) : undefined,
        data: tx.data,
        gasLimit: tx.gasLimit ? ethers.BigNumber.from(tx.gasLimit) : undefined,
        gasPrice: tx.gasPrice ? ethers.BigNumber.from(tx.gasPrice) : undefined,
      })
      return sent.hash
    }
    default:
      throw ERROR.unsupportedMethod
  }
}

// ---- presentation helpers ---------------------------------------------------

function short(addr?: string | null): string {
  if (!addr) return ''
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr
}

function decodeMessage(method?: string, reqParams?: unknown[]): string {
  if (!reqParams) return ''
  if (method === 'personal_sign') {
    const m = reqParams[0] as string
    return ethers.utils.isHexString(m) ? tryUtf8(m) : m
  }
  if (method === 'eth_sign') return String(reqParams[1] ?? '')
  return ''
}

function tryUtf8(hex: string): string {
  try {
    return ethers.utils.toUtf8String(hex)
  } catch {
    return hex
  }
}

// ---- the screens ------------------------------------------------------------

function Panel({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-col gap-3 p-4">{children}</div>
}

function OriginBadge({ origin }: { origin: string }) {
  let host = origin
  try {
    host = new URL(origin).host
  } catch {
    /* leave as-is */
  }
  return (
    <div className="rounded-xl border border-edge bg-panel2 px-3 py-2 text-center">
      <div className="text-[11px] uppercase tracking-wide text-muted">Requesting site</div>
      <div className="truncate font-mono text-[13px] text-white/90">{host}</div>
    </div>
  )
}

function ConnectApproval({ req }: { req: PendingRequest }) {
  return (
    <Panel>
      <div className="text-[15px] font-semibold text-white">Connect to Sherwood</div>
      <OriginBadge origin={req.origin} />
      <p className="text-[12px] leading-relaxed text-muted">
        This site wants to see your wallet address and ask you to sign. It cannot move funds without a
        further approval.
      </p>
      <div className="rounded-xl border border-edge bg-panel2 px-3 py-2">
        <div className="text-[11px] uppercase tracking-wide text-muted">Account</div>
        <div className="truncate font-mono text-[13px] text-white/90">{short(req.address)}</div>
      </div>
      <div className="mt-auto grid grid-cols-2 gap-2">
        <button className="btn-ghost" onClick={() => rejectApproval(ERROR.userRejected)}>
          Reject
        </button>
        <button className="btn-cta" onClick={() => resolveApproval(true)}>
          Connect
        </button>
      </div>
    </Panel>
  )
}

function SignApproval({ req, signer }: { req: PendingRequest; signer: ethers.Wallet }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isTx = req.type === 'tx'
  const message = decodeMessage(req.method, req.params)
  const tx = isTx ? ((req.params?.[0] as Record<string, unknown>) ?? {}) : null
  const typed =
    req.method === 'eth_signTypedData_v4' || req.method === 'eth_signTypedData'
      ? (() => {
          try {
            const raw = req.params?.[1]
            return JSON.stringify(typeof raw === 'string' ? JSON.parse(raw) : raw, null, 2)
          } catch {
            return String(req.params?.[1] ?? '')
          }
        })()
      : null

  const approve = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await performSign(signer, req.method!, req.params ?? [])
      resolveApproval(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }, [signer, req])

  const title =
    req.method === 'eth_sendTransaction'
      ? 'Confirm transaction'
      : req.method === 'personal_sign' || req.method === 'eth_sign'
        ? 'Sign message'
        : 'Sign typed data'

  return (
    <Panel>
      <div className="text-[15px] font-semibold text-white">{title}</div>
      <OriginBadge origin={req.origin} />

      {isTx && tx && (
        <div className="space-y-1 rounded-xl border border-edge bg-panel2 px-3 py-2 text-[12px]">
          <Row label="To" value={short((tx.to as string) ?? '')} />
          <Row
            label="Value"
            value={tx.value ? `${ethers.utils.formatEther(ethers.BigNumber.from(tx.value))} ETH` : '0 ETH'}
          />
          {typeof tx.data === 'string' && tx.data.length > 2 && (
            <Row
              label="Data"
              value={`${(tx.data as string).slice(0, 20)}… (${((tx.data as string).length - 2) / 2} bytes)`}
            />
          )}
          <Row label="From" value={short(req.address)} />
        </div>
      )}

      {message && (
        <div className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-edge bg-panel2 px-3 py-2 text-[12px] leading-relaxed text-white/90">
          {message}
        </div>
      )}

      {typed && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-edge bg-panel2 px-3 py-2 text-[11px] leading-snug text-white/90">
          {typed}
        </pre>
      )}

      {error && (
        <div className="break-words rounded-xl border border-neg/40 bg-neg/10 px-3 py-2 text-[12px] text-neg">
          {error}
        </div>
      )}

      <div className="mt-auto grid grid-cols-2 gap-2">
        <button className="btn-ghost" disabled={busy} onClick={() => rejectApproval(ERROR.userRejected)}>
          Reject
        </button>
        <button className="btn-cta" disabled={busy} onClick={approve}>
          {busy ? <Spinner size={16} /> : null}
          {busy ? 'Working…' : isTx ? 'Confirm' : 'Sign'}
        </button>
      </div>
    </Panel>
  )
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-moss">{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-white/90">{value}</span>
    </div>
  )
}

export function Approval() {
  const vault = useVault()
  const [req, setReq] = useState<PendingRequest | null | 'loading'>('loading')

  useEffect(() => {
    if (!APPROVAL_ID) {
      setReq(null)
      return
    }
    void fetchRequest().then((r) => setReq(r))
  }, [])

  // Single-chain wallet; nothing to guard here, but keep the id referenced/honest.
  void CHAIN_ID

  if (req === 'loading' || vault.status === 'loading') {
    return (
      <div className="grid h-full place-items-center">
        <Spinner size={18} />
      </div>
    )
  }

  if (!req) {
    return (
      <Panel>
        <div className="text-[14px] text-white">This request expired.</div>
        <p className="text-[12px] text-muted">You can close this window and try again from the site.</p>
        <button className="btn-cta mt-auto" onClick={() => window.close()}>
          Close
        </button>
      </Panel>
    )
  }

  // No wallet yet — the site cannot connect to something that does not exist.
  if (vault.status === 'empty') return <Onboarding />

  // Locked: reuse the normal unlock screen; once unlocked the vault flips to 'unlocked'
  // and the approval below renders with a live signer.
  if (vault.status === 'locked') return <Unlock />

  if (req.type === 'connect') return <ConnectApproval req={req} />
  if (vault.signer) return <SignApproval req={req} signer={vault.signer} />

  return (
    <div className="grid h-full place-items-center">
      <Spinner size={18} />
    </div>
  )
}
