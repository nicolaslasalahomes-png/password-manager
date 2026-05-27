import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Copy, ExternalLink, Lock, LogOut, Search, ShieldCheck } from 'lucide-react'
import { supabase } from '@vault/lib/supabase'
import { decryptJson, unlockVault, zero } from '@vault/lib/encryption'
import { listItems, type VaultItemRow } from '@vault/lib/items'
import type { Session, User } from '@supabase/supabase-js'
import {
  clearSession,
  readSession,
  touchSession,
  writeSession,
} from './session'
import type { VaultMeta } from '@vault/state/VaultContext'

type Phase =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'no-vault' }
  | { kind: 'locked'; meta: VaultMeta }
  | { kind: 'unlocked'; dek: Uint8Array; meta: VaultMeta }

interface VaultUsersRow {
  encrypted_dek: string
  iv_dek: string
  kdf_salt: string
  kdf_params: VaultMeta['kdfParams']
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

export default function Popup() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })

  useEffect(() => {
    void boot()
  }, [])

  async function boot() {
    // Check session first — may already be unlocked
    const persisted = await readSession()
    const { data } = await supabase.auth.getSession()
    const session: Session | null = data.session
    if (!session) {
      setPhase({ kind: 'signed-out' })
      return
    }
    const meta = persisted?.meta ?? (await loadMeta(session.user))
    if (!meta) {
      setPhase({ kind: 'no-vault' })
      return
    }
    if (persisted) {
      await touchSession()
      setPhase({ kind: 'unlocked', dek: persisted.dek, meta: persisted.meta })
    } else {
      setPhase({ kind: 'locked', meta })
    }
  }

  function renderInner() {
    switch (phase.kind) {
      case 'loading':
        return <div className="p-6 text-center text-sm text-ink-300">Loading…</div>
      case 'signed-out':
        return <SignedOut onSignedIn={boot} />
      case 'no-vault':
        return (
          <div className="p-6 text-center text-sm text-ink-300">
            No vault yet — open Keyring in the browser to set one up.
          </div>
        )
      case 'locked':
        return (
          <Locked
            meta={phase.meta}
            onUnlocked={async (dek) => {
              await writeSession(dek, phase.meta)
              setPhase({ kind: 'unlocked', dek, meta: phase.meta })
            }}
          />
        )
      case 'unlocked':
        return (
          <Unlocked
            dek={phase.dek}
            onLock={async () => {
              zero(phase.dek)
              await clearSession()
              setPhase({ kind: 'locked', meta: phase.meta })
            }}
            onSignOut={async () => {
              zero(phase.dek)
              await clearSession()
              await supabase.auth.signOut()
              setPhase({ kind: 'signed-out' })
            }}
          />
        )
    }
  }

  return (
    <div className="bg-ink-950 text-ink-100" style={{ width: 360, minHeight: 480 }}>
      <header className="flex items-center gap-2 border-b border-ink-800 px-3 py-2.5">
        <ShieldCheck className="h-4 w-4 text-accent-400" />
        <span className="text-sm font-semibold tracking-tight">Keyring</span>
      </header>
      {renderInner()}
    </div>
  )
}

function SignedOut({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    const { error: err } = await supabase.auth.signInWithPassword({ email, password })
    setSubmitting(false)
    if (err) setError(err.message)
    else onSignedIn()
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 p-4">
      <div>
        <label className="label">Email</label>
        <input
          type="email"
          className="input"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoFocus
        />
      </div>
      <div>
        <label className="label">Password</label>
        <input
          type="password"
          className="input"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>
      {error && <p className="text-xs text-red-300">{error}</p>}
      <button type="submit" className="btn-primary w-full" disabled={submitting}>
        {submitting ? 'Signing in…' : 'Sign in'}
      </button>
      <p className="text-center text-xs text-ink-400">
        No account?{' '}
        <a
          href="https://password-manager-nicolaslasalahomes-pngs-projects.vercel.app/signup"
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-400"
        >
          Sign up in browser
        </a>
      </p>
    </form>
  )
}

