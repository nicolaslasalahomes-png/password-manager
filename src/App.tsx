import { useEffect, useState } from 'react'
import { supabase, supabaseConfigured } from './lib/supabase'
import './App.css'

type Status =
  | { kind: 'checking' }
  | { kind: 'ok'; latencyMs: number }
  | { kind: 'no-config' }
  | { kind: 'error'; message: string }

function App() {
  const [status, setStatus] = useState<Status>({ kind: 'checking' })

  useEffect(() => {
    if (!supabaseConfigured) {
      setStatus({ kind: 'no-config' })
      return
    }
    const start = performance.now()
    supabase.auth
      .getSession()
      .then(({ error }) => {
        if (error) {
          setStatus({ kind: 'error', message: error.message })
        } else {
          setStatus({ kind: 'ok', latencyMs: Math.round(performance.now() - start) })
        }
      })
      .catch((err: unknown) => {
        setStatus({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      })
  }, [])

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '3rem', maxWidth: 640, margin: '0 auto' }}>
      <h1 style={{ fontSize: '2rem', marginBottom: '0.25rem' }}>Password Manager</h1>
      <p style={{ color: '#666', marginTop: 0 }}>
        Scaffold deploy. The real app starts in the next session.
      </p>

      <section style={{ marginTop: '2rem', padding: '1rem 1.25rem', border: '1px solid #e5e5e5', borderRadius: 8 }}>
        <h2 style={{ fontSize: '1rem', margin: 0, marginBottom: '0.5rem' }}>Supabase connection</h2>
        {status.kind === 'checking' && <p style={{ margin: 0 }}>Checking…</p>}
        {status.kind === 'ok' && (
          <p style={{ margin: 0, color: '#0a7c3a' }}>
            ✓ Connected ({status.latencyMs} ms round-trip to auth endpoint)
          </p>
        )}
        {status.kind === 'no-config' && (
          <p style={{ margin: 0, color: '#a35a00' }}>
            ⚠ VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set. Add them in Vercel → Project Settings → Environment Variables.
          </p>
        )}
        {status.kind === 'error' && (
          <p style={{ margin: 0, color: '#b00020' }}>✗ {status.message}</p>
        )}
      </section>
    </main>
  )
}

export default App
