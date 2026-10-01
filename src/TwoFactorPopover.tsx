/**
 * Standalone React tree rendered inside the borderless `2fa-popover` Tauri
 * window. Gets its payload from `open2faPopover` in desktop.ts: subscribes
 * to `2fa://show`, then pulls the payload parked in Rust, so a payload sent
 * before the window was listening is never lost (KEY-2FA-1). Timing lives in
 * lib/twoFactorPopoverController.ts. No vault / Supabase access.
 */

import { useEffect, useRef, useState } from 'react'
import { Check, Copy, ExternalLink, Mail, RotateCw, ShieldCheck, X } from 'lucide-react'
import {
  close2faPopover,
  openExternalUrl,
  pull2faPayload,
  type TwoFactorPayload,
} from './lib/desktop'
import { withGoogleAuthuser } from './lib/google/twoFactor'
import {
  createPopoverController,
  type PopoverController,
  type PopoverView,
} from './lib/twoFactorPopoverController'
import { ToastProvider, useToast } from './state/ToastContext'

export default function TwoFactorPopover() {
  return (
    <ToastProvider>
      <TwoFactorPopoverInner />
    </ToastProvider>
  )
}

function TwoFactorPopoverInner() {
  const [view, setView] = useState<PopoverView>({ kind: 'waiting' })
  const [justCopied, setJustCopied] = useState(false)
  const toast = useToast()
  const controllerRef = useRef<PopoverController | null>(null)
  const payload = view.kind === 'code' ? view.payload : null

  // Subscribe, then pull the parked payload; never wait forever.
  useEffect(() => {
    const controller = createPopoverController({
      listen: async (onPayload) => {
        const { listen } = await import('@tauri-apps/api/event')
        return listen<TwoFactorPayload>('2fa://show', (e) => onPayload(e.payload))
      },
      pull: pull2faPayload,
      close: () => void close2faPopover(),
      onView: (v) => {
        setView(v)
        if (v.kind === 'code') setJustCopied(false)
      },
    })
    controllerRef.current = controller
    void controller.start()
    return () => {
      controller.dispose()
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [])

  const bumpAutoClose = () => controllerRef.current?.bumpAutoClose()

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
      onMouseMove={bumpAutoClose}
    >
      <Header />
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {view.kind === 'waiting' ? (
          <p className="py-6 text-center text-xs text-ink-400">Waiting…</p>
        ) : !payload ? (
          <div className="space-y-3 py-4 text-center">
            <p className="text-sm text-ink-200">No code found yet</p>
            <p className="text-[11px] text-ink-400">
              Check the email in your Inbox. This closes on its own.
            </p>
            <button
              onClick={() => void controllerRef.current?.retry()}
              className="btn-secondary mx-auto"
            >
              <RotateCw size={13} /> Retry
            </button>
          </div>
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
