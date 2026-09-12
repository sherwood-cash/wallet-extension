/**
 * The injected provider. This file runs in the page's MAIN world — same JS realm as the
 * dapp — so it can put `window.ethereum` where wagmi/ethers/web3 look for it. It holds no
 * keys and no chain connection of its own: every `request()` is serialised to a
 * `window.postMessage` the content script (isolated world) picks up and relays to the
 * extension background, and every reply comes back the same way.
 *
 * It implements EIP-1193 (request + events) and announces itself with EIP-6963 so modern
 * connect flows (RainbowKit, wagmi, viem) discover it without stomping on other wallets.
 *
 * Bundled with no imports from the app so it stays a small, self-contained script — the
 * shared constants are inlined rather than imported to keep the emitted file dependency
 * free.
 *
 * Wrapped in an IIFE so it runs cleanly as an injected classic script and leaks nothing
 * to the page's globals beyond `window.ethereum`. The trailing `export {}` keeps it a
 * module for the type-checker; Rollup strips the empty export from the emitted file.
 */
;(() => {
const MSG_REQUEST = 'sherwood:req'
const MSG_RESPONSE = 'sherwood:res'
const MSG_EVENT = 'sherwood:event'
const CHAIN_ID_HEX = '0x1237' // 4663

interface RpcError {
  code: number
  message: string
  data?: unknown
}

type Listener = (...args: unknown[]) => void

class SherwoodProvider {
  // Legacy detection flags. We identify honestly as Sherwood; `isMetaMask` stays false so
  // dapps that branch on it do not mistake us for MetaMask, while EIP-6963 handles modern
  // detection.
  readonly isSherwood = true
  readonly isMetaMask = false
  /** Some legacy dapps read this string. */
  readonly _sherwoodVersion = '1.0.0'

  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: RpcError) => void }>()
  private listeners = new Map<string, Set<Listener>>()
  private nextId = 0

  /** Last known state, so a dapp reading these synchronously after connect gets a value. */
  chainId: string | null = CHAIN_ID_HEX
  networkVersion: string | null = String(parseInt(CHAIN_ID_HEX, 16))
  selectedAddress: string | null = null

  constructor() {
    window.addEventListener('message', (e: MessageEvent) => this.onMessage(e))
  }

  private onMessage(e: MessageEvent): void {
    if (e.source !== window || !e.data || typeof e.data !== 'object') return
    const data = e.data as {
      type?: string
      id?: string
      result?: unknown
      error?: RpcError
      event?: string
      args?: unknown[]
    }

    if (data.type === MSG_RESPONSE && typeof data.id === 'string') {
      const p = this.pending.get(data.id)
      if (!p) return
      this.pending.delete(data.id)
      if (data.error) p.reject(data.error)
      else p.resolve(data.result)
      return
    }

    if (data.type === MSG_EVENT && typeof data.event === 'string') {
      this.handleEvent(data.event, data.args ?? [])
    }
  }

  private handleEvent(event: string, args: unknown[]): void {
    // Keep the synchronous shims fresh before fanning out to listeners.
    if (event === 'accountsChanged') {
      const accounts = (args[0] as string[]) ?? []
      this.selectedAddress = accounts[0] ?? null
    } else if (event === 'chainChanged') {
      this.chainId = (args[0] as string) ?? this.chainId
      this.networkVersion = this.chainId ? String(parseInt(this.chainId, 16)) : this.networkVersion
    } else if (event === 'connect') {
      const info = args[0] as { chainId?: string } | undefined
      if (info?.chainId) this.chainId = info.chainId
    } else if (event === 'disconnect') {
      this.selectedAddress = null
    }
    this.emit(event, ...args)
  }

  request = (payload: { method: string; params?: unknown[] }): Promise<unknown> => {
    if (!payload || typeof payload.method !== 'string') {
      return Promise.reject({ code: -32602, message: 'Invalid request: a method string is required.' })
    }
    const id = `${Date.now()}-${this.nextId++}`
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      window.postMessage(
        { type: MSG_REQUEST, id, method: payload.method, params: payload.params ?? [] },
        window.location.origin,
      )
    })
  }

  // ---- EIP-1193 events -----------------------------------------------------

  on(event: string, listener: Listener): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(listener)
    return this
  }

  addListener(event: string, listener: Listener): this {
    return this.on(event, listener)
  }

  removeListener(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  removeAllListeners(event?: string): this {
    if (event) this.listeners.delete(event)
    else this.listeners.clear()
    return this
  }

  private emit(event: string, ...args: unknown[]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const fn of [...set]) {
      try {
        fn(...args)
      } catch {
        /* a dapp's own listener throwing must not break our dispatch loop */
      }
    }
  }

  // ---- Legacy compatibility ------------------------------------------------

  /** Legacy `enable()` predates `request` and returns the account list. */
  enable = (): Promise<unknown> => this.request({ method: 'eth_requestAccounts' })

  /** Very old `send`/`sendAsync` shims some libraries still probe for. */
  send = (methodOrPayload: unknown, paramsOrCb?: unknown): Promise<unknown> | void => {
    if (typeof methodOrPayload === 'string') {
      return this.request({ method: methodOrPayload, params: (paramsOrCb as unknown[]) ?? [] })
    }
    // Callback form: send({method,params}, cb)
    const payload = methodOrPayload as { method: string; params?: unknown[] }
    const cb = paramsOrCb as (err: unknown, res: unknown) => void
    this.request(payload).then(
      (result) => cb(null, { id: 1, jsonrpc: '2.0', result }),
      (error) => cb(error, null),
    )
  }

  sendAsync = (
    payload: { method: string; params?: unknown[]; id?: number },
    cb: (err: unknown, res: unknown) => void,
  ): void => {
    this.request(payload).then(
      (result) => cb(null, { id: payload.id ?? 1, jsonrpc: '2.0', result }),
      (error) => cb(error, null),
    )
  }
}

// A gilt "S" on forest-black to match the wallet, as an inline SVG data URI for EIP-6963 —
// no network fetch and no CSP worry.
const ICON =
  'data:image/svg+xml;base64,' +
  btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="22" fill="#0b1a12"/><text x="48" y="66" font-family="Georgia,serif" font-size="58" font-weight="700" text-anchor="middle" fill="#d9b872">S</text></svg>`,
  )

const provider = new SherwoodProvider()

// Expose on window.ethereum. writable:false keeps a dapp from swapping us out; configurable
// leaves room for a later wallet to define its own.
try {
  Object.defineProperty(window, 'ethereum', {
    value: provider,
    configurable: true,
    writable: false,
  })
} catch {
  ;(window as unknown as { ethereum: unknown }).ethereum = provider
}

// ---- EIP-6963: announce so multi-wallet connect UIs discover us -------------

const info = {
  uuid: crypto.randomUUID(),
  name: 'Sherwood Wallet',
  icon: ICON,
  rdns: 'cash.sherwood.wallet',
}

function announce(): void {
  window.dispatchEvent(
    new CustomEvent('eip6963:announceProvider', {
      detail: Object.freeze({ info, provider }),
    }),
  )
}

window.addEventListener('eip6963:requestProvider', announce)
announce()
})()

export {}
