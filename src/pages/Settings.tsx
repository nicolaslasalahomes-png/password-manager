import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  Cpu,
  Download,
  ExternalLink,
  Eye,
  Keyboard as KeyboardIcon,
  KeyRound,
  Loader2,
  LogOut,
  Palette,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import Layout from '../components/Layout'
import ChangeMasterPasswordModal from '../components/ChangeMasterPasswordModal'
import HotkeyRecorder, { comboToGlyph } from '../components/HotkeyRecorder'
import { useAuth } from '../state/AuthContext'
import { useVault } from '../state/VaultContext'
import { useToast } from '../state/ToastContext'
import {
  generateBriefing,
  getBriefingEnabled,
  markBriefingsSeen,
  setBriefingEnabled,
} from '../lib/briefing'
import { type UsageStore, getUsage, resetUsage } from '../lib/ai/usage'
import { openExternalUrl } from '../lib/desktop'
import {
  checkForUpdate,
  downloadAndInstallUpdate,
  getStoreValue,
  registerHotkey,
  setStoreValue,
  unregisterAllHotkeys,
  unregisterHotkey,
  useIsDesktop,
  showWindow,
} from '../lib/desktop'
import { useNavigate } from 'react-router-dom'
import {
  type Theme,
  type TextTone,
  NIGHT,
  PRESETS,
  effectiveBackground,
  loadTheme,
  matchPreset,
  parseHex,
  saveTheme,
} from '../lib/theme'

const HOTKEY_STORE_KEY = 'quickAddHotkey'