function Locked({
  meta,
  onUnlocked,
}: {
  meta: VaultMeta
  onUnlocked: (dek: Uint8Array) => Promise<void>
}) {
  const [pw, setPw] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const { dek } = await unlockVault({ masterPassword: pw, ...meta })
      await onUnlocked(dek)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unlock failed')
      setPw('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 p-4">
      <div className="text-xs text-ink-400">Vault is locked. Enter your master password.</div>
      <input
        type="password"
        className="input"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        required
        autoFocus
      />
      {error && <p className="text-xs text-red-300">{error}</p>}
      <button type="submit" className="btn-primary w-full" disabled={submitting || !pw}>
        {submitting ? 'Unlocking…' : 'Unlock'}
      </button>
    </form>
  )
}

function Unlocked({
  dek,
  onLock,
  onSignOut,
}: {
  dek: Uint8Array
  onLock: () => void
  onSignOut: () => void
}) {
  const [items, setItems] = useState<VaultItemRow[] | null>(null)
  const [q, setQ] = useState('')

  useEffect(() => {
    listItems()
      .then(setItems)
      .catch(() => setItems([]))
  }, [])

  const filtered = useMemo(() => {
    if (!items) return []
    const query = q.trim().toLowerCase()
    if (!query) return items.slice(0, 20)
    return items.filter((it) => {
      return [it.title, it.folder ?? '', it.url ?? '', ...(it.tags ?? [])]
        .join(' ')
        .toLowerCase()
        .includes(query)
    })
  }, [items, q])

  async function copyPrimaryField(item: VaultItemRow) {
    try {
      const fields = await decryptJson<Record<string, string>>(
        item.encrypted_data,
        item.iv,
        dek,
      )
      // Pick the most useful field to copy: password > key > body > first
      const value =
        fields.password ?? fields.key ?? fields.body ?? Object.values(fields)[0]
      if (!value) return
      await navigator.clipboard.writeText(value)
      await touchSession()
      // Show transient confirmation via title manipulation
      const original = document.title
      document.title = '✓ Copied'
      setTimeout(() => (document.title = original), 1200)
    } catch (err) {
      console.error('[popup] copy failed', err)
    }
  }

  return (
    <>
      <div className="border-b border-ink-800 p-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
            autoFocus
            className="input pl-8 text-xs"
          />
        </div>
      </div>

      <div className="max-h-[360px] overflow-y-auto">
        {items === null ? (
          <div className="p-4 text-center text-xs text-ink-400">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-4 text-center text-xs text-ink-400">No matches.</div>
        ) : (
          <ul>
            {filtered.map((it) => (
              <li key={it.id}>
                <button
                  type="button"
                  onClick={() => copyPrimaryField(it)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-ink-800/60"
                >
                  <Copy size={12} className="text-ink-400" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-ink-100">{it.title}</div>
                    <div className="truncate text-[10px] text-ink-500">
                      {it.folder ? `${it.folder} · ` : ''}
                      {it.type}
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="flex items-center justify-between gap-1 border-t border-ink-800 p-2 text-xs">
        <a
          href="https://password-manager-nicolaslasalahomes-pngs-projects.vercel.app/vault"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-ink-300 hover:bg-ink-800 hover:text-ink-100"
        >
          Open full vault <ExternalLink size={10} />
        </a>
        <div className="flex gap-1">
          <button
            onClick={onLock}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-ink-300 hover:bg-ink-800 hover:text-ink-100"
          >
            <Lock size={11} /> Lock
          </button>
          <button
            onClick={onSignOut}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-ink-300 hover:bg-ink-800 hover:text-ink-100"
          >
            <LogOut size={11} /> Sign out
          </button>
        </div>
      </footer>
    </>
  )
}
