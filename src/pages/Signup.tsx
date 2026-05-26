import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { UserPlus } from 'lucide-react'
import AuthShell from '../components/AuthShell'
import { useAuth } from '../state/AuthContext'
import { useToast } from '../state/ToastContext'

export default function Signup() {
  const { signUp } = useAuth()
  const toast = useToast()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [confirmationSent, setConfirmationSent] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const { needsConfirmation } = await signUp(email, password)
      if (needsConfirmation) {
        setConfirmationSent(true)
        toast.info('Check your email to confirm your account.')
      } else {
        toast.success('Account created')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sign-up failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (confirmationSent) {
    return (
      <AuthShell title="Check your inbox" subtitle="We sent you a confirmation link.">
        <p className="text-sm text-ink-300">
          Open the email we sent to <span className="font-mono text-ink-100">{email}</span> and click the link.
          Then come back and sign in.
        </p>
        <div className="mt-6">
          <Link to="/login" className="btn-secondary w-full">Go to sign in</Link>
        </div>
      </AuthShell>
    )
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="The sign-in password gets you to the door. A separate master password unlocks the vault."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="text-accent-400 hover:text-accent-300">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label htmlFor="email" className="label">Email</label>
          <input
            id="email"
            type="email"
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </div>
        <div>
          <label htmlFor="password" className="label">Sign-in password</label>
          <input
            id="password"
            type="password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
            minLength={8}
          />
          <p className="mt-1.5 text-xs text-ink-400">At least 8 characters.</p>
        </div>
        <button type="submit" className="btn-primary w-full" disabled={submitting}>
          <UserPlus size={16} />
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>
    </AuthShell>
  )
}
