import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App'
import QuickAddWindow from './QuickAddWindow'
import { AuthProvider } from './state/AuthContext'
import { VaultProvider } from './state/VaultContext'
import { ToastProvider } from './state/ToastContext'
import { isQuickAddWindowSync } from './lib/desktop'

const root = createRoot(document.getElementById('root')!)

// Detect which window we're in via URL hash. The quick-add Tauri window is
// opened with `index.html#quick-add`. It runs a stripped-down React tree
// (no router, no full vault/auth providers) — auth + DEK are read directly
// from Supabase session + the Rust session-state command.
if (isQuickAddWindowSync()) {
  root.render(
    <StrictMode>
      <QuickAddWindow />
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
