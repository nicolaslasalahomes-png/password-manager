import { useState, type FormEvent } from 'react'
import { AlertTriangle, KeyRound, LogOut } from 'lucide-react'
import AuthShell from '../components/AuthShell'
import { useVault } from '../state/VaultContext'
import { useAuth } from '../state/AuthContext'
import { useToast } from '../state/ToastContext'

export default function VaultSetup() {
  const { setupVault } = useVault()
  const { signOut } = useAuth()
  const toast = useToast()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const tooShort = password.length > 0 && password.length < 12
  const mismatch = confirm.length > 0 && password !== confirm
  const ready =
    password.length >= 12 && password === confirm && acknowledged && !submitting

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!ready) return
    setSubmitting(true)
    try {
      await setupVault(password)
      toast.success('Vault created and unlocked')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Setup failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthShell
      title="Set your master password"
      subtitle="This unlocks your vault. It is never sent to the server."
      footer={
        <button onClick={signOut} className="inline-flex items-center gap-1.5 text-ink-400 hover:text-ink-200">
          <LogOut size={14} /> Sign out
        </button>
      }
    >
      <div className="mb-5 flex gap-3 rounded-lg border border-amber-500/30 bg-amber-950/40 p-3 text-sm text-amber-100">
        <AlertTriangle size={18} className="mt-0.5 flex-shrink-0 text-amber-400" />
        <div>
          <p className="font-medium">If you forget this password, your vault is unrecoverable.</p>
          <p className="mt-1 text-amber-200/80">
            That's the point — even we can't read it. Pick something you'll remember (a passphrase works well).
          </p>
        </div>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label htmlFor="mp" className="label">Master password</label>
          <input
            id="mp"
            type="password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
            minLength={12}
          />
          <p className={`mt-1.5 text-xs ${tooShort ? 'text-amber-400' : 'text-ink-400'}`}>
            Minimum 12 characters. A 4-word passphrase is better than a short random string.
          </p>
        </div>
        <div>
          <label htmlFor="confirm" className="label">Confirm master password</label>
          <input
            id="confirm"
            type="password"
            className="input"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
          {mismatch && <p className="mt-1.5 text-xs text-red-400">Passwords do not match.</p>}
        </div>

        <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-ink-700 bg-ink-800/60 p-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span className="text-ink-200">
            I understand my vault cannot be recovered if I forget this password.
          </span>
        </label>

        <button type="submit" className="btn-primary w-full" disabled={!ready}>
          <KeyRound size={16} />
          {submitting ? 'Creating vault…' : 'Create vault'}
        </button>
      </form>
    </AuthShell>
  )
}
