import { useEffect, useRef, useState, type FormEvent } from 'react'
import { LogOut, Mail, RotateCcw, ShieldCheck } from 'lucide-react'
import AuthShell from '../components/AuthShell'
import { useAuth } from '../state/AuthContext'
import { useToast } from '../state/ToastContext'

export default function MfaChallenge() {
  const { user, signOut, sendMfaCode, verifyMfaCode } = useAuth()
  const toast = useToast()
  const [code, setCode] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [resending, setResending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cooldownUntil, setCooldownUntil] = useState<number>(0)

  // Tick once a second to update the cooldown countdown label.
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 1000)
    return () => window.clearInterval(id)
  }, [])

  // Send the code when this screen mounts — using the fully-established session
  // (same path as the Resend button, which always works). The signIn step no
  // longer sends, so this is the single reliable trigger. Guarded against
  // double-fire (StrictMode / re-renders).
  const sentRef = useRef(false)
  useEffect(() => {
    if (sentRef.current) return
    sentRef.current = true
    setResending(true)
    sendMfaCode()
      .then(() => setCooldownUntil(Date.now() + 30_000))
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not send code'))
      .finally(() => setResending(false))
  }, [sendMfaCode])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!/^\d{6}$/.test(code)) {
      setError('Code must be 6 digits')
      return
    }
    setVerifying(true)
    setError(null)
    try {
      await verifyMfaCode(code)
      toast.success('Verified')
      // AuthContext flips mfaPending=false; App.tsx routes to vault unlock.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed')
      setCode('')
    } finally {
      setVerifying(false)
    }
  }

  async function onResend() {
    if (Date.now() < cooldownUntil) return
    setResending(true)
    setError(null)
    try {
      await sendMfaCode()
      toast.success('New code sent')
      setCooldownUntil(Date.now() + 30_000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resend')
    } finally {
      setResending(false)
    }
  }

  const cooldownLeft = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000))

  return (
    <AuthShell
      title="Enter your sign-in code"
      subtitle={user?.email ? `Sent to ${user.email}` : 'Check your email'}
      footer={
        <button
          onClick={() => void signOut()}
          className="inline-flex items-center gap-1.5 text-ink-400 hover:text-ink-200"
        >
          <LogOut size={14} /> Cancel + sign out
        </button>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-accent-500/30 bg-accent-950/30 p-3 text-xs text-accent-100">
          <Mail size={14} className="mt-0.5 flex-shrink-0" />
          <p>
            We sent a 6-digit code to your email. It expires in 10 minutes. After
            5 wrong tries the code locks and you'll need a new one.
          </p>
        </div>

        <div>
          <label htmlFor="mfa" className="label">
            6-digit code
          </label>
          <input
            id="mfa"
            type="text"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            className="input-mono text-center text-2xl tracking-[10px]"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            autoFocus
            autoComplete="one-time-code"
            required
          />
          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        </div>

        <button
          type="submit"
          className="btn-primary w-full"
          disabled={verifying || code.length !== 6}
        >
          <ShieldCheck size={16} />
          {verifying ? 'Verifying…' : 'Verify'}
        </button>

        <div className="flex items-center justify-between text-xs text-ink-400">
          <span>Didn't get it? Check spam.</span>
          <button
            type="button"
            onClick={onResend}
            disabled={resending || cooldownLeft > 0}
            className="inline-flex items-center gap-1 text-accent-400 hover:text-accent-300 disabled:text-ink-500"
          >
            <RotateCcw size={12} />
            {resending
              ? 'Sending…'
              : cooldownLeft > 0
              ? `Resend in ${cooldownLeft}s`
              : 'Resend code'}
          </button>
        </div>
      </form>
    </AuthShell>
  )
}
