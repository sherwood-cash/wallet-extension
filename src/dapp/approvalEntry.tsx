/**
 * Entry point for the approval popup page (approval.html). Mirrors main.tsx — same RPC
 * override, same i18n + styles — but mounts the <Approval> flow instead of the wallet
 * shell, so a dapp connect/sign request reuses the wallet's vault and look.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '@app/lib/i18n'
import { Approval } from './Approval'
import { initRpcOverride } from '../wallet/rpc'
import '../index.css'

initRpcOverride()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <Approval />
    </I18nProvider>
  </StrictMode>,
)
