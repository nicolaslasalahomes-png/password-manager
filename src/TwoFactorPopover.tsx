/**
 * Standalone React tree rendered inside the borderless `2fa-popover` Tauri
 * window. Listens for `2fa://show` events (sent by `open2faPopover` in
 * desktop.ts). No vault / Supabase access — everything it needs is in the
 * event payload.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, ExternalLink, Mail, ShieldCheck, X } from 'lucide-react'
import { close2faPopover, openExternalUrl, type TwoFactorPayload } from './lib/desktop'
import { withGoogleAuthuser } from './lib/google/twoFactor'
import { ToastProvider, useToast } from './state/ToastContext'

const AUTO_CLOSE_MS = 30_000

export default function TwoFactorPopover() {
  return (
    <ToastProvider>
      <TwoFactorPopoverInner />
    </ToastProvider>
  )
}

function TwoFactorPopoverInner() {
  const [payload, setPayload] = useState<TwoFactorPayload | null>(null)
  const [justCopied, setJustCopied] = useState(false)
  const toast = useToast()
  const autoCloseRef = useRef<number | null>(null)

  const scheduleAutoClose = useCallback(() => {
    if (autoCloseRef.current !== null) window.clearTimeout(autoCloseRef.current)
    autoCloseRef.current = window.setTimeout(() => {
      void close2faPopover()
    }, AUTO_CLOSE_MS)
  }, [])

  // Subscribe to fresh 2fa://show payloads. Replaces the current view if a
  // newer email comes in while the popover is still showing the previous one.
  useEffect(() => {
    let unlisten: (() => void) | null = null
    ;(async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        unlisten = await listen<TwoFactorPayload>('2fa://show', (e) => {
          setPayload(e.payload)
          setJustCopied(false)
          scheduleAutoClose()
        })
      } catch (err) {
        console.warn('[2fa-popover] failed to subscribe', err)
      }
    })()
    return () => {
      unlisten?.()
      if (autoCloseRef.current !== null) window.clearTimeout(autoCloseRef.current)
    }
  }, [scheduleAutoClose])

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        void close2faPopover()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  async function onCopy() {
    if (!payload?.code) return
    try {
      await navigator.clipboard.writeText(payload.code)
      setJustCopied(true)
      toast.success('Copied')
      // Quick auto-close after copy — typical flow is paste-into-other-app.
      window.setTimeout(() => void close2faPopover(), 1200)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Copy failed')
    }
  }

  async function onOpenLink() {
    if (!payload?.magicLink) return
    const url = withGoogleAuthuser(payload.magicLink, payload.accountEmail)
    try {
      await openExternalUrl(url)
      window.setTimeout(() => void close2faPopover(), 400)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open link')
    }
  }

  return (
    <div
      data-tauri-drag-region
      className="flex h-screen flex-col bg-ink-950 text-ink-100"
      onMouseMove={scheduleAutoClose}
    >
      <Header />
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {!payload ? (
          <p className="py-6 text-center text-xs text-ink-400">Waiting…</p>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-md bg-ink-900/60 px-2.5 py-1.5 text-[11px] text-ink-300">
              <Mail size={12} className="flex-shrink-0 text-accent-300" />
              <span className="truncate font-medium text-ink-100">{payload.fromName}</span>
              <span className="flex-shrink-0 text-ink-500">→ {payload.accountEmail}</span>
            </div>

            <p className="line-clamp-2 text-sm font-medium text-ink-100">{payload.subject}</p>

            {payload.code && (
              <div className="rounded-lg border border-accent-600/30 bg-accent-950/30 p-3">
                <p className="text-[10px] uppercase tracking-wider text-accent-300/70">Verification code</p>
                <div className="mt-1 flex items-center gap-3">
                  <span className="flex-1 font-mono text-2xl font-semibold tracking-[0.35em] text-accent-100">
                    {payload.code}
                  </span>
                  <button
                    onClick={onCopy}
                    className="btn-primary !px-3 !py-2"
                    title="Copy to clipboard"
                  >
                    {justCopied ? <Check size={14} /> : <Copy size={14} />}
                    {justCopied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            )}

            {payload.magicLink && (
              <button onClick={onOpenLink} className="btn-secondary w-full">
                <ExternalLink size={13} /> Open verification link
              </button>
            )}
          </div>
        )}
      </div>
      <footer className="border-t border-ink-800 px-3 py-2">
        <button
          onClick={() => void close2faPopover()}
          className="text-[11px] text-ink-400 hover:text-ink-100"
        >
          Dismiss · Esc
        </button>
      </footer>
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
        <p className="text-sm font-semibold text-ink-50 leading-tight">2FA code</p>
        <p className="text-[10px] text-ink-400 leading-tight">drag here · Esc closes · auto-closes in 30s</p>
      </div>
      <button
        onClick={() => void close2faPopover()}
        className="text-ink-400 hover:text-ink-100"
        aria-label="Close"
      >
        <X size={14} />
      </button>
    </header>
  )
}
