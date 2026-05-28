import { useCallback, useEffect, useState } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { useAuth } from './state/AuthContext'
import { useVault } from './state/VaultContext'
import { useToast } from './state/ToastContext'
import { useIdleLock } from './lib/useIdleLock'
import {
  checkForUpdate,
  enterQuickAddMode,
  getStoreValue,
  isDesktop,
  onTrayEvent,
  registerHotkey,
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
import UpdateBanner from './components/UpdateBanner'
import FullPageLoader from './components/FullPageLoader'

const HOTKEY_INTENT_KEY = 'keyring-hotkey-intent'
const IDLE_TIMEOUT_STORE_KEY = 'idleLockTimeoutMin'
const DEFAULT_IDLE_TIMEOUT_MIN = 30 // desktop default; web fallback inside the hook

export default function App() {
  const { user, loading: authLoading } = useAuth()

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

  // Signed-in shell — owns hotkey, tray, auto-lock, auto-update.
  // All of these need to survive vault lock/unlock cycles.
  return <SignedInShell />
}

function SignedInShell() {
  const { status: vaultStatus, lockVault } = useVault()
  const toast = useToast()
  const navigate = useNavigate()
  const [showFirstRun, setShowFirstRun] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<{ version: string; currentVersion?: string } | null>(
    null,
  )
  const [bannerDismissed, setBannerDismissed] = useState(false)
  // -1 = not yet loaded from store; 0 = "Never lock"; >0 = minutes.
  const [idleTimeoutMin, setIdleTimeoutMin] = useState<number>(-1)

  // Load persisted idle-lock timeout (desktop only — web uses hook default)
  useEffect(() => {
    if (!isDesktop()) {
      setIdleTimeoutMin(DEFAULT_IDLE_TIMEOUT_MIN)
      return
    }
    getStoreValue<number>(IDLE_TIMEOUT_STORE_KEY).then((v) => {
      setIdleTimeoutMin(typeof v === 'number' ? v : DEFAULT_IDLE_TIMEOUT_MIN)
    })
    // Listen for cross-component setting changes via custom event
    const onSettingChange = (e: Event) => {
      const ce = e as CustomEvent<number>
      setIdleTimeoutMin(ce.detail)
    }
    window.addEventListener('keyring:idle-timeout-changed', onSettingChange)
    return () => window.removeEventListener('keyring:idle-timeout-changed', onSettingChange)
  }, [])

  // Auto-lock on idle. On desktop, only by real inactivity timer — NOT on
  // visibility-hidden (which fires when the user closes the window, clicks
  // off, or we hide after quick-add save). Web keeps lock-on-hide.
  const onIdle = useCallback(() => {
    if (vaultStatus === 'unlocked') {
      lockVault()
      toast.info('Vault locked after inactivity')
    }
  }, [vaultStatus, lockVault, toast])
  // 0 = Never (disable hook entirely); >0 = minutes; -1 = still loading
  const idleActive =
    vaultStatus === 'unlocked' && idleTimeoutMin !== -1 && idleTimeoutMin !== 0
  useIdleLock(idleActive, onIdle, {
    timeoutMs: idleTimeoutMin > 0 ? idleTimeoutMin * 60 * 1000 : undefined,
  })

  // Global hotkey — registered while signed in regardless of vault state.
  // When pressed while locked, the navigate to /vault/quick-add gets
  // redirected to /unlock by the routing below; we set a session intent so
  // we resume the quick-add intent after unlock completes.
  useEffect(() => {
    if (!isDesktop()) return
    let cancelled = false
    ;(async () => {
      const combo = await getStoreValue<string>('quickAddHotkey')
      const prompted = await getStoreValue<string>('hotkeyPromptedAt')
      if (cancelled) return
      if (combo) {
        await registerHotkey(combo, async () => {
          sessionStorage.setItem(HOTKEY_INTENT_KEY, '/vault/quick-add')
          await enterQuickAddMode() // resize + dock top-right + show + focus
          navigate('/vault/quick-add')
        })
      } else if (!prompted && vaultStatus === 'unlocked') {
        // First unlocked session — show the wizard
        setShowFirstRun(true)
      }
    })()
    return () => {
      cancelled = true
      void unregisterAllHotkeys()
    }
    // We intentionally don't re-register on every render. vaultStatus is
    // only read for the first-run wizard gating.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // When vault transitions to unlocked, consume any pending hotkey intent.
  useEffect(() => {
    if (vaultStatus !== 'unlocked') return
    const intent = sessionStorage.getItem(HOTKEY_INTENT_KEY)
    if (intent) {
      sessionStorage.removeItem(HOTKEY_INTENT_KEY)
      navigate(intent)
    }
  }, [vaultStatus, navigate])

  // Background check for updates once per launch (silent — only surfaces
  // if an update exists, and only on desktop).
  useEffect(() => {
    if (!isDesktop()) return
    let cancelled = false
    void checkForUpdate().then((info) => {
      if (cancelled) return
      if (info.available && info.version) {
        setUpdateInfo({ version: info.version, currentVersion: info.currentVersion })
      }
    })
    return () => {
      cancelled = true
    }
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

  // Vault state → routing
  let inner: React.ReactNode
  if (vaultStatus === 'loading') {
    inner = <FullPageLoader label="Loading vault…" />
  } else if (vaultStatus === 'no-vault') {
    inner = (
      <Routes>
        <Route path="/setup" element={<VaultSetup />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    )
  } else if (vaultStatus === 'locked') {
    inner = (
      <Routes>
        <Route path="/unlock" element={<VaultUnlock />} />
        <Route path="*" element={<Navigate to="/unlock" replace />} />
      </Routes>
    )
  } else {
    inner = (
      <Routes>
        <Route path="/vault" element={<VaultList />} />
        <Route path="/vault/new" element={<ItemNew />} />
        <Route path="/vault/import" element={<VaultImport />} />
        <Route path="/vault/quick-add" element={<QuickAdd />} />
        <Route path="/vault/settings" element={<Settings />} />
        <Route path="/vault/:id" element={<ItemView />} />
        <Route path="*" element={<Navigate to="/vault" replace />} />
      </Routes>
    )
  }

  return (
    <>
      {updateInfo && !bannerDismissed && vaultStatus === 'unlocked' && (
        <UpdateBanner
          version={updateInfo.version}
          currentVersion={updateInfo.currentVersion}
          onDismiss={() => setBannerDismissed(true)}
        />
      )}
      {inner}
      {showFirstRun && <HotkeyFirstRunModal onDismiss={() => setShowFirstRun(false)} />}
    </>
  )
}
