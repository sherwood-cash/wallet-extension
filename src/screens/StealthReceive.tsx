/**
 * The stealth Receive screen — Private mode's fifth tab.
 *
 * What it does, and nothing more:
 *   1. derives a stealth identity from the SAME local signer that unlocks the wallet,
 *      silently (no prompt — the key is on this device), reusing a pinned/session signature;
 *   2. hands out a ONE-TIME receiving address (with a QR + copy), and lets the user roll a
 *      fresh one on demand;
 *   3. sums the TOTAL ETH and USDG received across ALL discovered one-time addresses;
 *   4. shields those funds into the vault — on behalf of the MAIN wallet, so there is NO
 *      consolidation step: the deposit's output note is minted to the main wallet's keys.
 *
 * Everything about the crypto lives in `@app/lib/stealth/*`; this file only decides when to
 * call it and how to lay the answers out in a 360px popup.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BigNumber, ethers } from 'ethers'
import QRCode from 'qrcode'
import { useAccountState } from '../state'
import { ScreenHeader, StatusNote, TxLink, Copy, Refresh, Shield, Spinner, TokenIcon, Sparkle } from '../components/ui'
import { ASSETS, type AssetMeta } from '@app/config'
import { readProvider } from '@app/lib/rpc'
import {
  deriveStealthKeys,
  generateStealthAddress,
  STEALTH_SIGN_IN_MESSAGE,
  type StealthKeys,
} from '@app/lib/stealth/crypto'
import {
  fetchStealthStatus,
  fetchAnnouncements,
  registerPending,
  fetchRelayInfo,
  checkUsernameAvailable,
  type StealthStatus,
} from '@app/lib/stealth/api'
import { scanAnnouncements, loadBalances, toWallets, totals, type StealthWallet } from '@app/lib/stealth/scan'
import {
  depositMode,
  depositWalletToVault,
  sponsoredTokenDeposit,
  registerStealthKeys,
  nativeGasReserve,
  type StealthContracts,
} from '@app/lib/stealth/actions'
import {
  readStealthSignature,
  writeStealthSignature,
  pinnedSignature,
  pinSignature,
  stealthGatePassed,
  passStealthGate,
} from '@app/lib/stealth/session'
import { heldAddress, holdAddress, clearHeldAddress, shouldRotate } from '@app/lib/stealth/receiveAddress'

const Zero = BigNumber.from(0)
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/** A claimable handle: 3–32 chars, lower-case alphanumeric + underscore, not underscore-first. */
const NAME_RE = /^[a-z0-9][a-z0-9_]{2,31}$/

const fmt = (v: BigNumber, decimals: number, places = 4) => {
  const n = Number(ethers.utils.formatUnits(v, decimals))
  if (n === 0) return '0'
  if (n < 10 ** -places) return `<${10 ** -places}`
  return n.toLocaleString('en-US', { maximumFractionDigits: places })
}

/** The two assets the header always accounts for — what a payer is told to send. */
const ETH_ASSET = ASSETS.find((a) => a.key === 'eth')
const USDG_ASSET = ASSETS.find((a) => a.key === 'usdg')

