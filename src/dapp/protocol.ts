/**
 * The wire vocabulary shared by the four dapp-connection layers (inpage provider,
 * content script, background service worker, approval popup). Kept in one small module
 * with NO imports so the content script and the inpage provider — which run outside the
 * bundler's usual React world — can pull only what they need.
 *
 * The flow, end to end:
 *
 *   page ──postMessage──▶ content script ──chrome.runtime──▶ background SW
 *                                                              │
 *                              read RPC ◀────────────────────┤ (eth_call, eth_chainId…)
 *                              approval popup ◀───────────────┘ (connect / sign / send)
 *
 * Every request carries a stable string `id` so a reply can be matched to its call.
 */

/** The chain this wallet is pinned to (Robinhood 4663). Duplicated here rather than
 *  imported from `@app/config` so the inpage/content bundles stay dependency-free. It is
 *  cross-checked against the RPC's answer in the background, which is the authority. */
export const CHAIN_ID = 4663
export const CHAIN_ID_HEX = '0x' + CHAIN_ID.toString(16)

/** postMessage envelopes use these tags so the page's own messages are ignored. */
export const MSG_REQUEST = 'sherwood:req'
export const MSG_RESPONSE = 'sherwood:res'
export const MSG_EVENT = 'sherwood:event'
/** The content script tells the inpage code the relay is live (for early requests). */
export const MSG_READY = 'sherwood:ready'

/** A JSON-RPC-shaped request as it crosses every hop. */
export interface RpcRequest {
  id: string
  method: string
  params?: unknown[]
}

/** The single reply shape. Exactly one of `result` / `error` is set. */
export interface RpcResponse {
  id: string
  result?: unknown
  error?: ProviderRpcError
}

/** EIP-1193 error object. */
export interface ProviderRpcError {
  code: number
  message: string
  data?: unknown
}

/** Provider events pushed page-ward (accountsChanged, chainChanged, connect, disconnect). */
export interface ProviderEvent {
  event: string
  args: unknown[]
}

/** Standard EIP-1193 / EIP-1474 error codes this wallet returns. */
export const ERROR = {
  userRejected: { code: 4001, message: 'User rejected the request.' },
  unauthorized: { code: 4100, message: 'The requested account has not been authorized by the user.' },
  unsupportedMethod: { code: 4200, message: 'The provider does not support the requested method.' },
  disconnected: { code: 4900, message: 'The provider is disconnected from all chains.' },
  chainDisconnected: { code: 4901, message: 'The provider is disconnected from the requested chain.' },
  unrecognizedChain: { code: 4902, message: 'Unrecognized chain ID. Sherwood is a single-chain wallet.' },
  internal: { code: -32603, message: 'Internal error.' },
  invalidParams: { code: -32602, message: 'Invalid method parameters.' },
} as const

export const err = (base: ProviderRpcError, message?: string): ProviderRpcError => ({
  code: base.code,
  message: message ?? base.message,
})

/** Methods the background answers straight from the read RPC — no user approval. Anything
 *  that only reads chain state is safe to forward, since it exposes nothing the page could
 *  not fetch from a public RPC itself. */
export const READ_METHODS = new Set<string>([
  'eth_chainId',
  'net_version',
  'eth_blockNumber',
  'eth_call',
  'eth_getBalance',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionCount',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getLogs',
  'eth_getBlockTransactionCountByHash',
  'eth_getBlockTransactionCountByNumber',
  'eth_sendRawTransaction',
])

/** Methods that require a confirmation popup and the wallet's signer. */
export const SIGN_METHODS = new Set<string>([
  'eth_sendTransaction',
  'personal_sign',
  'eth_sign',
  'eth_signTypedData',
  'eth_signTypedData_v4',
])
