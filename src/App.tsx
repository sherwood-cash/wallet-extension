/**
 * The popup's root. Three states, in order:
 *
 *   no keystore  -> Onboarding (create or import)
 *   keystore, no session key -> Unlock
 *   unlocked -> the wallet shell
 *
 * Unlocking is also the protocol sign-in: the web app has to pop a wallet prompt to
 * derive note-spending keys, but a local key signs the fixed message silently, so one
 * password gets you all the way in. That happens inside <AccountProvider>.
 */
import { useCallback, useEffect, useState } from 'react'
import { Body, BottomRail, Header } from './components/Shell'
import { AccountProvider } from './state'
import { useVault } from './wallet/useVault'
import { Onboarding } from './screens/Onboarding'
import { Unlock } from './screens/Unlock'
import { Home } from './screens/Home'
import { Deposit } from './screens/Deposit'
import { Swap } from './screens/Swap'
import { Withdraw } from './screens/Withdraw'
import { Receive } from './screens/Receive'
import { Send } from './screens/Send'
import { Settings } from './screens/Settings'
import { Spinner } from './components/ui'
import type { Screen } from './types'

function Splash() {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex flex-col items-center gap-3 text-muted">
        <img src="./parallax/logo-mark.webp" alt="" width={44} height={44} className="rounded-xl opacity-90" />
        <Spinner size={16} />
      </div>
    </div>
  )
}

export function App() {
  const vault = useVault()
  const [screen, setScreen] = useState<Screen>('home')
  const [copied, setCopied] = useState(false)

  const go = useCallback((s: Screen) => setScreen(s), [])

  // Coming back from locked always lands on the wallet, never on a half-filled form.
  useEffect(() => {
    if (vault.status !== 'unlocked') setScreen('home')
  }, [vault.status])

  const copyAddress = useCallback(() => {
    if (!vault.address) return
    void navigator.clipboard.writeText(vault.address)
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }, [vault.address])

  if (vault.status === 'loading') return <Splash />
  if (vault.status === 'empty') return <Onboarding />
  if (vault.status === 'locked') return <Unlock />

  return (
    <AccountProvider signer={vault.signer} address={vault.address} go={go}>
      <div className="flex h-full min-h-0 flex-col">
        <Header address={vault.address} onLock={vault.lock} onCopy={copyAddress} copied={copied} />
        <Body>
          {screen === 'home' && <Home />}
          {screen === 'deposit' && <Deposit />}
          {screen === 'swap' && <Swap />}
          {screen === 'withdraw' && <Withdraw />}
          {screen === 'receive' && <Receive />}
          {screen === 'send' && <Send />}
          {screen === 'settings' && <Settings />}
        </Body>
        <BottomRail screen={screen} onGo={go} />
      </div>
    </AccountProvider>
  )
}
