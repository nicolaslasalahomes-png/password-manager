import { useCallback, useEffect, useRef, useState } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { useAuth } from './state/AuthContext'
import { useVault } from './state/VaultContext'
import { useToast } from './state/ToastContext'
import { useIdleLock } from './lib/useIdleLock'
import {
  checkForUpdate,
  getStoreValue,
  gmailWatchAccounts,
  gmailWatchGet,
  isDesktop,
  onTrayEvent,
  open2faPopover,
  openQuickAddWindow,
  registerHotkey,
  unregisterAllHotkeys,
} from './lib/desktop'
import { startGmailPoller } from './lib/google/poller'
import { clearAccessTokenCache, listAccountCursors } from './lib/google/tokens'
import {
  mustWipeGmailTokens,
  popoverPayloadFor,
  startLockedGmailWatch,
  watchModeFor,
} from './lib/google/lockedWatch'
import { armLockedWatch, wipeLockedWatch } from './lib/google/watchArm'
import { getAuthSenders } from './lib/email'
import type { ParsedMessage } from './lib/google/gmail'
import type { TwoFactorMatch } from './lib/google/twoFactor'
import {
  generateBriefing,
  getBriefingEnabled,
  getLastBriefingMeta,
  isNewDaySince,
} from './lib/briefing'
import { startNotificationScheduler } from './lib/notifications'
import Login from './pages/Login'
import Signup from './pages/Signup'
import MfaChallenge from './pages/MfaChallenge'
import VaultSetup from './pages/VaultSetup'
import VaultUnlock from './pages/VaultUnlock'
import VaultList from './pages/VaultList'
import ItemNew from './pages/ItemNew'
import ItemView from './pages/ItemView'
import VaultImport from './pages/VaultImport'
import QuickAdd from './pages/QuickAdd'
import Inbox from './pages/Inbox'
import InboxSettings from './pages/InboxSettings'
import Todo from './pages/Todo'
import Calendar from './pages/Calendar'
import Notifications from './pages/Notifications'
import BriefingPage from './pages/Briefing'
import Settings from './pages/Settings'
import HotkeyFirstRunModal from './components/HotkeyFirstRunModal'
import UpdateBanner from './components/UpdateBanner'
import FullPageLoader from './components/FullPageLoader'

const HOTKEY_INTENT_KEY = 'keyring-hotkey-intent'
const IDLE_TIMEOUT_STORE_KEY = 'idleLockTimeoutMin'
const DEFAULT_IDLE_TIMEOUT_MIN = 30 // desktop default; web fallback inside the hook

export default function App() {
  const { user, loading: authLoading, mfaPending } = useAuth()

  // KEY-2FA-2: the stronger lock (signed out, or the email code is owed after
  // a fresh sign-in or app launch) holds no Gmail tokens at all.
  useEffect(() => {
    if (!isDesktop()) return
    if (mustWipeGmailTokens({ authLoading, signedIn: !!user, mfaPending })) {
      void wipeLockedWatch()
    }
  }, [authLoading, user, mfaPending])

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

  // Signed in but owes an email-OTP — show only the MFA challenge until verified.
  // The vault is unreachable until mfaPending flips to false.
  if (mfaPending) {
    return (
      <Routes>
        <Route path="*" element={<MfaChallenge />} />
      </Routes>
    )
  }

  // Signed-in shell — owns hotkey, tray, auto-lock, auto-update.
  // All of these need to survive vault lock/unlock cycles.
  return <SignedInShell />
}

