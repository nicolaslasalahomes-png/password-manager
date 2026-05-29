/**
 * Entry point for the dedicated quick-add Tauri window.
 *
 * Renders a stripped-down UI: just the quick-add form, using the unlocked
 * DEK fetched from Rust process state (set by the main window on unlock).
 *
 * If the user isn't signed in or the vault is locked, we show a small
 * message pointing them at the main window — we don't try to handle full
 * auth/unlock flows here.
 */

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { User } from '@supabase/supabase-js'
import {
  AlertTriangle,
  Eye,
  EyeOff,
  KeyRound,
  RefreshCw,
  Save,
  ShieldCheck,
  X,
} from 'lucide-react'
import { supabase } from './lib/supabase'
import { createItem, listFolders, type ItemType, type VisibilityTier } from './lib/items'
import { generatePassword } from './lib/generate'
import { unlockVault as cryptoUnlockVault, type KdfParams } from './lib/encryption'
import { closeQuickAddWindow, getSessionDek, setSessionDek } from './lib/desktop'
import { ToastProvider, useToast } from './state/ToastContext'
import type { VaultMeta } from './state/VaultContext'

const VALUE_FIELD_BY_TYPE: Record<ItemType | string, string> = {
  login: 'password',
  api_key: 'key',
  note: 'body',
  other: 'value',
}

const VALUE_LABEL_BY_TYPE: Record<ItemType | string, string> = {
  login: 'Password',
  api_key: 'API key',
  note: 'Note',
  other: 'Value',
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'locked'; user: User; meta: VaultMeta }
  | { kind: 'ready'; user: User; dek: Uint8Array }

interface VaultUsersRow {
  encrypted_dek: string
  iv_dek: string
  kdf_salt: string
  kdf_params: KdfParams
  verifier_ciphertext: string
  verifier_iv: string
}

function rowToMeta(row: VaultUsersRow): VaultMeta {
  return {
    encryptedDek: row.encrypted_dek,
    ivDek: row.iv_dek,
    kdfSalt: row.kdf_salt,
    kdfParams: row.kdf_params,
    verifierCiphertext: row.verifier_ciphertext,
    verifierIv: row.verifier_iv,
  }
}

async function loadMeta(user: User): Promise<VaultMeta | null> {
  const { data, error } = await supabase
    .from('vault_users')
    .select('encrypted_dek, iv_dek, kdf_salt, kdf_params, verifier_ciphertext, verifier_iv')
    .eq('user_id', user.id)
    .maybeSingle()
  if (error || !data) return null
  return rowToMeta(data as VaultUsersRow)
}

export default function QuickAddWindow() {
  return (
    <ToastProvider>
      <QuickAddWindowInner />
    </ToastProvider>
  )
}

