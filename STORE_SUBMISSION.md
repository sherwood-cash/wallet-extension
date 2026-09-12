# Chrome Web Store — Submission Checklist

Version: **1.1.0** (manifest.json and package.json kept in lockstep)

Build the shippable package with:

```
npm run zip
```

This runs `npm run build` and writes `dist-zip/sherwood-wallet-<version>.zip` with
`manifest.json` at the zip's top level (verify with `unzip -l` — the first entries should
be `manifest.json`, `index.html`, `assets/…`, not a nested folder). `dist/` and
`dist-zip/` are gitignored; the zip is the artifact you upload in the dashboard.

---

## Done in code (this repo)

- [x] **Manifest V3**, single-purpose popup action, no background/content scripts.
- [x] **Version** set to `1.1.0` in both `manifest.json` and `package.json`.
- [x] **Minimal permissions:** `permissions: ["storage"]` only (encrypted keystore +
      preferences).
- [x] **Narrow host permissions:** only the chain RPC
      (`https://rpc.mainnet.chain.robinhood.com/*`) and the Sherwood API
      (`https://api.sherwood.cash/*`, which also serves `/stealth/*`). The new stealth
      Receive feature adds **no** new host.
- [x] **Optional broad host** (`optional_host_permissions: ["https://*/*"]`) is requested
      at runtime — and only then — via `chrome.permissions.request` when the user saves a
      custom RPC (`src/wallet/rpc.ts` → `grantRpcHost`, called from Settings `save`). It is
      never granted up front.
- [x] **CSP:** `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`. `'wasm-unsafe-eval'`
      is required by snarkjs/wasm for local proof generation. No remote code, no `eval`,
      no remote scripts/styles/fonts — fonts are bundled locally (`src/fonts.css` →
      `./fonts/*.woff2`).
- [x] **Privacy policy** (`PRIVACY.md`) updated to cover the stealth Receive data flow.
- [x] **Packaging script** (`npm run zip`) producing a root-level-manifest zip.

## Manual dashboard steps (TODO — cannot be automated in code)

- [ ] **$5 developer account** — register/verify the Chrome Web Store developer account
      (one-time fee) if not already done.
- [ ] **Screenshots** — at least one, sized **1280×800** (or 640×400). Suggested: popup
      showing balances, the Send/Swap view, and the Private-mode Receive (stealth) tab.
- [ ] **Store icon** — 128×128 (already in the package; also upload the promo/store icon
      in the dashboard if prompted).
- [ ] **Detailed description** — what the wallet does: self-custodial browser wallet for
      private deposits, swaps, and withdrawals on Sherwood, plus one-time stealth receive
      addresses.
- [ ] **Category** — Productivity (alternatively Developer Tools).
- [ ] **Single-purpose statement** — "A self-custodial wallet for making and receiving
      private transactions on the Sherwood privacy pool."
- [ ] **Per-permission justification:**
      - `storage` — stores the encrypted keystore (scrypt / Web3 Secret Storage) and user
        preferences on the device.
      - host `rpc.mainnet.chain.robinhood.com` — read chain state and broadcast
        transactions.
      - host `api.sherwood.cash` — fetch public pool + stealth data and relay
        zero-knowledge withdrawals/sponsored deposits.
      - optional `https://*/*` — only requested at runtime if the user configures their own
        custom RPC endpoint; not used otherwise.
- [ ] **Hosted privacy-policy URL** — publish `PRIVACY.md` at a public URL (e.g. a GitHub
      Pages / repo raw link or sherwood.cash page) and paste that URL into the dashboard.
- [ ] **Data-use / privacy disclosures** — declare that no user data is collected or sold;
      keys and activity stay on device (matches `PRIVACY.md`).
- [ ] **Upload** `dist-zip/sherwood-wallet-1.1.0.zip` and submit for review.
