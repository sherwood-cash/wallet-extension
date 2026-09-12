/**
 * The MV3 service worker: the hub every dapp request passes through.
 *
 * Responsibilities:
 *   - Read RPC (eth_call, eth_chainId, balances, receipts…) → forwarded to the wallet's
 *     configured RPC over fetch. No approval; these read public chain state only.
 *   - eth_accounts / eth_requestAccounts → gated on a per-origin connect approval kept in
 *     chrome.storage.local. First connect opens an approval popup.
 *   - eth_sendTransaction / personal_sign / eth_sign / eth_signTypedData_v4 → open a
 *     signing popup; the popup unlocks the vault if needed and signs with the existing
 *     keystore/session signer, then hands the result back here.
 *   - wallet_switchEthereumChain / wallet_addEthereumChain → single-chain wallet: accept a
 *     switch to Robinhood 4663, reject anything else with 4902.
 *
 * The SW never sees a private key: signing happens in the approval popup (an extension
 * page with the vault + unlock UI), which returns only the signed result.
 */

import {
  CHAIN_ID,
  CHAIN_ID_HEX,
  ERROR,
  READ_METHODS,
  SIGN_METHODS,
  err,
  type ProviderRpcError,
} from './protocol'

// Vite inlines this at build time (see .env / config.ts). The SW cannot read the popup's
// localStorage custom-RPC override, so it uses the build default — the same endpoint the
// wallet ships pointing at.
const RPC_URL: string = (import.meta.env.VITE_RPC_URL as string | undefined)?.trim() || ''

/** Per-origin connect state. `sherwood:dapp:connected` → { [origin]: true }. */
const CONNECTED_KEY = 'sherwood:dapp:connected'
/** The account registry, to resolve the active address without a session. */
const ACCOUNTS_KEY = 'sherwood:ext:accounts'
const KEYSTORE_KEY = 'sherwood:ext:keystore'

// ---------------------------------------------------------------------------
// Small storage helpers
// ---------------------------------------------------------------------------

async function getConnected(): Promise<Record<string, boolean>> {
  const got = await chrome.storage.local.get(CONNECTED_KEY)
  const v = got[CONNECTED_KEY]
  return v && typeof v === 'object' ? (v as Record<string, boolean>) : {}
}

async function setConnected(origin: string, on: boolean): Promise<void> {
  const map = await getConnected()
  if (on) map[origin] = true
  else delete map[origin]
  await chrome.storage.local.set({ [CONNECTED_KEY]: map })
}

async function isConnected(origin: string): Promise<boolean> {
  return (await getConnected())[origin] === true
}

/** The active account's address from the on-disk registry, or null if no wallet. */
async function activeAddress(): Promise<string | null> {
  const got = await chrome.storage.local.get([ACCOUNTS_KEY, KEYSTORE_KEY])
  const reg = got[ACCOUNTS_KEY] as
    | { accounts?: { index: number; address: string }[]; activeIndex?: number }
    | undefined
  if (reg?.accounts?.length) {
    const active = reg.accounts.find((a) => a.index === reg.activeIndex) ?? reg.accounts[0]
    return active.address
  }
  const ks = got[KEYSTORE_KEY]
  if (typeof ks === 'string') {
    try {
      const parsed = JSON.parse(ks) as { address?: string }
      return parsed.address ?? null
    } catch {
      return null
    }
  }
  return null
}

async function hasWallet(): Promise<boolean> {
  const got = await chrome.storage.local.get(KEYSTORE_KEY)
  return typeof got[KEYSTORE_KEY] === 'string'
}

// ---------------------------------------------------------------------------
// Read RPC passthrough
// ---------------------------------------------------------------------------

let rpcId = 1

async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  if (!RPC_URL) throw err(ERROR.internal, 'Sherwood: no RPC endpoint is configured in this build.')
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: rpcId++, jsonrpc: '2.0', method, params }),
  })
  if (!res.ok) throw err(ERROR.internal, `RPC responded ${res.status}.`)
  const body = (await res.json()) as { result?: unknown; error?: { code?: number; message?: string } }
  if (body.error)
    throw { code: body.error.code ?? -32603, message: body.error.message ?? 'RPC error.' } as ProviderRpcError
  return body.result
}

