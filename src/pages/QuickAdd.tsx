import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, Eye, EyeOff, RefreshCw, Save, ShieldCheck, X } from 'lucide-react'
import { useAuth } from '../state/AuthContext'
import { useVault } from '../state/VaultContext'
import { useToast } from '../state/ToastContext'
import { createItem, listFolders, type ItemType, type VisibilityTier } from '../lib/items'
import { generatePassword } from '../lib/generate'
import { hideWindow, useIsDesktop } from '../lib/desktop'

const VALUE_FIELD_BY_TYPE: Record<ItemType | string, string> = {
  login: 'password',
  api_key: 'key',
  note: 'body',
  other: 'value',
}

const VALUE_LABEL_BY_TYPE: Record<ItemType | string, string> = {
  login: 'Password',
  api_key: 'API key',
  note: 'Note',
  other: 'Value',
}

export default function QuickAdd() {
  const { user } = useAuth()
  const { dek } = useVault()
  const toast = useToast()
  const navigate = useNavigate()
  const isDesktop = useIsDesktop()

  const [type, setType] = useState<ItemType | string>('login')
  const [title, setTitle] = useState('')
  const [username, setUsername] = useState('')
  const [value, setValue] = useState('')
  const [folder, setFolder] = useState('')
  const [tier, setTier] = useState<VisibilityTier>('medium')
  const [revealed, setRevealed] = useState(false)
  const [folderOptions, setFolderOptions] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    listFolders().then(setFolderOptions).catch(() => {})
  }, [])

  // Cmd+Enter to save, Esc to dismiss.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (isDesktop) {
          void (async () => {
            await hideWindow()
            navigate('/vault')
          })()
        } else {
          navigate('/vault')
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isDesktop, navigate])

  const valueFieldKey = useMemo(() => VALUE_FIELD_BY_TYPE[type] ?? 'value', [type])
  const valueLabel = useMemo(() => VALUE_LABEL_BY_TYPE[type] ?? 'Value', [type])
  const showUsername = type === 'login'

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!user || !dek) return
    if (!title.trim() || !value) {
      toast.error('Title and value are required')
      return
    }
    setSubmitting(true)
    try {
      const fields: Record<string, string> = { [valueFieldKey]: value }
      if (showUsername && username) fields.username = username

      await createItem(
        user.id,
        {
          type,
          title: title.trim(),
          folder: folder.trim() || null,
          visibility_tier: tier,
          fields,
        },
        dek,
      )
      toast.success('Saved')
      if (isDesktop) {
        // Reset for a follow-up entry, hide, then navigate so QuickAdd
        // unmounts and the window size/pos is restored (see cleanup effect).
        setTitle('')
        setUsername('')
        setValue('')
        await hideWindow()
        navigate('/vault')
      } else {
        navigate('/vault')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-ink-950 p-4">
      <div className="w-full max-w-md">
        <div className="card p-5 shadow-2xl">
          <div className="mb-4 flex items-start justify-between">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-600/10 text-accent-400">
                <ShieldCheck size={16} />
              </div>
              <div>
                <h1 className="text-sm font-semibold text-ink-50">Quick add</h1>
                <p className="text-xs text-ink-400">⌘↵ to save · Esc to dismiss</p>
              </div>
            </div>
            <button
              onClick={() => (isDesktop ? hideWindow() : navigate('/vault'))}
              className="text-ink-400 hover:text-ink-100"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>

          <form
            onSubmit={onSubmit}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void onSubmit(e as unknown as FormEvent)
              }
            }}
            className="space-y-3"
          >
            <div className="grid grid-cols-3 gap-2">
              {(['login', 'api_key', 'note', 'other'] as const).map((t) => (
                <button
                  type="button"
                  key={t}
                  onClick={() => setType(t)}
                  className={`rounded-md px-2 py-1.5 text-xs font-medium transition ${
                    type === t
                      ? 'bg-accent-600/15 text-accent-200 ring-1 ring-accent-600/40'
                      : 'bg-ink-800 text-ink-300 hover:text-ink-100'
                  }`}
                >
                  {t === 'login' ? 'Password' : t === 'api_key' ? 'API key' : t === 'note' ? 'Note' : 'Other'}
                </button>
              ))}
              {/* 4th button to balance grid */}
              <div />
            </div>

            <input
              autoFocus
              className="input"
              placeholder="Title (e.g. GitHub work account)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />

            {showUsername && (
              <input
                className="input"
                placeholder="Username / email (optional)"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
              />
            )}

            <div className="relative">
              {type === 'note' ? (
                <textarea
                  className="input-mono min-h-[88px]"
                  placeholder={valueLabel}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  required
                />
              ) : (
                <input
                  type={revealed ? 'text' : 'password'}
                  className="input-mono pr-20"
                  placeholder={valueLabel}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  autoComplete="off"
                  required
                />
              )}
              {type !== 'note' && (
                <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setRevealed((r) => !r)}
                    className="rounded p-1 text-ink-400 hover:text-ink-100"
                    title={revealed ? 'Hide' : 'Reveal'}
                  >
                    {revealed ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                  {type === 'login' && (
                    <button
                      type="button"
                      onClick={() => {
                        setValue(generatePassword(24))
                        setRevealed(true)
                      }}
                      className="rounded p-1 text-accent-300 hover:bg-ink-800"
                      title="Generate"
                    >
                      <RefreshCw size={13} />
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <input
                className="input"
                list="folder-options"
                placeholder="Folder"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
              />
              <datalist id="folder-options">
                {folderOptions.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
              <select
                value={tier}
                onChange={(e) => setTier(e.target.value as VisibilityTier)}
                className="input"
              >
                <option value="low">Low visibility</option>
                <option value="medium">Medium visibility</option>
                <option value="high">High visibility</option>
              </select>
            </div>

            <div className="flex items-center justify-between gap-2 pt-1">
              <button
                type="button"
                onClick={() => navigate('/vault')}
                className="text-xs text-ink-400 hover:text-ink-200 inline-flex items-center gap-1"
              >
                Open full vault <ArrowRight size={12} />
              </button>
              <button type="submit" className="btn-primary !py-1.5" disabled={submitting}>
                <Save size={14} />
                {submitting ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
