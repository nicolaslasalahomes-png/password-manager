import { useState, type FormEvent } from 'react'
import { KeyRound, X } from 'lucide-react'
import { useVault } from '../state/VaultContext'

interface Props {
  title?: string
  message?: string
  onVerified: () => void
  onCancel: () => void
}

export default function MasterPasswordPrompt({ title, message, onVerified, onCancel }: Props) {
  const { verifyMasterPassword } = useVault()
  const [pw, setPw] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const ok = await verifyMasterPassword(pw)
      if (ok) {
        onVerified()
      } else {
        setError('Incorrect master password')
        setPw('')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="card w-full max-w-sm p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold text-ink-50">{title ?? 'Confirm master password'}</h2>
            {message && <p className="mt-1 text-sm text-ink-300">{message}</p>}
          </div>
          <button onClick={onCancel} className="text-ink-400 hover:text-ink-200" aria-label="Cancel">
            <X size={16} />
          </button>
        </div>
        <form onSubmit={onSubmit} className="space-y-3">
          <input
            type="password"
            className="input"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder="Master password"
            autoFocus
            required
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button type="button" className="btn-secondary flex-1" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="btn-primary flex-1" disabled={submitting || !pw}>
              <KeyRound size={14} />
              {submitting ? 'Checking…' : 'Confirm'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