// ---------------------------------------------------------------------------
// Approval popups (connect / sign / tx)
// ---------------------------------------------------------------------------
//
// Each pending approval is held here until the popup posts back an approve/reject. The
// popup is an extension page (approval.html) that reuses the vault + unlock UI, so a
// LOCKED wallet prompts for the password there before it can sign.

interface Pending {
  resolve: (result: unknown) => void
  reject: (error: ProviderRpcError) => void
  windowId?: number
}
const pending = new Map<string, Pending>()

let approvalSeq = 0
const newApprovalId = (): string => `ap-${Date.now()}-${approvalSeq++}`

interface ApprovalRequest {
  approvalId: string
  type: 'connect' | 'sign' | 'tx'
  origin: string
  /** For sign/tx: the method and params the popup needs to render + sign. */
  method?: string
  params?: unknown[]
  address?: string | null
}

/** Queue a request the popup will pick up, and open a window pointed at it. */
function openApproval(req: ApprovalRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    pending.set(req.approvalId, { resolve, reject })
    // Stash the request so the popup can fetch it by id (survives the popup's own load).
    void chrome.storage.session.set({ [`sherwood:dapp:pending:${req.approvalId}`]: req }).then(() => {
      const url = chrome.runtime.getURL(
        `approval.html?approvalId=${encodeURIComponent(req.approvalId)}&type=${req.type}`,
      )
      chrome.windows.create({ url, type: 'popup', width: 380, height: 620 }, (win) => {
        const p = pending.get(req.approvalId)
        if (p && win) p.windowId = win.id
      })
    })
  })
}

/** Resolve/reject a pending approval and tidy up its window + stashed request. */
async function finishApproval(
  approvalId: string,
  outcome: { result?: unknown; error?: ProviderRpcError },
): Promise<void> {
  const p = pending.get(approvalId)
  if (!p) return
  pending.delete(approvalId)
  await chrome.storage.session.remove(`sherwood:dapp:pending:${approvalId}`)
  if (outcome.error) p.reject(outcome.error)
  else p.resolve(outcome.result)
  if (p.windowId !== undefined) {
    try {
      await chrome.windows.remove(p.windowId)
    } catch {
      /* the user may have closed it already */
    }
  }
}

// If the user closes an approval window without deciding, treat it as a rejection so the
// page's promise settles instead of hanging.
chrome.windows.onRemoved.addListener((windowId: number) => {
  for (const [id, p] of pending) {
    if (p.windowId === windowId) {
      pending.delete(id)
      void chrome.storage.session.remove(`sherwood:dapp:pending:${id}`)
      p.reject(err(ERROR.userRejected))
    }
  }
})

// ---------------------------------------------------------------------------
// Event fan-out to connected pages
// ---------------------------------------------------------------------------

async function broadcast(event: string, args: unknown[], onlyConnected = true): Promise<void> {
  const connected = await getConnected()
  const tabs = await chrome.tabs.query({})
  for (const tab of tabs) {
    if (tab.id === undefined) continue
    try {
      const tabOrigin = tab.url ? new URL(tab.url).origin : null
      if (onlyConnected && (!tabOrigin || !connected[tabOrigin])) continue
      chrome.tabs.sendMessage(tab.id, { kind: 'event', event, args }, () => void chrome.runtime.lastError)
    } catch {
      /* tab without a normal URL — skip */
    }
  }
}

// ---------------------------------------------------------------------------
// Method dispatch
// ---------------------------------------------------------------------------