export default function Settings() {
  const { user, signOut } = useAuth()
  const { lockVault } = useVault()
  const toast = useToast()
  const navigate = useNavigate()
  const isDesktop = useIsDesktop()

  const [hotkey, setHotkey] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [changeMasterPwOpen, setChangeMasterPwOpen] = useState(false)
  const [idleTimeoutMin, setIdleTimeoutMin] = useState<number>(30)
  const [installedVersion, setInstalledVersion] = useState<string | null>(null)
  const [updateStatus, setUpdateStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'checking' }
    | { kind: 'available'; version: string; current?: string; body?: string }
    | { kind: 'none'; current?: string }
    | { kind: 'downloading'; pct: number | null }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' })

  useEffect(() => {
    if (!isDesktop) {
      setLoaded(true)
      return
    }
    Promise.all([
      getStoreValue<string>(HOTKEY_STORE_KEY),
      getStoreValue<number>('idleLockTimeoutMin'),
      import('@tauri-apps/api/app').then((m) => m.getVersion()).catch(() => null),
    ]).then(([h, t, v]) => {
      setHotkey(h)
      if (typeof t === 'number') setIdleTimeoutMin(t)
      setInstalledVersion(typeof v === 'string' ? v : null)
      setLoaded(true)
    })
  }, [isDesktop])

  async function changeIdleTimeout(minutes: number) {
    setIdleTimeoutMin(minutes)
    await setStoreValue('idleLockTimeoutMin', minutes)
    // Notify App.tsx so the useIdleLock hook reconfigures immediately
    window.dispatchEvent(
      new CustomEvent<number>('keyring:idle-timeout-changed', { detail: minutes }),
    )
    toast.success(
      minutes === 0
        ? 'Auto-lock disabled'
        : `Vault will auto-lock after ${minutes} min of inactivity`,
    )
  }

  async function saveHotkey(combo: string | null) {
    setHotkey(combo)
    await setStoreValue(HOTKEY_STORE_KEY, combo)
    await unregisterAllHotkeys()
    if (combo) {
      const ok = await registerHotkey(combo, async () => {
        await showWindow()
        navigate('/vault/quick-add')
      })
      if (!ok) {
        toast.error(`Couldn't register ${comboToGlyph(combo)} — already in use?`)
        return
      }
      toast.success(`Hotkey set to ${comboToGlyph(combo)}`)
    } else {
      toast.info('Hotkey cleared')
    }
  }

  async function tryHotkey(combo: string): Promise<boolean> {
    // Test-register, then unregister so the actual save below is idempotent.
    const ok = await registerHotkey(combo, () => {})
    if (ok) await unregisterHotkey(combo)
    return ok
  }

  return (
    <Layout>
      <header className="mb-5">
        <h1 className="text-lg font-semibold text-ink-50">Settings</h1>
        <p className="mt-0.5 text-xs text-ink-400">
          Account, vault, and {isDesktop ? 'desktop' : 'web'}-specific options.
        </p>
      </header>

      <div className="space-y-6">
        <Section title="Appearance" icon={<Palette size={14} />}>
          <AppearanceControl />
        </Section>

        <Section title="Account" icon={<ShieldCheck size={14} />}>
          <Row label="Signed in as">
            <span className="font-mono text-sm text-ink-100">{user?.email}</span>
          </Row>
          <Row
            label="Email 2FA"
            hint="Email a 6-digit code on every sign-in. Doesn't change the master password — that still gates vault decryption."
          >
            <EmailMfaToggle />
          </Row>
          <Row label="Sign out">
            <button onClick={() => signOut()} className="btn-secondary !py-1.5 !text-xs">
              <LogOut size={12} /> Sign out
            </button>
          </Row>
        </Section>

        <Section title="Vault" icon={<Eye size={14} />}>
          <Row label="Lock vault now">
            <button
              onClick={() => {
                lockVault()
                toast.info('Vault locked')
              }}
              className="btn-secondary !py-1.5 !text-xs"
            >
              Lock now
            </button>
          </Row>
          <Row label="Change master password" hint="Re-wraps the data key with the new password. Items stay decryptable.">
            <button
              onClick={() => setChangeMasterPwOpen(true)}
              className="btn-secondary !py-1.5 !text-xs"
            >
              <KeyRound size={12} /> Change…
            </button>
          </Row>
          <Row
            label="Auto-lock after inactivity"
            hint={
              idleTimeoutMin === 0
                ? 'Vault never locks automatically. You can still lock manually.'
                : `Vault locks if you don't interact with it for ${idleTimeoutMin} minutes.`
            }
          >
            <select
              value={idleTimeoutMin}
              onChange={(e) => void changeIdleTimeout(Number(e.target.value))}
              className="input w-auto !py-1.5 !text-xs"
            >
              <option value={1}>1 minute</option>
              <option value={5}>5 minutes</option>
              <option value={10}>10 minutes</option>
              <option value={15}>15 minutes</option>
              <option value={30}>30 minutes (default)</option>
              <option value={60}>1 hour</option>
              <option value={240}>4 hours</option>
              <option value={480}>8 hours</option>
              <option value={0}>Never</option>
            </select>
          </Row>
        </Section>

        {isDesktop && (
          <Section title="Tasks & notifications" icon={<Cpu size={14} />}>
            <Row
              label="Work hours"
              hint="Notifications only fire during these hours, on the selected days."
              vertical
            >
              <WorkHoursControl />
            </Row>
            <Row
              label="Notification permission"
              hint="macOS needs your one-time approval. Required for any reminders to appear."
            >
              <NotificationPermissionControl />
            </Row>
            <Row
              label="Daily briefing"
              hint="Once per day on first open, Claude writes a short 'what to focus on' from your open tasks + important emails since your last brief. Needs your Anthropic key (Inbox Settings). Task titles & email subjects are sent to Claude — never secret values."
              vertical
            >
              <BriefingControl />
            </Row>
          </Section>
        )}

        {isDesktop && (
          <Section title="AI usage" icon={<Sparkles size={14} />}>
            <Row
              label="Claude spend (estimated)"
              hint="Counts only Keyring's own calls (inbox classifier + daily brief). Cost is an estimate from current Haiku pricing — the authoritative bill is in your Anthropic console."
              vertical
            >
              <UsageControl />
            </Row>
          </Section>
        )}

        {isDesktop && (
          <Section title="Desktop" icon={<Cpu size={14} />}>
            <Row
              label="Quick-add hotkey"
              hint="Press this combo from any app to open Quick Add."
              vertical
            >
              {loaded ? (
                <HotkeyRecorder
                  value={hotkey}
                  onChange={saveHotkey}
                  onTryRegister={tryHotkey}
                />
              ) : (
                <p className="text-xs text-ink-400">Loading…</p>
              )}
            </Row>
            <Row label="Launch on login" hint="Start Keyring automatically when you sign in.">
              <button disabled className="btn-secondary !py-1.5 !text-xs opacity-50">
                Coming soon
              </button>
            </Row>
            <Row
              label="App updates"
              hint="Check GitHub Releases for a newer signed build of Keyring."
              vertical
            >
              <UpdateControls status={updateStatus} setStatus={setUpdateStatus} />
            </Row>
            <Row label="Installed version">
              <span className="font-mono text-xs text-ink-200">
                {installedVersion ? `v${installedVersion}` : '—'}
              </span>
            </Row>
          </Section>
        )}

        {!isDesktop && (
          <Section title="Desktop app" icon={<KeyboardIcon size={14} />}>
            <div className="flex items-start gap-3 rounded-lg border border-accent-500/30 bg-accent-950/30 p-3 text-sm text-accent-100">
              <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-medium">Get the desktop app for the global hotkey</p>
                <p className="mt-1 text-xs text-accent-200/80">
                  Install Keyring as a Mac app to get a global hotkey for instant access from any app.
                  Download coming soon.
                </p>
              </div>
            </div>
          </Section>
        )}
      </div>

      {changeMasterPwOpen && (
        <ChangeMasterPasswordModal onClose={() => setChangeMasterPwOpen(false)} />
      )}
    </Layout>
  )
}

