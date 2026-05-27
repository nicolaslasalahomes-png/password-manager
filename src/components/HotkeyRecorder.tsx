import { useEffect, useRef, useState } from 'react'
import { Keyboard, X } from 'lucide-react'

interface Props {
  value: string | null
  onChange: (combo: string | null) => void
  /** Called when the user clicks "Try" — caller verifies the combo is accepted. */
  onTryRegister?: (combo: string) => Promise<boolean>
}

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift'])

/**
 * Normalize a KeyboardEvent into Tauri's accelerator string format.
 *   e.g. Cmd+Shift+K  →  "Command+Shift+K"
 */
function eventToCombo(e: KeyboardEvent): string | null {
  const parts: string[] = []
  if (e.metaKey) parts.push('Command')
  if (e.ctrlKey) parts.push('Control')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')

  if (MODIFIER_KEYS.has(e.key)) return null // waiting for a non-modifier
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key
  parts.push(key)
  if (parts.length < 2) return null // must have at least one modifier
  return parts.join('+')
}

/**
 * Convert a stored combo to a friendly macOS glyph string.
 *   "Command+Shift+K" → "⌘⇧K"
 */
export function comboToGlyph(combo: string | null): string {
  if (!combo) return ''
  return combo
    .split('+')
    .map((p) => {
      switch (p) {
        case 'Command':
        case 'Meta':
          return '⌘'
        case 'Control':
          return '⌃'
        case 'Alt':
        case 'Option':
          return '⌥'
        case 'Shift':
          return '⇧'
        default:
          return p
      }
    })
    .join('')
}

export default function HotkeyRecorder({ value, onChange, onTryRegister }: Props) {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!recording) return
    boxRef.current?.focus()
    const handler = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(false)
        return
      }
      const combo = eventToCombo(e)
      if (!combo) return
      setRecording(false)
      setError(null)
      if (onTryRegister) {
        void onTryRegister(combo).then((ok) => {
          if (ok) onChange(combo)
          else setError(`Could not register ${comboToGlyph(combo)} — already in use?`)
        })
      } else {
        onChange(combo)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [recording, onChange, onTryRegister])

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div
          ref={boxRef}
          tabIndex={0}
          onClick={() => setRecording(true)}
          className={`flex h-10 flex-1 cursor-pointer items-center justify-between rounded-lg border px-3 text-sm transition ${
            recording
              ? 'border-accent-500 bg-ink-800 text-accent-200'
              : 'border-ink-700 bg-ink-800 text-ink-200 hover:border-ink-600'
          }`}
        >
          <span className="flex items-center gap-2">
            <Keyboard size={14} />
            {recording ? (
              <span className="text-accent-300">Press a key combination… (Esc to cancel)</span>
            ) : value ? (
              <span className="font-mono">{comboToGlyph(value)}</span>
            ) : (
              <span className="text-ink-400">No hotkey assigned — click to record</span>
            )}
          </span>
          {value && !recording && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onChange(null)
                setError(null)
              }}
              className="text-ink-400 hover:text-ink-100"
              aria-label="Clear hotkey"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      {error && <p className="text-xs text-red-300">{error}</p>}
      <p className="text-xs text-ink-400">
        Use a combo that isn't claimed by macOS or another app. <kbd>⌘⇧K</kbd>, <kbd>⌥⌘V</kbd>,
        and <kbd>⌃⌥Space</kbd> are usually safe.
      </p>
    </div>
  )
}
