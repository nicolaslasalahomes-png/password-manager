import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

// Module-level flag tracking which user has already cleared MFA *this app run*.
//
// Why a plain module variable instead of sessionStorage/localStorage:
//   - It persists for the entire JS process lifetime → survives vault
//     lock/unlock cycles AND window hide/show (the webview stays alive), so
//     2FA never re-prompts just because the vault re-locked.
//   - It resets only when the app is FULLY quit and reopened (fresh webview =
//     fresh module scope) → 2FA is required exactly once per full app launch.
//   - localStorage would persist across full quits (2FA would never re-prompt);
//     sessionStorage behaves right but is ambiguous in a webview. A module var
//     is the unambiguous "per process run" scope we want.
let mfaVerifiedForUserId: string | null = null

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string

interface AuthApi {
  user: User | null
  session: Session | null
  loading: boolean
  /** True when the user has signed in with password but still owes an email-OTP. */
  mfaPending: boolean
  signUp: (email: string, password: string) => Promise<{ needsConfirmation: boolean }>
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  /** Trigger a fresh 6-digit code to be emailed to the signed-in user. */
  sendMfaCode: () => Promise<void>
  /** Verify a code; clears mfaPending on success. Throws on wrong/expired/locked. */
  verifyMfaCode: (code: string) => Promise<void>
  /** Persist email_2fa_enabled in the user's Supabase metadata. */
  setEmailMfaEnabled: (enabled: boolean) => Promise<void>
  /** Convenience accessor; reads from session.user.user_metadata. */
  emailMfaEnabled: boolean
}

const AuthContext = createContext<AuthApi | null>(null)

async function sendMfaCodeWithToken(accessToken: string): Promise<void> {
  // One retry with a short delay — the edge function cold-starts when idle and
  // the first call after a while can fail/time out before the runtime is warm.
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500))
    try {
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/send-2fa-code`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        throw new Error(`(${resp.status}) ${text.slice(0, 200)}`)
      }
      return
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(
    `Could not send code: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  )
}

async function verifyMfaCodeWithToken(accessToken: string, code: string): Promise<void> {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/verify-2fa-code`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ code }),
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) {
    throw new Error(data.error || `Verify failed (${resp.status})`)
  }
  if (!data.ok) {
    throw new Error(data.error || 'Wrong code')
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [mfaPending, setMfaPending] = useState(false)

  useEffect(() => {
    let mounted = true
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s)
    })
    return () => {
      mounted = false
      sub.subscription.unsubscribe()
    }
  }, [])

  // Whenever session changes, recompute whether MFA is owed for this session.
  // Skip recompute if we already-just-verified (signIn handler set the flag).
  useEffect(() => {
    if (loading) return
    if (!session?.user) {
      setMfaPending(false)
      return
    }
    const mfaEnabled = (session.user.user_metadata as { email_2fa_enabled?: boolean })?.email_2fa_enabled === true
    setMfaPending(mfaEnabled && mfaVerifiedForUserId !== session.user.id)
  }, [session, loading])

  const signUp = useCallback(async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signUp({ email, password })
    if (error) throw error
    return { needsConfirmation: !data.session }
  }, [])

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    // Fresh sign-in invalidates any prior "verified" flag — a new factor is owed.
    mfaVerifiedForUserId = null
    // NOTE: we deliberately do NOT send the OTP here. Sending from this exact
    // moment (fresh JWT, Login screen unmounting, possibly-cold edge function)
    // proved unreliable — the first email never arrived. The MfaChallenge
    // screen sends it on mount instead, using the fully-established session,
    // which is the same path the working "Resend" button uses.
  }, [])

  const signOut = useCallback(async () => {
    mfaVerifiedForUserId = null
    await supabase.auth.signOut()
  }, [])

  const sendMfaCode = useCallback(async () => {
    if (!session) throw new Error('Not signed in')
    await sendMfaCodeWithToken(session.access_token)
  }, [session])

  const verifyMfaCode = useCallback(
    async (code: string) => {
      if (!session) throw new Error('Not signed in')
      await verifyMfaCodeWithToken(session.access_token, code)
      mfaVerifiedForUserId = session.user.id
      setMfaPending(false)
    },
    [session],
  )

  const setEmailMfaEnabled = useCallback(async (enabled: boolean) => {
    const { error } = await supabase.auth.updateUser({
      data: { email_2fa_enabled: enabled },
    })
    if (error) throw error
  }, [])

  const emailMfaEnabled = useMemo(() => {
    const meta = session?.user?.user_metadata as { email_2fa_enabled?: boolean } | undefined
    return meta?.email_2fa_enabled === true
  }, [session])

  const api = useMemo<AuthApi>(
    () => ({
      user: session?.user ?? null,
      session,
      loading,
      mfaPending,
      signUp,
      signIn,
      signOut,
      sendMfaCode,
      verifyMfaCode,
      setEmailMfaEnabled,
      emailMfaEnabled,
    }),
    [session, loading, mfaPending, signUp, signIn, signOut, sendMfaCode, verifyMfaCode, setEmailMfaEnabled, emailMfaEnabled],
  )

  return <AuthContext.Provider value={api}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