/**
 * Email 2FA enrollment toggle.
 *
 * When turning ON we don't trust the user to receive emails until they prove
 * it: we send a test code, they enter it, only THEN do we flip the
 * email_2fa_enabled flag in user_metadata. That way nobody enables 2FA and
 * locks themselves out because their typo'd email address can't receive code.
 *
 * When turning OFF, no challenge — they're already signed in past the gate.
 */
function EmailMfaToggle() {
  const { emailMfaEnabled, setEmailMfaEnabled, sendMfaCode, verifyMfaCode } = useAuth()
  const toast = useToast()
  const [stage, setStage] = useState<'idle' | 'sending' | 'awaiting' | 'verifying'>('idle')
  const [code, setCode] = useState('')

  async function onTurnOn() {
    setStage('sending')
    try {
      await sendMfaCode()
      setStage('awaiting')
      toast.info('Check your email for the test code')
    } catch (err) {
      setStage('idle')
      toast.error(err instanceof Error ? err.message : 'Could not send test code')
    }
  }

  async function onConfirm() {
    if (!/^\d{6}$/.test(code)) {
      toast.error('Code must be 6 digits')
      return
    }
    setStage('verifying')
    try {
      await verifyMfaCode(code)
      await setEmailMfaEnabled(true)
      toast.success('Email 2FA enabled')
      setStage('idle')
      setCode('')
    } catch (err) {
      setStage('awaiting')
      toast.error(err instanceof Error ? err.message : 'Verification failed')
    }
  }

  async function onTurnOff() {
    try {
      await setEmailMfaEnabled(false)
      toast.success('Email 2FA disabled')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not disable')
    }
  }

  if (emailMfaEnabled) {
    return (
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-300">
          <ShieldCheck size={12} /> Enabled
        </span>
        <button onClick={onTurnOff} className="btn-secondary !py-1.5 !text-xs">
          Disable
        </button>
      </div>
    )
  }

  if (stage === 'awaiting' || stage === 'verifying') {
    return (
      <div className="flex items-center gap-2">
        <input
          type="text"
          inputMode="numeric"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="6-digit code"
          className="input-mono !w-32 text-center !text-sm tracking-[6px]"
          autoFocus
        />
        <button
          onClick={onConfirm}
          disabled={stage === 'verifying' || code.length !== 6}
          className="btn-primary !py-1.5 !text-xs"
        >
          {stage === 'verifying' ? 'Verifying…' : 'Confirm'}
        </button>
      </div>
    )
  }

  return (
    <button
      onClick={onTurnOn}
      disabled={stage === 'sending'}
      className="btn-secondary !py-1.5 !text-xs"
    >
      <ShieldCheck size={12} /> {stage === 'sending' ? 'Sending…' : 'Enable Email 2FA'}
    </button>
  )
}

