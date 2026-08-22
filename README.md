# Sherwood Wallet

A self-custodial Chrome wallet that **deposits into**, **swaps inside**, and **withdraws
out of** the Sherwood privacy pool. Keys never leave the browser, and every proof is
built locally — nothing about a transaction reaches a server before it is already
private.

## Build it

```bash
npm install
cp .env.example .env      # fill in VITE_RPC_URL
npm run icons             # renders the toolbar PNGs from the brand mark
npm run build             # type-checks, then writes dist/
```

Then in Chrome:

1. open `chrome://extensions`
2. turn on **Developer mode** (top right)
3. **Load unpacked** → pick `dist/`
4. pin *Sherwood Wallet* and click it

After a change, re-run `npm run build` and hit the reload arrow on the card in
`chrome://extensions`.

`npm run dev` serves the popup at `localhost:5173` as an ordinary web page, which is far
faster to iterate against — the wallet falls back to `localStorage`/`sessionStorage`
when the `chrome.*` APIs are absent. It is not the real thing, though: MV3's CSP and the
extension origin only exist in a loaded build. Proving in particular does **not** work
under `dev`, because the prover asks for `/circuits/transaction2.zkey`, which only
resolves once the bundle is the root of the extension origin.

## How it works

### Keys

There is no injected wallet inside a popup, so this one carries its own.

- The private key is encrypted with your password into a standard Web3 Secret Storage
  keystore (scrypt, N = 2¹⁵) and kept in `chrome.storage.local`.
- The **decrypted** key only ever lives in `chrome.storage.session`, which Chrome backs
  with memory and never writes to the profile directory. It dies with the browser.

Someone who copies a profile directory off a laptop therefore gets the ciphertext and
nothing else, and each password guess costs an scrypt run.

### Sign-in

Spending a shielded note needs keys derived from a signature over a fixed message. The
web app has to pop a wallet prompt for that; here the local key signs it silently, so a
single password gets you all the way in. Locking clears that cached signature too —
otherwise a "locked" wallet would still have spendable notes.

### Proving and the popup lifecycle

A Groth16 proof takes 10–30 seconds, and Chrome destroys a popup the instant it loses
focus, which would throw away a half-built transaction. Every flow that proves says so
while it works and offers to reopen itself as a real tab (`?view=tab`), where nothing
can close the page.

### The circuits

`public/circuits/` holds the proving key and the witness generator — 19 MB of the
repository. That copy is deliberate. MV3 forbids fetching remote code, and a wallet
whose proving key arrives over the network is a wallet that can be served a *different*
proving key.

## Layout

```
manifest.json           MV3. 'wasm-unsafe-eval' is required — snarkjs proves in WASM.
vite.config.ts          @app -> src/protocol, plus the node polyfills the prover needs
src/
  App.tsx               onboarding → unlock → shell
  state.tsx             the one shared store: keys, balances, activity
  wallet/               keystore, session handling, the useVault hook
  screens/              Home, Deposit, Swap, Withdraw, Receive, Send, Settings
  components/           Shell, TokenPicker, and the shared ui.tsx primitives
  protocol/             the Sherwood protocol layer, vendored (see below)
  fonts.css             Cinzel / Manrope / JetBrains Mono, bundled rather than fetched
scripts/make-icons.mjs  the toolbar icons, rendered from the brand mark
```

### `src/protocol/` is vendored

Note scanning, the Groth16 prover, the Uniswap routing and the vault ABIs are the same
modules the Sherwood web app runs, copied in rather than reimplemented — a wallet and a
website that disagree about how a note is built produce funds nobody can spend. The
`@app/*` alias is kept so any file here can be diffed against its upstream copy without
import noise.

Consequence worth knowing: **changes to the protocol layer must be made upstream and
re-copied**, not edited here.

## Configuration

`src/protocol/deployment.json` pins the chain, the vault and the router addresses. Its
three endpoint fields ship blank and come from the environment at build time (see
`.env.example`), because an RPC URL with a provider key in its path is a credential and
this repository is public.

`manifest.json` currently requests `https://*/*` in `host_permissions`. That is broader
than any single deployment needs — it is that wide because the RPC, indexer and relayer
are all configurable. Pin it to the hosts you actually publish against before shipping
to the Web Store.

## Security

This code has not been audited. Treat it as what it is: a working implementation of a
self-custodial wallet, published so it can be read. If you find something, open an
issue.
