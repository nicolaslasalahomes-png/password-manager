import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  Cpu,
  Eye,
  Fingerprint,
  Keyboard as KeyboardIcon,
  LogOut,
  ShieldCheck,
} from 'lucide-react'
import Layout from '../components/Layout'
import HotkeyRecorder, { comboToGlyph } from '../components/HotkeyRecorder'
import { useAuth } from '../state/AuthContext'
import { useVault } from '../state/VaultContext'
import { useToast } from '../state/ToastContext'
import {
  getStoreValue,
  registerHotkey,
  setStoreValue,
  unregisterAllHotkeys,
  unregisterHotkey,
  useIsDesktop,
  showWindow,
} from '../lib/desktop'
import { useNavigate } from 'react-router-dom'

const HOTKEY_STORE_KEY = 'quickAddHotkey'

export default function Settings() {
  const { user, signOut } = useAuth()
  const { lockVault } = useVault()
  const toast = useToast()
  const navigate = useNavigate()
  const isDesktop = useIsDesktop()

  const [hotkey, setHotkey] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!isDesktop) {
      setLoaded(true)
      return
    }
    getStoreValue<string>(HOTKEY_STORE_KEY).then((v) => {
      setHotkey(v)
      setLoaded(true)
    })
  }, [isDesktop])

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
        <Section title="Account" icon={<ShieldCheck size={14} />}>
          <Row label="Signed in as">
            <span className="font-mono text-sm text-ink-100">{user?.email}</span>
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
          <Row label="Change master password" hint="Re-wraps the data key with the new password.">
            <button disabled className="btn-secondary !py-1.5 !text-xs opacity-50">
              Coming soon
            </button>
          </Row>
        </Section>

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
            <Row
              label="Touch ID unlock"
              hint="Unlock vault with fingerprint instead of master password."
            >
              <button disabled className="btn-secondary !py-1.5 !text-xs opacity-50">
                <Fingerprint size={12} /> Coming soon
              </button>
            </Row>
            <Row label="Launch on login" hint="Start Keyring automatically when you sign in.">
              <button disabled className="btn-secondary !py-1.5 !text-xs opacity-50">
                Coming soon
              </button>
            </Row>
          </Section>
        )}

        {!isDesktop && (
          <Section title="Desktop app" icon={<KeyboardIcon size={14} />}>
            <div className="flex items-start gap-3 rounded-lg border border-accent-500/30 bg-accent-950/30 p-3 text-sm text-accent-100">
              <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-medium">Get the desktop app for hotkey + Touch ID</p>
                <p className="mt-1 text-xs text-accent-200/80">
                  Install Keyring as a Mac app to get a global hotkey for instant access and
                  fingerprint unlock. Download coming soon.
                </p>
              </div>
            </div>
          </Section>
        )}
      </div>
    </Layout>
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
