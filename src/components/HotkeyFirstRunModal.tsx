import { useState } from 'react'
import { Keyboard as KeyboardIcon, X } from 'lucide-react'
import HotkeyRecorder, { comboToGlyph } from './HotkeyRecorder'
import { registerHotkey, setStoreValue, showWindow, unregisterAllHotkeys, unregisterHotkey } from '../lib/desktop'
import { useToast } from '../state/ToastContext'
import { useNavigate } from 'react-router-dom'

const STORE_KEY = 'quickAddHotkey'
const PROMPTED_KEY = 'hotkeyPromptedAt'

interface Props {
  onDismiss: () => void
}

export default function HotkeyFirstRunModal({ onDismiss }: Props) {
  const [combo, setCombo] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const toast = useToast()
  const navigate = useNavigate()

  async function tryRegister(c: string): Promise<boolean> {
    const ok = await registerHotkey(c, () => {})
    if (ok) await unregisterHotkey(c)
    return ok
  }

  async function dismiss() {
    await setStoreValue(PROMPTED_KEY, new Date().toISOString())
    onDismiss()
  }

  async function save() {
    if (!combo) return
    setSaving(true)
    await unregisterAllHotkeys()
    const ok = await registerHotkey(combo, async () => {
      await showWindow()
      navigate('/vault/quick-add')
    })
    if (!ok) {
      toast.error(`Couldn't register ${comboToGlyph(combo)}`)
      setSaving(false)
      return
    }
    await setStoreValue(STORE_KEY, combo)
    await setStoreValue(PROMPTED_KEY, new Date().toISOString())
    toast.success(`Hotkey set to ${comboToGlyph(combo)}`)
    setSaving(false)
    onDismiss()
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="card w-full max-w-md p-6 shadow-2xl">
        <div className="mb-4 flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-600/10 text-accent-400">
              <KeyboardIcon size={16} />
            </div>
            <div>
              <h2 className="font-semibold text-ink-50">Set a Quick Add hotkey</h2>
              <p className="mt-0.5 text-xs text-ink-400">
                Press your combo from any app to drop a new password or API key into Keyring.
              </p>
            </div>
          </div>
          <button
            onClick={dismiss}
            className="text-ink-400 hover:text-ink-100"
            aria-label="Skip"
          >
            <X size={16} />
          </button>
        </div>

        <HotkeyRecorder value={combo} onChange={setCombo} onTryRegister={tryRegister} />

        <p className="mt-3 text-xs text-ink-400">
          Optional — you can set one later in Settings.
        </p>

        <div className="mt-5 flex gap-2">
          <button onClick={dismiss} className="btn-secondary flex-1">
            Skip for now
          </button>
          <button
            onClick={save}
            disabled={!combo || saving}
            className="btn-primary flex-1"
          >
            {saving ? 'Saving…' : 'Save hotkey'}
          </button>
        </div>
      </div>
    </div>
  )
}