export function StealthReceive() {
  const { signer, address, keys: vaultKeys, go } = useAccountState()

  const [status, setStatus] = useState<StealthStatus | null>(null)
  const [relayFees, setRelayFees] = useState<Record<string, string>>({})
  const [gasReserve, setGasReserve] = useState<BigNumber | undefined>(undefined)

  const [keys, setKeys] = useState<StealthKeys | null>(null)
  const [unlocking, setUnlocking] = useState(false)

  // The first-visit username gate. `gate` is null until we know whether it has been passed
  // (claimed or skipped) for this wallet; false means show the intro, true means show Receive.
  const [gate, setGate] = useState<boolean | null>(null)
  const [nameDraft, setNameDraft] = useState('')
  const [available, setAvailable] = useState<boolean | null>(null)
  const [checkingName, setCheckingName] = useState(false)
  const [claiming, setClaiming] = useState(false)
  const [claimedTx, setClaimedTx] = useState(false)

  const [wallets, setWallets] = useState<StealthWallet[]>([])
  const [scanning, setScanning] = useState(false)

  const [receiveAddress, setReceiveAddress] = useState<string | null>(null)
  const [rolling, setRolling] = useState(false)
  const [qr, setQr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)

  const abort = useRef(false)
  // The signature that produced `keys`. Held so the gate (claim OR skip) can PIN it — pinning
  // is what makes the derived identity permanent across unlocks (see session.ts pinSignature).
  const sigRef = useRef<string | null>(null)

  // The tokens the balance scan reads at each address: just the two a payer is told to send.
  const tokenAddresses = useMemo(
    () => (USDG_ASSET ? [USDG_ASSET.token.toLowerCase()] : []),
    [],
  )

  const contracts: StealthContracts | null = useMemo(() => {
    if (!status?.enabled || !status.announcer || !status.registry) return null
    return { announcer: status.announcer, registry: status.registry, forwarder: status.forwarder ?? null }
  }, [status])

  const windowHours = status?.pendingWindowHours ?? 12

  // ---- status + relayer info ----------------------------------------------
  useEffect(() => {
    fetchStealthStatus().then(setStatus).catch(() => setStatus({ enabled: false }))
    fetchRelayInfo().then((r) => r?.minFee && setRelayFees(r.minFee)).catch(() => {})
    nativeGasReserve().then(setGasReserve).catch(() => {})
  }, [])

  // ---- derive the stealth identity, silently ------------------------------
  // The extension's signer is a local key, so `signMessage` needs no user prompt. A pinned or
  // live session signature short-circuits the sign, exactly as the vault sign-in does.
  useEffect(() => {
    if (!signer || !address || keys) return
    let alive = true
    setUnlocking(true)
    setError(null)
    ;(async () => {
      try {
        const cached = (await pinnedSignature(address)) ?? (await readStealthSignature(address))
        const signature = cached ?? (await signer.signMessage(STEALTH_SIGN_IN_MESSAGE))
        if (!cached) await writeStealthSignature(address, signature)
        sigRef.current = signature
        if (alive) setKeys(deriveStealthKeys(signature))
      } catch (e) {
        if (alive) setError(friendly(e))
      } finally {
        if (alive) setUnlocking(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [signer, address, keys])

  // ---- the first-visit username gate --------------------------------------
  // Learn whether this wallet has already passed the gate (claimed or skipped). Until we know,
  // `gate` is null and neither the intro nor Receive is shown.
  useEffect(() => {
    if (!address) return
    let alive = true
    stealthGatePassed(address)
      .then((passed) => alive && setGate(passed))
      .catch(() => alive && setGate(false))
    return () => {
      alive = false
    }
  }, [address])

  // Debounced availability check, fired on every keystroke of the name field.
  const cleanName = nameDraft.trim().replace(/^@/, '').toLowerCase()
  useEffect(() => {
    if (!NAME_RE.test(cleanName)) {
      setAvailable(null)
      return
    }
    let cancelled = false
    setCheckingName(true)
    const id = setTimeout(async () => {
      const ok = await checkUsernameAvailable(cleanName)
      if (!cancelled) {
        setAvailable(ok)
        setCheckingName(false)
      }
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
  }, [cleanName])

  // Pass the gate: PIN the signature so the derived identity is permanent, then remember the
  // gate is done. Called by BOTH skip and claim — a skipped wallet must derive the same
  // meta-address forever, exactly as a claimed one does.
  const passGate = useCallback(async () => {
    if (!address) return
    if (sigRef.current) await pinSignature(address, sigRef.current)
    await passStealthGate(address)
    setGate(true)
  }, [address])

  const skip = useCallback(() => {
    void passGate()
  }, [passGate])

  const claim = useCallback(async () => {
    if (!signer || !contracts || !keys || !NAME_RE.test(cleanName)) return
    setClaiming(true)
    setError(null)
    setTxHash(null)
    setNote(null)
    try {
      const hash = await registerStealthKeys(signer, contracts, keys, cleanName, setNote)
      setTxHash(hash)
      setClaimedTx(true)
      // Registration is on chain now — pin the identity and drop the gate.
      await passGate()
      setNameDraft('')
    } catch (e) {
      setError(friendly(e))
    } finally {
      setClaiming(false)
      setNote(null)
    }
  }, [signer, contracts, keys, cleanName, passGate])

  // ---- scan: which announcements are ours, and what is in them ------------
  const scan = useCallback(async () => {
    if (!keys || !status?.enabled) return
    abort.current = false
    setScanning(true)
    setError(null)
    try {
      const found: ReturnType<typeof scanAnnouncements> = []
      let cursor = { fromBlock: status.deployBlock ?? 0, fromLogIndex: 0 }
      for (;;) {
        if (abort.current) break
        const page = await fetchAnnouncements({ ...cursor, limit: 500 })
        found.push(...scanAnnouncements(keys, page.announcements))
        if (page.done || !page.next) break
        cursor = page.next
      }
      const balances = await loadBalances(readProvider, found.map((f) => f.address), tokenAddresses)
      const list = toWallets(found, balances)
      list.sort(
        (a, b) => Number(a.empty) - Number(b.empty) || Number(a.dust) - Number(b.dust) || b.blockNumber - a.blockNumber,
      )
      setWallets(list)
    } catch (e) {
      setError(friendly(e))
    } finally {
      setScanning(false)
    }
  }, [keys, status, tokenAddresses])

  useEffect(() => {
    if (keys && status?.enabled) void scan()
    return () => {
      abort.current = true
    }
  }, [keys, status?.enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- the one-time receive address ---------------------------------------
  // Reuses the held address unless it has been paid; `force` is the Regenerate button.
  const roll = useCallback(
    async (force = false) => {
      if (!keys || !address) return
      const paid = new Set(wallets.filter((w) => !w.empty).map((w) => w.address.toLowerCase()))
      const held = await heldAddress(address, windowHours)

      if (!force && held && !shouldRotate(held, paid)) {
        setReceiveAddress(held.address)
        return
      }

      setRolling(true)
      setError(null)
      try {
        const payment = generateStealthAddress(keys.metaAddress)
        setReceiveAddress(payment.stealthAddress)
        await holdAddress(address, {
          address: payment.stealthAddress,
          ephemeralPublicKey: payment.ephemeralPublicKey,
          viewTag: payment.viewTag,
        })
        // Park it so the backend announces it once money lands — the payer cannot.
        await registerPending({
          stealthAddress: payment.stealthAddress,
          ephemeralPubKey: payment.ephemeralPublicKey,
          viewTag: payment.viewTag,
          username: null,
        }).catch(async (e) => {
          await clearHeldAddress(address)
          setError(`This address may not be detected automatically (${friendly(e)}). Try regenerating it.`)
        })
      } catch (e) {
        setError(friendly(e))
      } finally {
        setRolling(false)
      }
    },
    [keys, address, wallets, windowHours],
  )

  useEffect(() => {
    if (keys && !receiveAddress) void roll()
  }, [keys, receiveAddress, roll])

  // A scan that finds the held address funded retires it: offering it again would link the
  // next payment to the one just received.
  useEffect(() => {
    if (!address || !keys) return
    ;(async () => {
      const held = await heldAddress(address, windowHours)
      const paid = new Set(wallets.filter((w) => !w.empty).map((w) => w.address.toLowerCase()))
      if (shouldRotate(held, paid)) {
        await clearHeldAddress(address)
        setReceiveAddress(null)
      }
    })()
  }, [wallets, address, keys, windowHours])

  // ---- QR of the current address ------------------------------------------
  useEffect(() => {
    if (!receiveAddress) {
      setQr(null)
      return
    }
    let alive = true
    QRCode.toDataURL(receiveAddress, {
      margin: 1,
      width: 320,
      errorCorrectionLevel: 'M',
      color: { dark: '#0b0d0a', light: '#ffffff' },
    })
      .then((url) => alive && setQr(url))
      .catch(() => alive && setQr(null))
    return () => {
      alive = false
    }
  }, [receiveAddress])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(t)
  }, [copied])

  const copy = useCallback(() => {
    if (!receiveAddress) return
    void navigator.clipboard.writeText(receiveAddress)
    setCopied(true)
  }, [receiveAddress])

  // ---- totals across ALL discovered addresses -----------------------------
  const real = useMemo(() => wallets.filter((w) => !w.empty && !w.dust), [wallets])
  const grand = useMemo(() => totals(real), [real])

  const fees = useMemo(() => ({ token: relayFees, native: gasReserve }), [relayFees, gasReserve])

  // Every (address, asset) that can actually be shielded, given live balances + fees.
  const shieldTargets = useMemo(() => {
    const assets = [ETH_ASSET, USDG_ASSET].filter(Boolean) as AssetMeta[]
    const targets: { wallet: StealthWallet; asset: AssetMeta; mode: 'self' | 'sponsored' }[] = []
    for (const w of real) {
      for (const a of assets) {
        const mode = depositMode(w, a, fees)
        if (mode !== 'none') targets.push({ wallet: w, asset: a, mode })
      }
    }
    return targets
  }, [real, fees])

  const ethTotal = grand.native
  const usdgTotal = USDG_ASSET ? grand.tokens[USDG_ASSET.token.toLowerCase()] ?? Zero : Zero

  // ---- shield to vault ----------------------------------------------------
  // Shields every shieldable balance, in turn, into the MAIN wallet's vault. No consolidation:
  // the deposit's output note is minted to the main wallet's note keys inside the deposit.
  const shieldAll = useCallback(async () => {
    if (!keys) return
    if (!vaultKeys) {
      setError('The wallet is still signing in — try again in a moment.')
      return
    }
    if (shieldTargets.length === 0) return
    setBusy(true)
    setError(null)
    setTxHash(null)
    setClaimedTx(false)
    let last: string | null = null
    let done = 0
    try {
      for (const [i, t] of shieldTargets.entries()) {
        setNote(`Shielding ${t.asset.symbol} (${i + 1}/${shieldTargets.length})…`)
        // Re-decide the road per target: balances are a scan old, and a stale mode could send
        // a balance down a path that no longer applies.
        const mode = depositMode(t.wallet, t.asset, fees)
        if (mode === 'none') continue
        last =
          mode === 'sponsored'
            ? await sponsoredTokenDeposit(keys, vaultKeys, contracts!, t.wallet, t.asset, { onProgress: setNote })
            : await depositWalletToVault(keys, vaultKeys, t.wallet, t.asset, { onProgress: setNote, reserve: gasReserve })
        done++
      }
      if (last) setTxHash(last)
      if (done === 0) setError('Nothing could be shielded — balances may be below the fee.')
      await scan()
    } catch (e) {
      console.error('[stealth] shield failed', e)
      setError(friendly(e))
    } finally {
      setBusy(false)
      setNote(null)
    }
  }, [keys, vaultKeys, contracts, shieldTargets, fees, gasReserve, scan])

  // ---- render -------------------------------------------------------------

  if (status && !status.enabled) {
    return (
      <div className="space-y-3">
        <ScreenHeader title="Receive privately" onBack={() => go('home')} icon={<Shield width={14} height={14} />} />
        <section className="card text-center">
          <Shield width={20} height={20} className="mx-auto text-muted" />
          <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
            Stealth receiving is not enabled on this deployment yet.
          </p>
        </section>
      </div>
    )
  }

  const hasFunds = !ethTotal.isZero() || !usdgTotal.isZero()

  return (
    <div className="space-y-3">
      <ScreenHeader
        title="Receive privately"
        subtitle="A fresh one-time address every time"
        icon={<Shield width={14} height={14} />}
        onBack={() => go('home')}
      />

      {gate === false ? (
        <UsernameGate
          name={nameDraft}
          onName={setNameDraft}
          available={available}
          checking={checkingName}
          valid={NAME_RE.test(cleanName)}
          claiming={claiming}
          canClaim={Boolean(keys && contracts)}
          onClaim={() => void claim()}
          onSkip={skip}
        />
      ) : gate === null ? (
        <section className="card grid place-items-center py-8">
          <Spinner size={18} />
        </section>
      ) : (
        <>
      {/* One-time address + QR */}
      <section className="card flex flex-col items-center">
        <div className="rounded-2xl bg-white p-3 shadow-card">
          {qr ? (
            <img src={qr} alt="One-time receiving address QR" width={172} height={172} className="block h-[172px] w-[172px]" />
          ) : (
            <div className="grid h-[172px] w-[172px] place-items-center rounded-lg bg-black/10">
              {unlocking || rolling ? <Spinner size={18} /> : null}
            </div>
          )}
        </div>
        <span className="label mt-3 self-start">One-time address</span>
        <p className="inset w-full select-all break-all px-3 py-2.5 font-mono text-[12px] leading-relaxed text-white">
          {receiveAddress ?? (unlocking ? 'Signing in…' : '—')}
        </p>
        <div className="mt-3 flex w-full gap-2">
          <button className="btn-cta flex-1" onClick={copy} disabled={!receiveAddress}>
            <Copy width={15} height={15} />
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button className="btn-ghost flex-1" onClick={() => void roll(true)} disabled={!keys || rolling}>
            {rolling ? <Spinner size={14} /> : <Refresh width={14} height={14} />}
            Regenerate
          </button>
        </div>
        <p className="mt-2 self-start text-[11px] leading-relaxed text-muted">
          Share this to get paid without linking payments to you. A new one is minted once this
          address is paid.
        </p>
      </section>

      {/* Totals received across every one-time address */}
      <section className="card">
        <div className="flex items-center justify-between">
          <span className="label !mb-0">Received</span>
          <span className="text-[11px] text-muted">
            {scanning ? 'Scanning…' : `${real.length} address${real.length === 1 ? '' : 'es'}`}
          </span>
        </div>
        <div className="mt-2 space-y-1.5">
          {ETH_ASSET && (
            <TotalRow asset={ETH_ASSET} amount={fmt(ethTotal, ETH_ASSET.decimals, 5)} />
          )}
          {USDG_ASSET && (
            <TotalRow asset={USDG_ASSET} amount={fmt(usdgTotal, USDG_ASSET.decimals, 2)} />
          )}
        </div>

        <button
          className="btn-cta mt-3 w-full"
          onClick={() => void shieldAll()}
          disabled={busy || !keys || !vaultKeys || shieldTargets.length === 0}
        >
          {busy ? <Spinner size={15} /> : <Shield width={15} height={15} />}
          {busy ? 'Shielding…' : 'Shield to vault'}
        </button>
        <p className="mt-2 text-[11px] leading-relaxed text-muted">
          Deposited <b className="text-white/85">on behalf of your main wallet</b>, straight into
          the pool.
          {shieldTargets.length === 0 && hasFunds
            ? ' Current balances are below the fee needed to move them.'
            : ''}
        </p>
      </section>
        </>
      )}

      <StatusNote status={busy || claiming ? (note ?? 'Working…') : null} error={error} />
      {txHash && <TxLink hash={txHash} label={claimedTx ? 'Username claimed' : 'Shielded to vault'} />}
    </div>
  )
}

function TotalRow({ asset, amount }: { asset: AssetMeta; amount: string }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-edge bg-panel2 px-3 py-2">
      <span className="inline-flex items-center gap-2">
        <TokenIcon symbol={asset.symbol} accent={asset.accent} size={20} src={asset.logoUrl} plain />
        <span className="text-[13px] text-white/80">{asset.symbol}</span>
      </span>
      <span className="num text-[14px] !text-gold">{amount}</span>
    </div>
  )
}

/**
 * The first-visit gate. Offers a memorable @handle to be paid at — a small on-chain claim — and
 * a way to skip straight to receiving. Either choice PINS the stealth identity behind the scenes
 * (see `passGate`), so the derived one-time addresses are permanent from here on.
 */
function UsernameGate({
  name,
  onName,
  available,
  checking,
  valid,
  claiming,
  canClaim,
  onClaim,
  onSkip,
}: {
  name: string
  onName: (v: string) => void
  available: boolean | null
  checking: boolean
  valid: boolean
  claiming: boolean
  canClaim: boolean
  onClaim: () => void
  onSkip: () => void
}) {
  const taken = valid && available === false
  const free = valid && available === true
  const canSubmit = canClaim && free && !claiming
  return (
    <section className="card">
      <span className="grid h-9 w-9 place-items-center rounded-lg border border-mint/35 bg-mint/10 text-mint">
        <Sparkle width={16} height={16} />
      </span>
      <h3 className="mt-3 text-[15px] font-semibold leading-tight text-white">Claim a username</h3>
      <p className="mt-1 text-[12px] leading-relaxed text-muted">
        Claim a handle so people can pay you at a memorable name instead of a raw address. It takes
        a small amount of gas, once.
      </p>

      <div className="mt-3">
        <span className="label">Username</span>
        <div className="input flex items-center gap-1.5">
          <span className="text-muted">@</span>
          <input
            className="min-w-0 flex-1 bg-transparent text-[13px] text-white outline-none placeholder:text-muted"
            value={name}
            onChange={(e) => onName(e.target.value)}
            placeholder="yourname"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={claiming}
          />
          {name.trim() !== '' &&
            (checking ? (
              <Spinner size={12} />
            ) : taken ? (
              <span className="text-[11px] text-neg">taken</span>
            ) : free ? (
              <span className="text-[11px] text-mint">available</span>
            ) : valid ? null : (
              <span className="text-[11px] text-muted">3–32 a–z 0–9 _</span>
            ))}
        </div>
      </div>

      <button className="btn-cta mt-3 w-full" onClick={onClaim} disabled={!canSubmit}>
        {claiming ? <Spinner size={15} /> : <Sparkle width={15} height={15} />}
        {claiming ? 'Claiming…' : 'Claim username'}
      </button>
      <button
        className="press mx-auto mt-2 block text-[12px] font-medium text-muted transition hover:text-white disabled:opacity-40"
        onClick={onSkip}
        disabled={claiming}
      >
        Skip
      </button>
    </section>
  )
}

/** The message a user actually gets — dig for the node's innermost reason, fall back to the
 *  ethers summary. */
function friendly(e: unknown): string {
  const err = e as any
  const raw = String(
    err?.error?.data?.message ||
      err?.data?.message ||
      err?.error?.error?.message ||
      err?.error?.message ||
      err?.reason ||
      err?.message ||
      e,
  )
  if (/user rejected|user denied|ACTION_REJECTED/i.test(raw)) return 'Rejected in your wallet'
  if (/insufficient funds/i.test(raw)) return 'This address does not hold enough ETH to pay for the transaction'
  if (/nonce/i.test(raw)) return 'Nonce clash — try again'
  return raw.slice(0, 240)
}
