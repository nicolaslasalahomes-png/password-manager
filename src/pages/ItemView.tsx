import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Check,
  ExternalLink,
  Fingerprint,
  Folder,
  Lock,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  X,
} from 'lucide-react'
import Layout from '../components/Layout'
import TypeIcon, { typeLabel } from '../components/TypeIcon'
import TierBadge from '../components/TierBadge'
import SecretField from '../components/SecretField'
import MasterPasswordPrompt from '../components/MasterPasswordPrompt'
import DateTimePicker from '../components/DateTimePicker'
import {
  decryptItem,
  deleteItem,
  getItem,
  HighTierLockedError,
  listFolders,
  touchLastAccessed,
  updateItem,
  type DecryptedItem,
  type ItemType,
  type Priority,
  type VaultItemRow,
  type VaultKeys,
  type VisibilityTier,
} from '../lib/items'
import { markTaskComplete, markTaskIncomplete } from '../lib/tasks'
import { useVault } from '../state/VaultContext'
import { useToast } from '../state/ToastContext'

const FIELD_LABEL_OVERRIDES: Record<string, string> = {
  username: 'Username / email',
  password: 'Password',
  totp: '2FA / TOTP',
  key: 'API key',
  project: 'Project / scope',
  expires_at: 'Expires',
  body: 'Note',
  notes: 'Notes',
}

function labelFor(key: string): string {
  return FIELD_LABEL_OVERRIDES[key] ?? key
}

function isMultiline(key: string): boolean {
  return ['notes', 'body', 'key'].includes(key)
}

/**
 * Which field on an item is its "primary secret" — the actual password or
 * API key. We lock this field from edits to prevent accidental overwrites;
 * to rotate, the user deletes and recreates.
 */
function lockedFieldKey(type: ItemType | string): string | null {
  if (type === 'login') return 'password'
  if (type === 'api_key') return 'key'
  return null
}

