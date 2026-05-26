import { useEffect, useRef, useState } from 'react'
import { Copy, Eye, EyeOff, KeyRound, Check } from 'lucide-react'
import type { VisibilityTier } from '../lib/items'
import { useToast } from '../state/ToastContext'
import MasterPasswordPrompt from './MasterPasswordPrompt'

interface Props {
  label: string
  value: string
  tier: VisibilityTier
  multiline?: boolean
}

const MASK = '••••••••••••'
const REVEAL_TIMEOUT_MS = 60_000
const CLIPBOARD_CLEAR_MS = 30_000

export default function SecretField({ label, value, tier, multiline }: Props) {
  const [revealed, setRevealed] = useState(tier === 'low')
  const [copied, setCopied] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  const revealTimer = useRef<number | null>(null)
  const copyTimer = useRef<number | null>(null)
  const toast = useToast()

  // Auto-hide reveal after timeout (medium tier)
  useEffect(() => {
    if (tier === 'low') return
    if (!revealed) return
    if (revealTimer.current) window.clearTimeout(revealTimer.current)
    revealTimer.current = window.setTimeout(() => {
      setRevealed(false)
    }, REVEAL_TIMEOUT_MS)
    return () => {
      if (revealTimer.current) window.clearTimeout(revealTimer.current)
    }
  }, [revealed, tier])

  useEffect(() => () => {
    if (copyTimer.current) window.clearTimeout(copyTimer.current)
  }, [])

  function requestReveal() {
    if (tier === 'low') return
    if (tier === 'high') return // never reveal high-tier
    setPromptOpen(true)
  }

  async function doCopy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      if (copyTimer.current) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => {
        setCopied(false)
        // Best-effort clipboard clear (works only if tab is focused)
        navigator.clipboard.writeText('').catch(() => {
          /* ignore — browser may block when not focused */
        })
      }, CLIPBOARD_CLEAR_MS)
      toast.success(`${label} copied — clears in ${CLIPBOARD_CLEAR_MS / 1000}s`)
    } catch {
      toast.error('Could not write to clipboard')
    }
  }

  const displayValue = revealed ? value : MASK
  const showRevealButton = tier === 'medium'
  const showReHideButton = tier === 'medium' && revealed

  return (
    <>
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="label !mb-0">{label}</span>
          <div className="flex items-center gap-1">
            {showRevealButton && !revealed && (
              <button
                type="button"
                onClick={requestReveal}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-ink-300 hover:bg-ink-800 hover:text-ink-100"
                title="Reveal — requires master password"
              >
                <KeyRound size={12} /> Reveal
              </button>
            )}
            {showReHideButton && (
              <button
                type="button"
                onClick={() => setRevealed(false)}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-ink-300 hover:bg-ink-800 hover:text-ink-100"
              >
                <EyeOff size={12} /> Hide
              </button>
            )}
            <button
              type="button"
              onClick={doCopy}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-ink-300 hover:bg-ink-800 hover:text-ink-100"
            >
              {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
        {multiline && revealed ? (
          <pre className="input-mono max-h-72 overflow-auto whitespace-pre-wrap break-words py-2.5">
            {displayValue}
          </pre>
        ) : (
          <div className="input-mono select-all break-all py-2.5">
            {revealed ? (
              displayValue
            ) : (
              <span className="text-ink-400">
                {tier === 'high' ? '••••• hidden — copy only' : MASK}
              </span>
            )}
          </div>
        )}
        {tier === 'high' && (
          <p className="mt-1 text-[11px] text-red-300/80 flex items-center gap-1">
            <EyeOff size={11} /> This value is never shown on screen. Copy only.
          </p>
        )}
      </div>

      {promptOpen && (
        <MasterPasswordPrompt
          title={`Reveal "${label}"`}
          message="Confirm your master password to reveal this value."
          onVerified={() => {
            setPromptOpen(false)
            setRevealed(true)
          }}
          onCancel={() => setPromptOpen(false)}
        />
      )}
    </>
  )
}

// expose Eye icon for callers (kept imports clean)
export { Eye }
