# Sherwood Wallet — Privacy Policy

_Last updated: 2026-09-09_

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

## Stealth Receive

The Private-mode **Receive** tab lets you be paid at a fresh, one-time stealth address.
This uses the same `api.sherwood.cash` host already listed above — it adds no new host
access — and works like this:

- **Reading (finding your money).** The extension fetches stealth **status** and
  **announcements** from `api.sherwood.cash` (`GET /stealth/status`,
  `GET /stealth/announcements`). Announcements are pulled as an ordered public firehose
  from a block cursor — the server is never asked "which of these are mine?" and cannot
  answer that. Whether an announcement is yours is decided **locally** by a viewing key
  that never leaves your device.
- **Handing out an address.** When you generate a one-time address to receive a payment,
  the extension may submit it to `POST /stealth/pending` so the relayer can publish the
  on-chain announcement once funds arrive (the payer has no wallet connected and cannot
  publish it themselves). What is sent is only the public, single-use stealth address,
  its ephemeral public key, a view tag, and — if you chose one — the public username you
  are publishing on purpose.
- **Sponsored deposit.** A freshly funded stealth address holds no gas, so shielding it
  into the vault can be relayed via `POST /stealth/relay-deposit` (with `GET
  /stealth/relay-info` to read the relayer's terms). This submits a signed, sponsored
  deposit authorization for that one-time address.

In none of these requests is your main wallet address, private key, viewing key, or any
personal information sent. Keys never leave the device; ownership detection is always
local.

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
