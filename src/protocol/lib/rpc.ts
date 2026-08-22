import { ethers } from 'ethers'
import { DEPLOYMENT } from '../config'

// The one read-only provider for the whole app. Reads (balances, log scans,
// pool lookups) go here instead of the wallet's rate-limited RPC; writes still
// use the signer.
//
// Two reasons it is a single shared instance built this way:
//
//   1. `new JsonRpcProvider(url)` with no network makes ethers v5 schedule an
//      eth_chainId to detect it — one per instance, on construction. We used to
//      build one per module (App, actions, swap, tree, tokenRegistry), so a page
//      load opened with a burst of identical eth_chainId calls before a single
//      useful request went out.
//   2. `StaticJsonRpcProvider` never re-detects the network, and handing it the
//      network up front skips the detection call entirely. The chain id is
//      already pinned by deployment.json — the same source `robinhood` in
//      lib/wallet/config.ts is built from — so there is nothing to discover.
//
// The network is passed as a plain chain id: ethers resolves an unknown one to
// `{ chainId, name: "unknown" }`, whereas passing a name it does not recognise
// risks colliding with a built-in network of the same name but a different id.
export const readProvider = new ethers.providers.StaticJsonRpcProvider(
  DEPLOYMENT.rpcUrl,
  DEPLOYMENT.chainId,
)
