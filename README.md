# Sherwood Wallet

A self-custodial Chrome/Brave/Edge extension wallet for the [Sherwood](https://sherwood.cash)
privacy vault. It is an ordinary EVM wallet **plus a private mode**: deposit into, swap
inside, and withdraw out of the shielded pool, with a built-in **stealth Receive** tab
for one-time addresses. Keys never leave your browser and every zero-knowledge proof is
built locally — nothing about a transaction reaches a server before it is already private.

**Version 1.1.0** · Manifest V3 · source is public and unminified.

---

## Features

- **Normal ⇄ Private toggle** — a plain wallet on one side, the shielded vault on the other.
- **Deposit / Swap / Withdraw** privately inside the vault (Groth16 proofs built on-device).
- **Stealth Receive** (Private mode) — generate one-time receiving addresses, regenerate
  more, see the total ETH + USDG received across all of them, and shield it straight into
  the vault. No consolidation step: funds are shielded on behalf of your main wallet.
- **HD accounts** + import an existing private key as an extra account.
- **Custom RPC** — point the wallet at your own node from Settings.

---

## Install

### Option A — Prebuilt (recommended)

The extension isn't on the Chrome Web Store yet, so install the packaged build manually
(takes a minute):

1. **Download** the latest build:
   [`sherwood-wallet-extension.zip`](https://sherwood.cash/sherwood-wallet-extension.zip)
   (or open [sherwood.cash](https://sherwood.cash) → your wallet menu → **Sherwood extension**).
2. **Unzip** it — you get a folder.
3. Open **`chrome://extensions`** in Chrome (or Brave / Edge).
4. Turn on **Developer mode** (top-right toggle).
5. Click **Load unpacked** and select the unzipped folder.
6. **Pin** *Sherwood Wallet* from the puzzle-piece icon, then click it to start.

> Developer-mode extensions are safe to run — the entire source is in this repository and
> the build is unminified, so you can read exactly what you loaded.

*Chrome Web Store listing: coming soon.*

### Option B — Build from source

```bash
npm install
cp .env.example .env      # set VITE_RPC_URL (+ VITE_INDEXER_URL / VITE_RELAYER_URL)
npm run icons             # renders the toolbar PNGs from the brand mark
npm run build             # type-checks, then writes dist/
npm run zip               # optional: packages dist/ into dist-zip/sherwood-wallet-<version>.zip
```

Then load `dist/` via **Load unpacked** as in steps 3–6 above. After a change, re-run
`npm run build` and hit the reload arrow on the extension's card in `chrome://extensions`.

`npm run dev` serves the popup at `localhost:5173` as an ordinary web page for fast
iteration (the wallet falls back to `localStorage`/`sessionStorage` when the `chrome.*`
APIs are absent). Note that **proving does not work under `dev`** — the prover needs
`/circuits/transaction2.zkey`, which only resolves once the bundle is the root of the
extension origin.

---

## How it works

### Keys

There is no injected wallet inside a popup, so this one carries its own.

- Your private key is encrypted with your password into a standard Web3 Secret Storage
  keystore (scrypt, N = 2¹⁴) kept in `chrome.storage.local`.
- The **decrypted** key only ever lives in `chrome.storage.session`, which Chrome backs
  with memory and never writes to disk. It dies with the browser.

Someone who copies your profile directory therefore gets ciphertext and nothing else, and
each password guess costs a full scrypt run.

### Sign-in & proving

Spending a shielded note needs keys derived from a signature over a fixed message; the
local key signs it silently, so one password gets you all the way in. Locking clears that
cached signature. A Groth16 proof takes 10–30s, and Chrome destroys a popup the moment it
loses focus — so any flow that proves offers to reopen itself as a full tab (`?view=tab`)
where nothing can close the page.

### The circuits are bundled, not fetched

`public/circuits/` ships the proving key and witness generator. MV3 forbids fetching
remote code, and a wallet whose proving key arrives over the network is a wallet that can
be served a *different* proving key.

---

## Permissions

Minimal, and each is justified:

- `storage` — the encrypted keystore and your settings.
- `host_permissions`: `rpc.mainnet.chain.robinhood.com` (chain reads / broadcast) and
  `api.sherwood.cash` (pool, stealth and relayer data).
- `optional_host_permissions: https://*/*` — **not granted up front**; requested at
  runtime only when you save a custom RPC in Settings.

No analytics, no tracking, no remote code. See [`PRIVACY.md`](./PRIVACY.md).

---

## Security

This code has **not** been externally audited. Treat it as a working, readable
implementation of a self-custodial wallet. Found something? Open an issue. `src/protocol/`
is vendored from the Sherwood web app (note scanning, the prover, routing, vault ABIs) so
the two never disagree about how a note is built — protocol changes are made upstream and
re-copied, not edited here.