export default function ItemView() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { dek, highDek, elevate } = useVault()
  const toast = useToast()
  const [item, setItem] = useState<DecryptedItem | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [editing, setEditing] = useState(false)
  // True when this is a high-tier item viewed under a Touch ID (standard)
  // session: we render the item chrome but gate the secret behind elevation.
  const [needsElevation, setNeedsElevation] = useState(false)
  const [showElevatePrompt, setShowElevatePrompt] = useState(false)
  const [togglingDone, setTogglingDone] = useState(false)

  useEffect(() => {
    if (!id || !dek) return
    let cancelled = false
    setError(null)
    ;(async () => {
      let row: VaultItemRow | null = null
      try {
        row = await getItem(id)
        if (!row) {
          if (!cancelled) setError('Item not found')
          return
        }
        const decrypted = await decryptItem(row, { dek, highDek })
        if (cancelled) return
        setItem(decrypted)
        setNeedsElevation(false)
        touchLastAccessed(id).catch(() => {
          /* non-fatal */
        })
      } catch (err) {
        if (cancelled) return
        if (err instanceof HighTierLockedError && row) {
          // Show the non-secret chrome (title, tier, folder…) but hold the
          // encrypted fields behind a master-password elevation gate.
          const { encrypted_data: _ed, iv: _iv, ...rest } = row
          void _ed
          void _iv
          setItem({ ...rest, fields: {} })
          setNeedsElevation(true)
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to load item')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id, dek, highDek])

  async function onToggleComplete() {
    if (!id || !item) return
    setTogglingDone(true)
    try {
      if (item.completed_at) {
        await markTaskIncomplete(id)
        setItem({ ...item, completed_at: null })
        toast.success('Task reopened')
      } else {
        const ts = new Date().toISOString()
        await markTaskComplete(id)
        setItem({ ...item, completed_at: ts })
        toast.success('Task completed — kept in your history')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update task')
    } finally {
      setTogglingDone(false)
    }
  }

  async function onDelete() {
    if (!id) return
    if (!confirm('Delete this item? This cannot be undone.')) return
    setDeleting(true)
    try {
      await deleteItem(id)
      toast.success('Item deleted')
      navigate('/vault', { replace: true })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed')
      setDeleting(false)
    }
  }

  if (error) {
    return (
      <Layout>
        <div className="card p-6 text-sm text-red-300">{error}</div>
      </Layout>
    )
  }

  if (!item) {
    return (
      <Layout>
        <div className="card p-8 text-center text-ink-300 text-sm">Decrypting…</div>
      </Layout>
    )
  }

  if (editing && id && dek && !needsElevation) {
    return (
      <EditMode
        item={item}
        keys={{ dek, highDek }}
        id={id}
        onCancel={() => setEditing(false)}
        onSaved={(updated) => {
          setItem(updated)
          setEditing(false)
        }}
      />
    )
  }

  const fieldKeys = Object.keys(item.fields)

  return (
    <Layout>
      <button
        onClick={() => navigate('/vault')}
        className="btn-ghost mb-4 !px-2 !py-1.5 !text-ink-400"
      >
        <ArrowLeft size={14} /> Back
      </button>

      <div className="card p-6">
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-ink-800 text-ink-300">
            <TypeIcon type={item.type} size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="break-words text-xl font-semibold text-ink-50">{item.title}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-400">
              <span>{typeLabel(item.type)}</span>
              <TierBadge tier={item.visibility_tier} />
              {item.folder && (
                <span className="inline-flex items-center gap-1 text-ink-300">
                  <Folder size={11} /> {item.folder}
                </span>
              )}
              {item.tags?.length > 0 && (
                <>
                  <span>·</span>
                  <span>{item.tags.join(', ')}</span>
                </>
              )}
            </div>
            {item.url && (
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1 break-all text-sm text-accent-400 hover:text-accent-300"
              >
                {item.url} <ExternalLink size={12} />
              </a>
            )}
          </div>
          <div className="flex flex-shrink-0 items-center gap-1">
            {item.due_at && !needsElevation && (
              <button
                onClick={onToggleComplete}
                disabled={togglingDone}
                className={
                  item.completed_at
                    ? 'btn-ghost'
                    : 'btn-ghost !text-emerald-400 hover:!bg-emerald-950/40'
                }
                title={item.completed_at ? 'Reopen task' : 'Mark complete'}
              >
                {item.completed_at ? (
                  <>
                    <RotateCcw size={14} /> Reopen
                  </>
                ) : (
                  <>
                    <Check size={14} /> Complete
                  </>
                )}
              </button>
            )}
            {!needsElevation && (
              <button
                onClick={() => setEditing(true)}
                className="btn-ghost"
                title="Edit item"
              >
                <Pencil size={14} /> Edit
              </button>
            )}
            <button
              onClick={onDelete}
              disabled={deleting}
              className="btn-ghost !text-red-400 hover:!bg-red-950/40"
              title="Delete item"
            >
              <Trash2 size={14} />
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>

        <div className="mt-6 space-y-4 border-t border-ink-800 pt-5">
          {needsElevation ? (
            <div className="rounded-lg border border-amber-500/30 bg-amber-950/20 p-5 text-center">
              <Lock size={20} className="mx-auto mb-2 text-amber-300" />
              <p className="text-sm font-medium text-amber-100">High-tier item — locked</p>
              <p className="mx-auto mt-1 max-w-sm text-xs text-amber-200/70">
                This item is protected by a key Touch ID never stores. Enter your
                master password to unlock high-tier items for this session.
              </p>
              <button
                onClick={() => setShowElevatePrompt(true)}
                className="btn-primary mx-auto mt-4"
              >
                <Fingerprint size={14} /> Unlock with master password
              </button>
            </div>
          ) : (
            <>
              {fieldKeys.length === 0 && (
                <p className="text-sm text-ink-400">No encrypted fields on this item.</p>
              )}
              {fieldKeys.map((key) => (
                <SecretField
                  key={key}
                  label={labelFor(key)}
                  value={item.fields[key]}
                  tier={item.visibility_tier}
                  multiline={isMultiline(key)}
                />
              ))}
            </>
          )}
        </div>

        {item.due_at && (
          <div className="mt-6 flex flex-wrap items-center gap-3 rounded-lg border border-ink-800 bg-ink-900/40 p-3 text-xs">
            <span className="text-ink-500">Task</span>
            <span className={item.completed_at ? 'text-emerald-300' : 'text-ink-100'}>
              {item.completed_at
                ? `Completed ${new Date(item.completed_at).toLocaleDateString()}`
                : `Due ${new Date(item.due_at).toLocaleString()}`}
            </span>
            {item.priority && (
              <span className="rounded bg-ink-800 px-1.5 py-0.5 uppercase tracking-wider text-ink-300">
                {item.priority}
              </span>
            )}
          </div>
        )}

        <div className="mt-6 grid grid-cols-2 gap-3 border-t border-ink-800 pt-4 text-xs text-ink-400">
          <div>
            <div className="text-ink-500">Created</div>
            <div>{new Date(item.created_at).toLocaleString()}</div>
          </div>
          <div>
            <div className="text-ink-500">Updated</div>
            <div>{new Date(item.updated_at).toLocaleString()}</div>
          </div>
        </div>
      </div>

      {showElevatePrompt && (
        <MasterPasswordPrompt
          title="Unlock high-tier items"
          message="Your master password unwraps the high-tier key for this session. It's never stored."
          action={elevate}
          onVerified={() => setShowElevatePrompt(false)}
          onCancel={() => setShowElevatePrompt(false)}
        />
      )}
    </Layout>
  )
}

interface EditModeProps {
  item: DecryptedItem
  keys: VaultKeys
  id: string
  onCancel: () => void
  onSaved: (updated: DecryptedItem) => void
}

function isoToLocalInput(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

function EditMode({ item, keys, id, onCancel, onSaved }: EditModeProps) {
  const toast = useToast()
  const lockedKey = useMemo(() => lockedFieldKey(item.type), [item.type])
  const isTask = item.type === 'task'

  const [title, setTitle] = useState(item.title)
  const [folder, setFolder] = useState(item.folder ?? '')
  const [folderOptions, setFolderOptions] = useState<string[]>([])
  const [url, setUrl] = useState(item.url ?? '')
  const [tagsText, setTagsText] = useState(item.tags?.join(', ') ?? '')
  const [tier, setTier] = useState<VisibilityTier>(item.visibility_tier)
  const [dueAt, setDueAt] = useState(item.due_at ? isoToLocalInput(item.due_at) : '')
  const [priority, setPriority] = useState<Priority>((item.priority as Priority) ?? 'medium')
  const [fields, setFields] = useState<Record<string, string>>(() => ({ ...item.fields }))
  const [newFieldKey, setNewFieldKey] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    listFolders().then(setFolderOptions).catch(() => {})
  }, [])

  function setField(key: string, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }))
  }

  function removeField(key: string) {
    setFields((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  function addCustomField() {
    const key = newFieldKey.trim()
    if (!key) return
    if (key in fields) {
      toast.error(`Field "${key}" already exists`)
      return
    }
    setFields((prev) => ({ ...prev, [key]: '' }))
    setNewFieldKey('')
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!title.trim()) {
      toast.error('Title is required')
      return
    }
    if (isTask && !dueAt) {
      toast.error('A task needs a due date')
      return
    }
    setSubmitting(true)
    try {
      // Build the new fields payload. If a field is locked, preserve the
      // original value untouched even if it somehow got changed.
      const nextFields: Record<string, string> = {}
      for (const [k, v] of Object.entries(fields)) {
        if (k === lockedKey) {
          nextFields[k] = item.fields[k] ?? '' // never mutate the locked value
        } else if (v.length > 0) {
          nextFields[k] = v
        }
      }

      const tags = tagsText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)

      const updated = await updateItem(
        id,
        {
          title: title.trim(),
          folder: folder.trim() || null,
          tags,
          visibility_tier: tier,
          url: url.trim() || null,
          fields: nextFields,
          // Only touch task fields for tasks; undefined leaves them unchanged.
          due_at: isTask ? (dueAt ? new Date(dueAt).toISOString() : null) : undefined,
          priority: isTask ? priority : undefined,
        },
        keys,
      )
      toast.success('Saved')
      onSaved({
        ...item,
        title: updated.title,
        folder: updated.folder,
        tags: updated.tags,
        visibility_tier: updated.visibility_tier,
        url: updated.url,
        due_at: updated.due_at,
        priority: updated.priority,
        updated_at: updated.updated_at,
        fields: nextFields,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Layout>
      <button
        onClick={onCancel}
        className="btn-ghost mb-4 !px-2 !py-1.5 !text-ink-400"
      >
        <ArrowLeft size={14} /> Back to view
      </button>

      <form onSubmit={onSubmit} className="card space-y-5 p-6">
        <header className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-ink-50">Edit item</h1>
          <span className="text-xs text-ink-400">Type: {typeLabel(item.type)} (locked)</span>
        </header>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label">Title</label>
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label">Folder</label>
            <input
              className="input"
              list="folder-options"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="(none)"
            />
            <datalist id="folder-options">
              {folderOptions.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </div>
          <div>
            <label className="label">URL</label>
            <input
              className="input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <label className="label">Tags (comma-separated)</label>
            <input
              className="input"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="work, github, dev"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="label">Visibility tier</label>
            <select
              value={tier}
              onChange={(e) => setTier(e.target.value as VisibilityTier)}
              className="input"
            >
              <option value="low">Low — visible after vault unlock</option>
              <option value="medium">Medium — blurred, click to reveal</option>
              <option value="high">High — copy only, never shown on screen</option>
            </select>
          </div>
        </div>

        {isTask && (
          <div className="rounded-lg border border-accent-600/30 bg-accent-950/20 p-4">
            <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-accent-300">
              Task settings
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="label">Due date &amp; time</label>
                <DateTimePicker value={dueAt} onChange={setDueAt} />
              </div>
              <div>
                <label className="label">Priority</label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as Priority)}
                  className="input"
                >
                  <option value="low">Low — 1 reminder/day</option>
                  <option value="medium">Medium — 2 reminders/day</option>
                  <option value="high">High — 4 reminders/day</option>
                </select>
              </div>
            </div>
          </div>
        )}

        <div className="border-t border-ink-800 pt-5">
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-300">
            Encrypted fields
          </h2>
          <div className="space-y-3">
            {Object.keys(fields).length === 0 && (
              <p className="text-xs text-ink-400">No fields. Add one below.</p>
            )}
            {Object.entries(fields).map(([key, value]) => {
              const locked = key === lockedKey
              const multiline = isMultiline(key)
              return (
                <div key={key}>
                  <div className="mb-1.5 flex items-center justify-between">
                    <label className="label !mb-0">
                      {labelFor(key)}
                      {locked && (
                        <span className="ml-2 inline-flex items-center gap-1 rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-amber-300">
                          <Lock size={9} /> locked
                        </span>
                      )}
                    </label>
                    {!locked && (
                      <button
                        type="button"
                        onClick={() => removeField(key)}
                        className="text-xs text-ink-400 hover:text-red-300"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  {locked ? (
                    <div className="input-mono select-none py-2.5 text-ink-500">
                      ••••••••••••
                      <p className="mt-1 text-[11px] text-ink-400 normal-case tracking-normal">
                        To rotate this {key === 'password' ? 'password' : 'API key'}, delete this
                        item and create a new one.
                      </p>
                    </div>
                  ) : multiline ? (
                    <textarea
                      className="input-mono min-h-[80px]"
                      value={value}
                      onChange={(e) => setField(key, e.target.value)}
                    />
                  ) : (
                    <input
                      className="input-mono"
                      value={value}
                      onChange={(e) => setField(key, e.target.value)}
                      autoComplete="off"
                    />
                  )}
                </div>
              )
            })}
          </div>

          <div className="mt-4 flex gap-2">
            <input
              className="input flex-1"
              placeholder="Add a new field (e.g. notes, 2fa, recovery_email)"
              value={newFieldKey}
              onChange={(e) => setNewFieldKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addCustomField()
                }
              }}
            />
            <button
              type="button"
              onClick={addCustomField}
              className="btn-secondary"
              disabled={!newFieldKey.trim()}
            >
              <Plus size={14} /> Add field
            </button>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-ink-800 pt-5">
          <button type="button" onClick={onCancel} className="btn-secondary">
            <X size={14} /> Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={submitting}>
            <Save size={14} />
            {submitting ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>
    </Layout>
  )
}