function WorkHoursControl() {
  const toast = useToast()
  const [start, setStart] = useState('09:00')
  const [end, setEnd] = useState('18:00')
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5])
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void (async () => {
      const { getWorkHours } = await import('../lib/tasks')
      const wh = await getWorkHours()
      setStart(wh.start)
      setEnd(wh.end)
      setDays(wh.days)
      setLoaded(true)
    })()
  }, [])

  function toggleDay(d: number) {
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()))
  }

  async function save() {
    setSaving(true)
    try {
      const { setWorkHours } = await import('../lib/tasks')
      await setWorkHours({ start, end, days })
      toast.success('Work hours saved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  if (!loaded) return <span className="text-xs text-ink-400">Loading…</span>
  const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input
          type="time"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          className="input !py-1.5 text-xs"
        />
        <span className="text-xs text-ink-400">to</span>
        <input
          type="time"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          className="input !py-1.5 text-xs"
        />
      </div>
      <div className="flex flex-wrap gap-1">
        {DAY_LABELS.map((label, i) => (
          <button
            key={i}
            type="button"
            onClick={() => toggleDay(i)}
            className={`h-7 w-7 rounded text-[11px] font-medium transition ${
              days.includes(i)
                ? 'bg-accent-600/20 text-accent-200 ring-1 ring-accent-600/40'
                : 'bg-ink-800 text-ink-400 hover:text-ink-100'
            }`}
            title={['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][i]}
          >
            {label}
          </button>
        ))}
        <button onClick={save} disabled={saving} className="btn-primary ml-auto !px-3 !py-1.5 !text-xs">
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

function UsageControl() {
  const toast = useToast()
  const [usage, setUsage] = useState<UsageStore | null>(null)

  const refresh = () => getUsage().then(setUsage).catch(() => {})
  useEffect(() => {
    void refresh()
  }, [])

  const fmt = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`
  const tokens = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

  return (
    <div className="w-full space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-ink-800 bg-ink-900/40 p-3">
          <div className="text-[11px] uppercase tracking-wider text-ink-500">This month</div>
          <div className="mt-1 text-lg font-semibold text-ink-50">
            {usage ? fmt(usage.monthCostUsd) : '—'}
          </div>
          <div className="text-[11px] text-ink-400">{usage?.monthCalls ?? 0} calls</div>
        </div>
        <div className="rounded-lg border border-ink-800 bg-ink-900/40 p-3">
          <div className="text-[11px] uppercase tracking-wider text-ink-500">All time</div>
          <div className="mt-1 text-lg font-semibold text-ink-50">
            {usage ? fmt(usage.totalCostUsd) : '—'}
          </div>
          <div className="text-[11px] text-ink-400">
            {usage ? `${tokens(usage.totalInput)} in · ${tokens(usage.totalOutput)} out` : ''}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => void openExternalUrl('https://console.anthropic.com/settings/usage')}
          className="btn-secondary !py-1.5 !text-xs"
        >
          <ExternalLink size={12} /> Open Anthropic console
        </button>
        <button
          onClick={async () => {
            if (!confirm('Reset the local usage counter to zero?')) return
            await resetUsage()
            await refresh()
            toast.success('Usage reset')
          }}
          className="btn-ghost !py-1.5 !text-xs !text-ink-400"
        >
          Reset counter
        </button>
      </div>
    </div>
  )
}

function BriefingControl() {
  const toast = useToast()
  const { dek } = useVault()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [enabled, setEnabled] = useState(false)
  const [generating, setGenerating] = useState(false)

  useEffect(() => {
    getBriefingEnabled().then(setEnabled).catch(() => {})
  }, [])

  async function onToggle(v: boolean) {
    try {
      await setBriefingEnabled(v)
      setEnabled(v)
      toast.success(v ? 'Daily briefing on' : 'Daily briefing off')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not toggle')
    }
  }

  async function onGenerateNow() {
    if (!user || !dek) {
      toast.error('Unlock the vault first')
      return
    }
    setGenerating(true)
    try {
      await generateBriefing(user.id, dek)
      await markBriefingsSeen()
      toast.success('Brief generated')
      navigate('/vault/briefing')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not generate brief')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => void onToggle(e.target.checked)}
          className="h-4 w-4 accent-accent-500"
        />
        <span className="text-xs text-ink-300">
          {enabled ? 'On — brief on first open each day' : 'Off'}
        </span>
      </label>
      <button
        onClick={onGenerateNow}
        disabled={generating}
        className="btn-secondary !py-1.5 !text-xs"
      >
        <Sparkles size={12} /> {generating ? 'Writing…' : 'Generate one now'}
      </button>
    </div>
  )
}

function NotificationPermissionControl() {
  const toast = useToast()
  const [granted, setGranted] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const { isPermissionGranted } = await import('@tauri-apps/plugin-notification')
        setGranted(await isPermissionGranted())
      } catch {
        setGranted(false)
      }
    })()
  }, [])

  async function onRequest() {
    setBusy(true)
    try {
      const { requestNotificationPermissionOnce } = await import('../lib/notifications')
      const ok = await requestNotificationPermissionOnce()
      setGranted(ok)
      toast[ok ? 'success' : 'error'](
        ok ? 'Notifications enabled' : 'Permission denied — enable in System Settings → Notifications',
      )
    } finally {
      setBusy(false)
    }
  }

  if (granted === null) return <span className="text-xs text-ink-400">Checking…</span>
  if (granted) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-300">
        <ShieldCheck size={12} /> Granted
      </span>
    )
  }
  return (
    <button onClick={onRequest} disabled={busy} className="btn-secondary !py-1.5 !text-xs">
      {busy ? 'Requesting…' : 'Request permission'}
    </button>
  )
}

function UpdateControls({
  status,
  setStatus,
}: {
  status:
    | { kind: 'idle' }
    | { kind: 'checking' }
    | { kind: 'available'; version: string; current?: string; body?: string }
    | { kind: 'none'; current?: string }
    | { kind: 'downloading'; pct: number | null }
    | { kind: 'error'; message: string }
  setStatus: (s: typeof status) => void
}) {
  async function onCheck() {
    setStatus({ kind: 'checking' })
    const info = await checkForUpdate()
    if (info.available && info.version) {
      setStatus({
        kind: 'available',
        version: info.version,
        current: info.currentVersion,
        body: info.body,
      })
    } else {
      setStatus({ kind: 'none', current: info.currentVersion })
    }
  }

  async function onInstall() {
    setStatus({ kind: 'downloading', pct: null })
    try {
      await downloadAndInstallUpdate((downloaded, total) => {
        const pct = total ? Math.round((downloaded / total) * 100) : null
        setStatus({ kind: 'downloading', pct })
      })
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : 'Update failed' })
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {status.kind === 'idle' && (
        <button onClick={onCheck} className="btn-secondary self-start !py-1.5 !text-xs">
          <Download size={12} /> Check for updates
        </button>
      )}
      {status.kind === 'checking' && (
        <div className="inline-flex items-center gap-2 text-xs text-ink-300">
          <Loader2 size={12} className="animate-spin" /> Checking…
        </div>
      )}
      {status.kind === 'none' && (
        <div className="text-xs text-ink-300">
          You're on the latest version
          {status.current && <span className="text-ink-500"> ({status.current})</span>}.
          <button
            onClick={onCheck}
            className="ml-2 text-accent-300 hover:text-accent-200"
          >
            Re-check
          </button>
        </div>
      )}
      {status.kind === 'available' && (
        <div className="space-y-2">
          <p className="text-xs text-ink-100">
            Update available: <span className="font-mono">{status.version}</span>
            {status.current && (
              <span className="text-ink-500"> (you have {status.current})</span>
            )}
          </p>
          {status.body && (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded border border-ink-700 bg-ink-800 p-2 text-xs text-ink-200">
              {status.body}
            </pre>
          )}
          <button onClick={onInstall} className="btn-primary !py-1.5 !text-xs">
            <Download size={12} /> Install &amp; restart
          </button>
        </div>
      )}
      {status.kind === 'downloading' && (
        <div className="inline-flex items-center gap-2 text-xs text-ink-300">
          <Loader2 size={12} className="animate-spin" />
          Downloading {status.pct !== null ? `${status.pct}%` : '…'}
        </div>
      )}
      {status.kind === 'error' && (
        <div className="text-xs text-red-300">{status.message}</div>
      )}
    </div>
  )
}

function Section({
  title,
  icon,
  children,
}: {
  title: string
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="card overflow-hidden">
      <header className="border-b border-ink-800 px-4 py-2.5">
        <h2 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-ink-300">
          {icon}
          {title}
        </h2>
      </header>
      <div className="divide-y divide-ink-800">{children}</div>
    </section>
  )
}

function Row({
  label,
  hint,
  vertical,
  children,
}: {
  label: string
  hint?: string
  vertical?: boolean
  children: React.ReactNode
}) {
  if (vertical) {
    return (
      <div className="px-4 py-3.5">
        <div>
          <p className="text-sm text-ink-100">{label}</p>
          {hint && <p className="mt-0.5 text-xs text-ink-400">{hint}</p>}
        </div>
        <div className="mt-3">{children}</div>
      </div>
    )
  }
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm text-ink-100">{label}</p>
        {hint && <p className="mt-0.5 text-xs text-ink-400">{hint}</p>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  )
}

function AppearanceControl() {
  const [theme, setTheme] = useState<Theme>(() => loadTheme())
  const preset = matchPreset(theme)
  const shownBg = effectiveBackground(theme)
  const adjusted = shownBg.toLowerCase() !== theme.background.toLowerCase()

  function update(next: Theme) {
    setTheme(next)
    saveTheme(next)
  }

  return (
    <>
      <Row label="Mode" hint={preset ? undefined : 'Custom colours. Pick a mode to start over from it.'}>
        <Segmented
          value={preset ?? ''}
          options={PRESETS.map((p) => ({ value: p.id, label: p.label }))}
          onChange={(id) => {
            const p = PRESETS.find((x) => x.id === id)
            if (p) update(p.theme)
          }}
        />
      </Row>
      <Row label="Accent colour" hint="Buttons, highlights, and selected items.">
        <ColorField value={theme.accent} onChange={(accent) => update({ ...theme, accent })} />
      </Row>
      <Row
        label="Background colour"
        hint={
          adjusted
            ? `Shown as ${shownBg} so text stays readable. Cards and boxes are shaded from it.`
            : 'The page colour. Cards, boxes, and borders are shaded from it.'
        }
      >
        <ColorField value={theme.background} onChange={(background) => update({ ...theme, background })} />
      </Row>
      <Row label="Text colour">
        <Segmented
          value={theme.text}
          options={[
            { value: 'light', label: 'White' },
            { value: 'dark', label: 'Black' },
          ]}
          onChange={(text) => update({ ...theme, text: text as TextTone })}
        />
      </Row>
      {!preset && (
        <Row label="Reset">
          <button onClick={() => update(NIGHT)} className="btn-secondary !py-1.5 !text-xs">
            Back to Night
          </button>
        </Row>
      )}
    </>
  )
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
}) {
  return (
    <div className="inline-flex rounded-lg border border-ink-700 bg-ink-800 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-3 py-1 text-xs font-medium transition ${
            value === o.value ? 'bg-accent-600 text-on-accent' : 'text-ink-300 hover:text-ink-100'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function ColorField({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-10 cursor-pointer rounded-md border border-ink-700 bg-ink-800 p-0.5"
        aria-label="Pick colour"
      />
      <input
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          const v = e.target.value.trim()
          const hex = v.startsWith('#') ? v : `#${v}`
          if (parseHex(hex)) onChange(hex.toLowerCase())
        }}
        onBlur={() => setDraft(value)}
        className="input-mono w-24 !py-1.5 !text-xs"
        spellCheck={false}
        maxLength={7}
      />
    </div>
  )
}
