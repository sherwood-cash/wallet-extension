/**
 * The content script. Runs in the isolated world at document_start on every page, and is
 * the only piece with a foot in both worlds: it can talk to the page over
 * `window.postMessage` AND to the extension background over `chrome.runtime`.
 *
 * Two jobs:
 *   1. Inject `inpage.js` into the page's MAIN world so `window.ethereum` exists in the
 *      dapp's own realm (a content script's `window` is a different, isolated one).
 *   2. Relay: page request → background, background reply/event → page.
 *
 * It trusts nothing from the page beyond the shape of the envelope: the background does
 * every real check (connected origin, chain, signing approval).
 *
 * Wrapped in an IIFE so nothing leaks to the isolated world's global scope and the
 * emitted file runs as a classic content script (no ESM top level). The trailing
 * `export {}` keeps it a module for the type-checker; Rollup strips the empty export.
 */
;(() => {
const MSG_REQUEST = 'sherwood:req'
const MSG_RESPONSE = 'sherwood:res'
const MSG_EVENT = 'sherwood:event'

// ---- Inject the MAIN-world provider ----------------------------------------
//
// The file is a web_accessible_resource; a <script src> tag runs it in the page's own
// world at document_start, before the page's scripts look for window.ethereum.
function injectInpage(): void {
  try {
    const url = chrome.runtime.getURL('inpage.js')
    const script = document.createElement('script')
    script.src = url
    script.async = false
    const parent = document.head || document.documentElement
    parent.appendChild(script)
    // Remove the tag once loaded; the provider it installed lives on regardless.
    script.onload = () => script.remove()
  } catch {
    /* a page CSP that blocks the tag will simply have no provider; nothing else breaks */
  }
}

injectInpage()

// ---- Page → background ------------------------------------------------------

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window || !e.data || typeof e.data !== 'object') return
  const data = e.data as { type?: string; id?: string; method?: string; params?: unknown[] }
  if (data.type !== MSG_REQUEST || typeof data.id !== 'string' || typeof data.method !== 'string') return

  chrome.runtime.sendMessage(
    { kind: 'rpc', id: data.id, method: data.method, params: data.params ?? [] },
    (reply: { id: string; result?: unknown; error?: { code: number; message: string; data?: unknown } }) => {
      // A missing reply means the background woke, replied and slept, or errored — surface
      // it as a provider error rather than hanging the page's promise forever.
      const lastErr = chrome.runtime.lastError
      if (lastErr || !reply) {
        window.postMessage(
          {
            type: MSG_RESPONSE,
            id: data.id,
            error: { code: -32603, message: lastErr?.message || 'Sherwood: no response from the wallet.' },
          },
          window.location.origin,
        )
        return
      }
      window.postMessage(
        { type: MSG_RESPONSE, id: reply.id, result: reply.result, error: reply.error },
        window.location.origin,
      )
    },
  )
})

// ---- Background → page (events: accountsChanged, chainChanged, …) -----------

chrome.runtime.onMessage.addListener((msg: { kind?: string; event?: string; args?: unknown[] }) => {
  if (msg?.kind === 'event' && typeof msg.event === 'string') {
    window.postMessage(
      { type: MSG_EVENT, event: msg.event, args: msg.args ?? [] },
      window.location.origin,
    )
  }
})
})()

export {}
