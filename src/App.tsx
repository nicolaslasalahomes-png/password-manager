import { useCallback, useEffect, useState } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { useAuth } from './state/AuthContext'
import { useVault } from './state/VaultContext'
import { useToast } from './state/ToastContext'
import { useIdleLock } from './lib/useIdleLock'
import {
  getStoreValue,
  isDesktop,
  onTrayEvent,
  registerHotkey,
  showWindow,
  unregisterAllHotkeys,
} from './lib/desktop'
import Login from './pages/Login'
import Signup from './pages/Signup'
import VaultSetup from './pages/VaultSetup'
import VaultUnlock from './pages/VaultUnlock'
import VaultList from './pages/VaultList'
import ItemNew from './pages/ItemNew'
import ItemView from './pages/ItemView'
import VaultImport from './pages/VaultImport'
import QuickAdd from './pages/QuickAdd'
import Settings from './pages/Settings'
import HotkeyFirstRunModal from './components/HotkeyFirstRunModal'
import FullPageLoader from './components/FullPageLoader'

export default function App() {
  const { user, loading: authLoading } = useAuth()
  const { status: vaultStatus, lockVault } = useVault()
  const toast = useToast()

  // Auto-lock after 10min idle or on tab hide
  const onIdle = useCallback(() => {
    if (vaultStatus === 'unlocked') lockVault()
  }, [vaultStatus, lockVault])
  useIdleLock(vaultStatus === 'unlocked', onIdle)

  if (authLoading) return <FullPageLoader label="Loading session…" />

  // Not signed in → auth pages only
  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }

  if (vaultStatus === 'loading') return <FullPageLoader label="Loading vault…" />

  // Signed in but no vault yet → setup
  if (vaultStatus === 'no-vault') {
    return (
      <Routes>
        <Route path="/setup" element={<VaultSetup />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    )
  }

  // Signed in, vault exists but locked → unlock
  if (vaultStatus === 'locked') {
    return (
      <Routes>
        <Route path="/unlock" element={<VaultUnlock />} />
        <Route path="*" element={<Navigate to="/unlock" replace />} />
      </Routes>
    )
  }

  // Fully unlocked — render main routes + desktop-only side effects
  return (
    <UnlockedShell toast={toast} lockVault={lockVault}>
      <Routes>
        <Route path="/vault" element={<VaultList />} />
        <Route path="/vault/new" element={<ItemNew />} />
        <Route path="/vault/import" element={<VaultImport />} />
        <Route path="/vault/quick-add" element={<QuickAdd />} />
        <Route path="/vault/settings" element={<Settings />} />
        <Route path="/vault/:id" element={<ItemView />} />
        <Route path="*" element={<Navigate to="/vault" replace />} />
      </Routes>
    </UnlockedShell>
  )
}

/** Runs effects that only make sense once vault is unlocked AND we're on desktop. */
function UnlockedShell({
  children,
  toast,
  lockVault,
}: {
  children: React.ReactNode
  toast: ReturnType<typeof useToast>
  lockVault: () => void
}) {
  const navigate = useNavigate()
  const [showFirstRun, setShowFirstRun] = useState(false)

  // Re-register the saved hotkey on every unlocked-mount (or never on web)
  useEffect(() => {
    if (!isDesktop()) return
    let cancelled = false
    ;(async () => {
      const combo = await getStoreValue<string>('quickAddHotkey')
      const prompted = await getStoreValue<string>('hotkeyPromptedAt')
      if (cancelled) return
      if (combo) {
        await registerHotkey(combo, async () => {
          await showWindow()
          navigate('/vault/quick-add')
        })
      } else if (!prompted) {
        // First unlocked session — show the wizard
        setShowFirstRun(true)
      }
    })()
    return () => {
      cancelled = true
      void unregisterAllHotkeys()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Tray menu items → app actions
  useEffect(() => {
    if (!isDesktop()) return
    let unsubLock: (() => void) | null = null
    let unsubSettings: (() => void) | null = null
    void onTrayEvent('lock', () => {
      lockVault()
      toast.info('Vault locked')
    }).then((u) => (unsubLock = u))
    void onTrayEvent('settings', () => navigate('/vault/settings')).then(
      (u) => (unsubSettings = u),
    )
    return () => {
      unsubLock?.()
      unsubSettings?.()
    }
  }, [lockVault, toast, navigate])

  return (
    <>
      {children}
      {showFirstRun && <HotkeyFirstRunModal onDismiss={() => setShowFirstRun(false)} />}
    </>
  )
}
