/**
 * A user-set RPC endpoint, saved on this device and pointed at the one shared read
 * provider. The default comes from the build (DEPLOYMENT.rpcUrl); a custom one just
 * redirects the same provider — the chain id is pinned, so nothing re-detects.
 *
 * Applied synchronously at boot (see main.tsx) before the first balance read, so a saved
 * RPC is in effect from the first request rather than after a round-trip on the default.
 */
import { DEPLOYMENT } from '@app/config'
import { readProvider } from '@app/lib/rpc'

const RPC_KEY = 'sherwood:ext:rpc'

/** The endpoint baked in at build time (the public Robinhood RPC). */
export function defaultRpc(): string {
  return DEPLOYMENT.rpcUrl
}

/** The user's saved RPC, or null when they never set one. */
export function customRpc(): string | null {
  try {
    const v = (localStorage.getItem(RPC_KEY) || '').trim()
    return v || null
  } catch {
    return null
  }
}

/** What the wallet is actually reading from right now. */
export function currentRpc(): string {
  return customRpc() || defaultRpc()
}

/** Redirect the shared read provider at `url`. StaticJsonRpcProvider pins the chain id,
 *  so only the URL changes — subsequent eth_calls go to the new host. */
function apply(url: string): void {
  const target = url.trim() || defaultRpc()
  try {
    ;(readProvider as unknown as { connection: { url: string } }).connection.url = target
  } catch {
    /* older ethers shape */
  }
  try {
    ;(readProvider as unknown as { _connection: { url: string } })._connection.url = target
  } catch {
    /* nothing else to do */
  }
}

/** Apply a saved custom RPC at startup. No-op when none is set. */
export function initRpcOverride(): void {
  const url = customRpc()
  if (url) apply(url)
}

/** Persist and apply a custom RPC. An empty string reverts to the default. */
export function saveCustomRpc(url: string): void {
  const trimmed = url.trim()
  try {
    if (trimmed) localStorage.setItem(RPC_KEY, trimmed)
    else localStorage.removeItem(RPC_KEY)
  } catch {
    /* private mode / quota — the in-session apply below still takes effect */
  }
  apply(trimmed || defaultRpc())
}

/** Forget the custom RPC and go back to the build default. */
export function clearCustomRpc(): void {
  saveCustomRpc('')
}

/** Probe an RPC: does it answer, and is it the right chain? Used by Settings before saving. */
export async function testRpc(url: string): Promise<{ ok: boolean; chainId?: number; error?: string }> {
  const target = url.trim()
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: 'Enter an http(s) URL.' }
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'eth_chainId', params: [] }),
    })
    if (!res.ok) return { ok: false, error: `The RPC answered ${res.status}.` }
    const body = (await res.json()) as { result?: string; error?: { message?: string } }
    if (body.error) return { ok: false, error: body.error.message || 'The RPC returned an error.' }
    const chainId = body.result ? parseInt(body.result, 16) : NaN
    if (!Number.isFinite(chainId)) return { ok: false, error: 'The RPC did not return a chain id.' }
    if (chainId !== DEPLOYMENT.chainId) {
      return { ok: false, chainId, error: `Wrong chain: this RPC is ${chainId}, Sherwood is on ${DEPLOYMENT.chainId}.` }
    }
    return { ok: true, chainId }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || 'Could not reach that RPC.' }
  }
}
