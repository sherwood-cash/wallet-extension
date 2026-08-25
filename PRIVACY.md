# Sherwood Wallet — Privacy Policy

_Last updated: 2026-08-25_

Sherwood Wallet is a self-custodial browser extension. It is built so that your keys and
your activity stay on your own device. This policy explains, plainly, what the extension
does and does not do with your data.

## What we collect

**Nothing.** Sherwood Wallet has no backend of its own, no analytics, no telemetry, no
accounts, and no tracking. We do not collect, store, transmit, or sell any personal
information. The developers cannot see your addresses, balances, keys, or transactions.

## What stays on your device

All sensitive data is stored locally in your browser and never leaves it:

- **Encrypted keys.** Your wallet's private key / recovery phrase is encrypted with your
  password (scrypt, Web3 Secret Storage keystore) and kept in `chrome.storage.local`.
  Imported private keys are encrypted the same way. The unencrypted key exists only in
  `chrome.storage.session`, which the browser keeps in memory and wipes when it closes.
- **Preferences.** Your added tokens, selected mode, activity list, custom RPC and
  auto-lock setting are stored in local browser storage.

We never transmit any of this. Removing the extension, or using your browser's "clear
data", deletes it.

## Network requests

To function, the extension reads from and submits to public blockchain infrastructure:

- A **blockchain RPC endpoint** (by default the public Robinhood chain RPC) to read
  balances and broadcast transactions.
- The **Sherwood indexer/relayer** (`api.sherwood.cash`) to fetch public pool data and,
  for private withdrawals/swaps, to relay a zero-knowledge proof.

These requests contain only the public data any blockchain node would see (e.g. a public
address you look up, or a signed transaction you choose to send). They contain no personal
information and no private keys. If you configure your own custom RPC in Settings, requests
go to the endpoint you chose instead.

Zero-knowledge proofs are generated **locally in your browser**; the proving keys are
bundled in the extension, so nothing about a private transaction reaches any server before
it is already private.

## Permissions

- **storage** — to keep your encrypted keystore and preferences on your device.
- **host access** to the default RPC and `api.sherwood.cash` — to read the chain and reach
  the indexer/relayer. If you set a custom RPC, the extension asks for access to that host
  at that moment.

The extension requests no other permissions. It does not read your browsing history, your
tabs' contents, or any other site's data.

## Third parties

When you connect an external wallet or use a wallet-connection modal, that flow is handled
by the wallet you chose and its own provider; their privacy terms apply to that interaction.

## Contact

Questions or reports: open an issue at
<https://github.com/sherwood-cash/wallet-extension>.
