import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '@app/lib/i18n'
import { App } from './App'
import './index.css'

// `?view=tab` is the popped-out copy of the popup: same app, but allowed to fill a
// real browser tab. The flag is put on <html> so the stylesheet can undo the fixed
// 360×600 popup box without any component knowing which surface it is on.
if (new URLSearchParams(location.search).get('view') === 'tab') {
  document.documentElement.classList.add('view-tab')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
)