function QuickAddWindowInner() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })

  useEffect(() => {
    void boot()
    // Esc anywhere → close
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void closeQuickAddWindow()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  async function boot() {
    const { data } = await supabase.auth.getSession()
    if (!data.session) {
      setPhase({ kind: 'signed-out' })
      return
    }
    const user = data.session.user
    const dek = await getSessionDek()
    if (dek) {
      setPhase({ kind: 'ready', user, dek })
      return
    }
    // Locked — load vault meta so we can offer an in-popover unlock form.
    const meta = await loadMeta(user)
    if (!meta) {
      setPhase({ kind: 'signed-out' })
      return
    }
    setPhase({ kind: 'locked', user, meta })
  }

  return (
    // The outer container is a drag region so the user can grab anywhere in
    // the dark space (header, padding around form, etc). Inputs and buttons
    // stop being drag regions because they're interactive.
    <div
      data-tauri-drag-region
      className="flex h-screen flex-col bg-ink-950 text-ink-100"
    >
      <Header />
      <div data-tauri-drag-region className="flex-1 overflow-y-auto p-4">
        {phase.kind === 'loading' && (
          <p className="text-center text-sm text-ink-300 py-8">Loading…</p>
        )}
        {phase.kind === 'signed-out' && (
          <Message
            tone="warn"
            title="Sign in first"
            body="Open the main Keyring window to sign in, then try the hotkey again."
          />
        )}
        {phase.kind === 'locked' && (
          <UnlockForm
            meta={phase.meta}
            onUnlocked={(dek) => setPhase({ kind: 'ready', user: phase.user, dek })}
          />
        )}
        {phase.kind === 'ready' && <QuickAddForm user={phase.user} dek={phase.dek} />}
      </div>
    </div>
  )
}

function Header() {
  return (
    <header
      data-tauri-drag-region
      className="flex select-none items-center gap-2 border-b border-ink-800 px-4 py-2.5"
    >
      <div
        data-tauri-drag-region
        className="pointer-events-none flex h-7 w-7 items-center justify-center rounded-md bg-accent-600/15 text-accent-300"
      >
        <ShieldCheck size={14} />
      </div>
      <div data-tauri-drag-region className="pointer-events-none min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink-50 leading-tight">Quick add</p>
        <p className="text-[10px] text-ink-400 leading-tight">⌘↵ save · Esc close · drag here to move</p>
      </div>
      <button
        onClick={() => void closeQuickAddWindow()}
        className="text-ink-400 hover:text-ink-100"
        aria-label="Close"
      >
        <X size={14} />
      </button>
    </header>
  )
}

function Message({
  tone,
  title,
  body,
  icon,
}: {
  tone: 'warn' | 'info'
  title: string
  body: string
  icon?: React.ReactNode
}) {
  const cls =
    tone === 'warn'
      ? 'border-amber-500/40 bg-amber-950/30 text-amber-100'
      : 'border-ink-700 bg-ink-800 text-ink-100'
  return (
    <div className={`flex items-start gap-3 rounded-lg border p-3 text-sm ${cls}`}>
      <div className="mt-0.5 flex-shrink-0">
        {icon ?? <AlertTriangle size={16} className="text-amber-400" />}
      </div>
      <div>
        <p className="font-medium">{title}</p>
        <p className="mt-1 text-xs opacity-80">{body}</p>
      </div>
    </div>
  )
}

function UnlockForm({
  meta,
  onUnlocked,
}: {
  meta: VaultMeta
  onUnlocked: (dek: Uint8Array) => void
}) {
  const [pw, setPw] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const { dek } = await cryptoUnlockVault({ masterPassword: pw, ...meta })
      // Push to Rust session state so future popovers + the main window pick it up.
      await setSessionDek(dek)
      // Tell the main window's VaultContext to sync its state.
      try {
        const { emit } = await import('@tauri-apps/api/event')
        await emit('vault://unlocked-from-popover')
      } catch {
        /* ignore — non-fatal */
      }
      onUnlocked(dek)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unlock failed')
      setPw('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="flex items-center gap-2 rounded-lg border border-accent-500/30 bg-accent-950/30 p-3 text-xs text-accent-100">
        <KeyRound size={14} className="flex-shrink-0" />
        <span>Vault is locked. Enter your master password to unlock.</span>
      </div>
      <input
        type="password"
        className="input"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        placeholder="Master password"
        autoFocus
        required
      />
      {error && <p className="text-xs text-red-300">{error}</p>}
      <button type="submit" className="btn-primary w-full !py-1.5" disabled={submitting || !pw}>
        <KeyRound size={14} />
        {submitting ? 'Unlocking…' : 'Unlock'}
      </button>
    </form>
  )
}

function QuickAddForm({ user, dek }: { user: User; dek: Uint8Array }) {
  const toast = useToast()
  const [type, setType] = useState<ItemType | string>('login')
  const [title, setTitle] = useState('')
  const [username, setUsername] = useState('')
  const [value, setValue] = useState('')
  const [folder, setFolder] = useState('')
  const [tier, setTier] = useState<VisibilityTier>('medium')
  const [revealed, setRevealed] = useState(false)
  const [folderOptions, setFolderOptions] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    listFolders().then(setFolderOptions).catch(() => {})
  }, [])

  const valueFieldKey = useMemo(() => VALUE_FIELD_BY_TYPE[type] ?? 'value', [type])
  const valueLabel = useMemo(() => VALUE_LABEL_BY_TYPE[type] ?? 'Value', [type])
  const showUsername = type === 'login'

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!title.trim() || !value) {
      toast.error('Title and value are required')
      return
    }
    setSubmitting(true)
    try {
      const fields: Record<string, string> = { [valueFieldKey]: value }
      if (showUsername && username) fields.username = username

      await createItem(
        user.id,
        {
          type,
          title: title.trim(),
          folder: folder.trim() || null,
          visibility_tier: tier,
          fields,
        },
        dek,
      )
      toast.success('Saved')
      setTitle('')
      setUsername('')
      setValue('')
      // small delay so toast renders before window hides
      window.setTimeout(() => void closeQuickAddWindow(), 250)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          void onSubmit(e as unknown as FormEvent)
        }
      }}
      className="space-y-3"
    >
      <div className="grid grid-cols-4 gap-1.5">
        {(['login', 'api_key', 'note', 'other'] as const).map((t) => (
          <button
            type="button"
            key={t}
            onClick={() => setType(t)}
            className={`rounded-md px-2 py-1.5 text-[11px] font-medium transition ${
              type === t
                ? 'bg-accent-600/15 text-accent-200 ring-1 ring-accent-600/40'
                : 'bg-ink-800 text-ink-300 hover:text-ink-100'
            }`}
          >
            {t === 'login'
              ? 'Password'
              : t === 'api_key'
              ? 'API key'
              : t === 'note'
              ? 'Note'
              : 'Other'}
          </button>
        ))}
      </div>

      <input
        autoFocus
        className="input"
        placeholder="Title (e.g. GitHub work account)"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        required
      />

      {showUsername && (
        <input
          className="input"
          placeholder="Username / email (optional)"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="off"
        />
      )}

      <div className="relative">
        {type === 'note' ? (
          <textarea
            className="input-mono min-h-[88px]"
            placeholder={valueLabel}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            required
          />
        ) : (
          <input
            type={revealed ? 'text' : 'password'}
            className="input-mono pr-20"
            placeholder={valueLabel}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            required
          />
        )}
        {type !== 'note' && (
          <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
            <button
              type="button"
              onClick={() => setRevealed((r) => !r)}
              className="rounded p-1 text-ink-400 hover:text-ink-100"
              title={revealed ? 'Hide' : 'Reveal'}
            >
              {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
            {type === 'login' && (
              <button
                type="button"
                onClick={() => {
                  setValue(generatePassword(24))
                  setRevealed(true)
                }}
                className="rounded p-1 text-accent-300 hover:bg-ink-800"
                title="Generate"
              >
                <RefreshCw size={13} />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <input
          className="input"
          list="folder-options"
          placeholder="Folder"
          value={folder}
          onChange={(e) => setFolder(e.target.value)}
        />
        <datalist id="folder-options">
          {folderOptions.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
        <select
          value={tier}
          onChange={(e) => setTier(e.target.value as VisibilityTier)}
          className="input"
        >
          <option value="low">Low visibility</option>
          <option value="medium">Medium visibility</option>
          <option value="high">High visibility</option>
        </select>
      </div>

      <button type="submit" className="btn-primary w-full !py-1.5" disabled={submitting}>
        <Save size={14} />
        {submitting ? 'Saving…' : 'Save'}
      </button>
    </form>
  )
}