async function handle(origin: string, method: string, params: unknown[]): Promise<unknown> {
  // Chain identity — answered locally, no RPC round-trip needed.
  if (method === 'eth_chainId') return CHAIN_ID_HEX
  if (method === 'net_version') return String(CHAIN_ID)

  if (method === 'eth_accounts') {
    if (!(await isConnected(origin))) return []
    const addr = await activeAddress()
    return addr ? [addr] : []
  }

  if (method === 'eth_requestAccounts' || method === 'wallet_requestPermissions') {
    if (!(await hasWallet())) {
      // Nothing to connect to yet; let the dapp know it is unauthorized rather than hang.
      throw err(ERROR.unauthorized, 'No Sherwood wallet exists on this device yet.')
    }
    if (await isConnected(origin)) {
      const addr = await activeAddress()
      return addr ? [addr] : []
    }
    const approvalId = newApprovalId()
    const addr = await activeAddress()
    await openApproval({ approvalId, type: 'connect', origin, address: addr })
    // openApproval resolves only once the popup approved; mark connected + notify.
    await setConnected(origin, true)
    const active = await activeAddress()
    const accounts = active ? [active] : []
    void broadcast('connect', [{ chainId: CHAIN_ID_HEX }])
    void broadcast('accountsChanged', [accounts])
    return accounts
  }

  if (method === 'wallet_revokePermissions') {
    await setConnected(origin, false)
    void broadcast('accountsChanged', [[]])
    return null
  }

  if (method === 'wallet_switchEthereumChain') {
    const target = (params[0] as { chainId?: string } | undefined)?.chainId
    if (typeof target === 'string' && parseInt(target, 16) === CHAIN_ID) return null
    throw err(ERROR.unrecognizedChain)
  }

  if (method === 'wallet_addEthereumChain') {
    const target = (params[0] as { chainId?: string } | undefined)?.chainId
    if (typeof target === 'string' && parseInt(target, 16) === CHAIN_ID) return null
    throw err(ERROR.unrecognizedChain, 'Sherwood is a single-chain wallet and cannot add other chains.')
  }

  if (READ_METHODS.has(method)) {
    return rpcCall(method, params)
  }

  if (SIGN_METHODS.has(method)) {
    // Signing requires an established connection first — the same gate MetaMask applies.
    if (!(await isConnected(origin))) throw err(ERROR.unauthorized)
    if (!(await hasWallet())) throw err(ERROR.unauthorized, 'No Sherwood wallet exists on this device yet.')
    const approvalId = newApprovalId()
    const addr = await activeAddress()
    const type: 'sign' | 'tx' = method === 'eth_sendTransaction' ? 'tx' : 'sign'
    // The popup does the actual signing with the vault signer and returns the result
    // (a signature, or a broadcast tx hash for eth_sendTransaction).
    return openApproval({ approvalId, type, origin, method, params, address: addr })
  }

  // Unknown method: try to pass it to the RPC (some dapps probe non-standard reads), but
  // if it is clearly a write/permission method we do not recognise, refuse.
  if (method.startsWith('eth_') || method.startsWith('net_') || method.startsWith('web3_')) {
    return rpcCall(method, params)
  }
  throw err(ERROR.unsupportedMethod, `Sherwood does not support "${method}".`)
}

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (
    msg: {
      kind?: string
      id?: string
      method?: string
      params?: unknown[]
      approvalId?: string
      result?: unknown
      error?: ProviderRpcError
    },
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean => {
    // A dapp RPC relayed by a content script.
    if (msg?.kind === 'rpc' && typeof msg.id === 'string' && typeof msg.method === 'string') {
      const origin = sender.origin || (sender.url ? safeOrigin(sender.url) : '') || 'unknown'
      handle(origin, msg.method, msg.params ?? [])
        .then((result) => sendResponse({ id: msg.id, result }))
        .catch((e: unknown) => sendResponse({ id: msg.id, error: toProviderError(e) }))
      return true // async
    }

    // The approval popup fetching the request it is meant to render.
    if (msg?.kind === 'approval:get' && typeof msg.approvalId === 'string') {
      const key = `sherwood:dapp:pending:${msg.approvalId}`
      chrome.storage.session.get(key).then((got) => sendResponse(got[key] ?? null))
      return true
    }

    // The approval popup reporting a decision. For sign/tx it carries the signed result.
    if (msg?.kind === 'approval:resolve' && typeof msg.approvalId === 'string') {
      void finishApproval(msg.approvalId, { result: msg.result }).then(() => sendResponse({ ok: true }))
      return true
    }
    if (msg?.kind === 'approval:reject' && typeof msg.approvalId === 'string') {
      void finishApproval(msg.approvalId, { error: msg.error ?? err(ERROR.userRejected) }).then(() =>
        sendResponse({ ok: true }),
      )
      return true
    }

    // The popup telling us the active account changed (switch account, etc.).
    if (msg?.kind === 'wallet:accountsChanged') {
      void broadcast('accountsChanged', [msg.params ?? []]).then(() => sendResponse({ ok: true }))
      return true
    }

    return false
  },
)

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

function toProviderError(e: unknown): ProviderRpcError {
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
    return {
      code: (e as ProviderRpcError).code,
      message: (e as ProviderRpcError).message,
      data: (e as ProviderRpcError).data,
    }
  }
  return err(ERROR.internal, e instanceof Error ? e.message : String(e))
}

export {}
