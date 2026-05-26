import { useState, type FormEvent } from 'react'
import { KeyRound, LogOut } from 'lucide-react'
import AuthShell from '../components/AuthShell'
import { useVault } from '../state/VaultContext'
import { useAuth } from '../state/AuthContext'
import { useToast } from '../state/ToastContext'

export default function VaultUnlock() {
  const { unlockVault } = useVault()
  const { user, signOut } = useAuth()
  const toast = useToast()
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      await unlockVault(password)
      toast.success('Unlocked')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Unlock failed')
      setPassword('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthShell
      title="Unlock your vault"
      subtitle={user?.email ? `Signed in as ${user.email}` : undefined}
      footer={
        <button onClick={signOut} className="inline-flex items-center gap-1.5 text-ink-400 hover:text-ink-200">
          <LogOut size={14} /> Sign out
        </button>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label htmlFor="mp" className="label">Master password</label>
          <input
            id="mp"
            type="password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            autoFocus
            required
          />
        </div>
        <button type="submit" className="btn-primary w-full" disabled={submitting || password.length === 0}>
          <KeyRound size={16} />
          {submitting ? 'Unlocking…' : 'Unlock'}
        </button>
      </form>
    </AuthShell>
  )
}