function SignedInShell() {
  const { status: vaultStatus, lockVault, dek } = useVault()
  const { user } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()

  // Keep a live ref to vaultStatus so the (mount-once) hotkey handler can
  // always see the current value — not the stale 'locked'/'loading' state
  // captured at the moment the handler was registered.
  const vaultStatusRef = useRef(vaultStatus)
  useEffect(() => {
    vaultStatusRef.current = vaultStatus
  }, [vaultStatus])
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
          // Always open the popover. It handles its own state:
          //   - Signed out → tells user to use main window
          //   - Locked → shows in-popover unlock form
          //   - Unlocked → shows the add-item form
          await openQuickAddWindow()
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

  // Vestigial: kept in case any code path still sets the intent. Most flows
  // now handle locked-state directly in the popover.
  useEffect(() => {
    if (vaultStatus !== 'unlocked') return
    const intent = sessionStorage.getItem(HOTKEY_INTENT_KEY)
    if (intent) {
      sessionStorage.removeItem(HOTKEY_INTENT_KEY)
      if (intent === 'quick-add-window' && isDesktop()) {
        void openQuickAddWindow()
      } else {
        navigate(intent)
      }
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

  // Gmail 2FA watch. Unlocked: the full poller (inbox cache, AI triage,
  // cursor) and it arms the Rust watch with the refresh tokens. Locked
  // (idle auto-lock or Lock): the locked watch keeps popping codes through
  // Rust and holds no DEK and no Gmail token (KEY-2FA-2). This shell only
  // mounts once signed in with the email code done, so 'off' here means
  // no vault yet. Stops on every change via the effect cleanup.
  const watchMode = watchModeFor({
    desktop: isDesktop(),
    signedIn: !!user,
    mfaPending: false,
    vault: vaultStatus,
  })
  // By id: the Supabase user object is replaced on every hourly token refresh,
  // which must not restart the watch (it would lose the locked cursor).
  const watchUserId = user?.id ?? null
  useEffect(() => {
    if (watchMode === 'off' || !watchUserId) return
    if (watchMode === 'locked') {
      // The webview keeps no Gmail access token once the vault locks.
      clearAccessTokenCache()
      const handle = startLockedGmailWatch({
        deps: {
          armedAccountIds: gmailWatchAccounts,
          listAccountCursors,
          fetcherFor: (accountId) => (path) => gmailWatchGet(accountId, path),
          getAuthSenders,
        },
        callbacks: { on2faDetected: pop2fa },
      })
      return () => handle.stop()
    }
    if (!dek) return
    const userId = watchUserId
    const handle = startGmailPoller({
      dek,
      userId,
      callbacks: {
        on2faDetected: pop2fa,
        onAccounts: (accounts) => void armLockedWatch(userId, accounts, dek),
        onError: (account, err) => {
          // Other errors stay in the console to avoid notification spam
          // during transient network blips.
          console.warn('[gmail-poller]', account?.email ?? '(global)', err)
        },
      },
    })
    return () => handle.stop()
  }, [watchMode, dek, watchUserId])

  // Task notification scheduler — fires native macOS notifications based on
  // each task's priority + the user's configured work hours. Only active on
  // desktop + unlocked. Stops on lock or sign-out via effect cleanup.
  useEffect(() => {
    if (!isDesktop() || vaultStatus !== 'unlocked') return
    const handle = startNotificationScheduler()
    return () => handle.stop()
  }, [vaultStatus])

  // Daily briefing — generated on the first app-open of a calendar day (and
  // again only on a NEW day). Covers everything since the last brief, so missed
  // days roll forward. "Last briefed" lives in Supabase (per account), so it
  // survives reinstalls. Triggered on unlock + whenever the window regains
  // focus (catches the case where the vault stayed unlocked across midnight).
  const briefInFlight = useRef(false)
  const maybeBrief = useCallback(async () => {
    if (!isDesktop() || vaultStatus !== 'unlocked' || !dek || !user) return
    if (briefInFlight.current) return
    try {
      if (!(await getBriefingEnabled())) return
      const last = await getLastBriefingMeta()
      if (!isNewDaySince(last?.generated_at ?? null)) return
      briefInFlight.current = true
      await generateBriefing(user.id, dek)
      // No popup — the brief lands silently in the Briefing tab; the sidebar
      // shows an unseen dot until the user opens it.
      window.dispatchEvent(new Event('keyring:briefing-changed'))
    } catch (err) {
      console.warn('[briefing] generation skipped/failed:', err)
    } finally {
      briefInFlight.current = false
    }
  }, [vaultStatus, dek, user])

  useEffect(() => {
    void maybeBrief()
  }, [maybeBrief])

  useEffect(() => {
    const onFocus = () => void maybeBrief()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [maybeBrief])

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
        <Route path="/vault/inbox" element={<Inbox />} />
        <Route path="/vault/inbox/all" element={<Inbox />} />
        <Route path="/vault/inbox/settings" element={<InboxSettings />} />
        <Route path="/vault/todo" element={<Todo />} />
        <Route path="/vault/calendar" element={<Calendar />} />
        <Route path="/vault/notifications" element={<Notifications />} />
        <Route path="/vault/briefing" element={<BriefingPage />} />
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

/** Show the 2FA popover (code, link, sender only: nothing from the vault). */
function pop2fa(
  account: { id: string; email: string },
  parsed: ParsedMessage,
  match: TwoFactorMatch,
): void {
  void open2faPopover(popoverPayloadFor(account, parsed, match))
}
