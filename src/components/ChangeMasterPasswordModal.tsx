import { useState, type FormEvent } from 'react'
import { AlertTriangle, KeyRound, X } from 'lucide-react'
import { useVault } from '../state/VaultContext'
import { useToast } from '../state/ToastContext'

interface Props {
  onClose: () => void
}

export default function ChangeMasterPasswordModal({ onClose }: Props) {
  const { changeMasterPassword } = useVault()
  const toast = useToast()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const tooShort = next.length > 0 && next.length < 12
  const mismatch = confirm.length > 0 && next !== confirm
  const sameAsOld = current.length > 0 && next.length > 0 && current === next

  const ready =
    current.length > 0 &&
    next.length >= 12 &&
    next === confirm &&
    !sameAsOld &&
    acknowledged &&
    !submitting

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!ready) return
    setSubmitting(true)
    setError(null)
    try {
      await changeMasterPassword(current, next)
      toast.success('Master password changed')
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change master password')
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-md p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-600/10 text-accent-400">
              <KeyRound size={16} />
            </div>
            <div>
              <h2 className="font-semibold text-ink-50">Change master password</h2>
              <p className="mt-0.5 text-xs text-ink-400">
                Items stay decryptable — only the wrapping changes.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-ink-400 hover:text-ink-100"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="mb-4 flex gap-3 rounded-lg border border-amber-500/30 bg-amber-950/40 p-3 text-sm text-amber-100">
          <AlertTriangle size={16} className="mt-0.5 flex-shrink-0 text-amber-400" />
          <div>
            <p className="font-medium">If you forget the new password, your vault is unrecoverable.</p>
            <p className="mt-1 text-xs text-amber-200/80">
              Pick something you'll remember. A passphrase works well.
            </p>
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-3" noValidate>
          <div>
            <label htmlFor="cur" className="label">Current master password</label>
            <input
              id="cur"
              type="password"
              className="input"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoFocus
              required
              autoComplete="current-password"
            />
          </div>
          <div>
            <label htmlFor="new" className="label">New master password</label>
            <input
              id="new"
              type="password"
              className="input"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
              autoComplete="new-password"
            />
            <p className={`mt-1.5 text-xs ${tooShort ? 'text-amber-400' : 'text-ink-400'}`}>
              Minimum 12 characters. A 4-word passphrase is stronger than a short random string.
            </p>
            {sameAsOld && (
              <p className="mt-1 text-xs text-red-300">New password must be different.</p>
            )}
          </div>
          <div>
            <label htmlFor="conf" className="label">Confirm new master password</label>
            <input
              id="conf"
              type="password"
              className="input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              autoComplete="new-password"
            />
            {mismatch && (
              <p className="mt-1.5 text-xs text-red-300">Passwords don't match.</p>
            )}
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

          {error && (
            <p className="text-xs text-red-300">
              {error.includes('Incorrect')
                ? 'Current master password is incorrect.'
                : error}
            </p>
          )}

          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">
              Cancel
            </button>
            <button type="submit" className="btn-primary flex-1" disabled={!ready}>
              <KeyRound size={14} />
              {submitting ? 'Changing…' : 'Change password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
