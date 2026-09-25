import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App'
import QuickAddWindow from './QuickAddWindow'
import TwoFactorPopover from './TwoFactorPopover'
import { AuthProvider } from './state/AuthContext'
import { VaultProvider } from './state/VaultContext'
import { ToastProvider } from './state/ToastContext'
import { is2faPopoverSync, isQuickAddWindowSync } from './lib/desktop'

const root = createRoot(document.getElementById('root')!)

// Detect which window we're in via URL hash. Each dedicated Tauri window is
// opened with a different hash and renders a different stripped-down React
// tree (no router, no full vault/auth providers).
if (isQuickAddWindowSync()) {
  root.render(
    <StrictMode>
      <QuickAddWindow />
    </StrictMode>,
  )
} else if (is2faPopoverSync()) {
  // The 2FA popover gets ALL its data from the `2fa://show` event payload —
  // no Supabase, no DEK, no Vault context.
  root.render(
    <StrictMode>
      <TwoFactorPopover />
    </StrictMode>,
  )
} else {
  root.render(
    <StrictMode>
      <BrowserRouter>
        <ToastProvider>
          <AuthProvider>
            <VaultProvider>
              <App />
            </VaultProvider>
          </AuthProvider>
        </ToastProvider>
      </BrowserRouter>
    </StrictMode>,
  )
}
