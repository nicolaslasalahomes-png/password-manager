import { useMemo, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Eye, EyeOff, RefreshCw, Save, Trash2 } from 'lucide-react'
import Layout from '../components/Layout'
import { useAuth } from '../state/AuthContext'
import { useVault } from '../state/VaultContext'
import { useToast } from '../state/ToastContext'
import { createItem, type ItemType, type VisibilityTier } from '../lib/items'
import { generatePassword } from '../lib/generate'

interface FieldDef {
  key: string
  label: string
  multiline?: boolean
  generator?: boolean
}

function fieldsForType(type: ItemType | string): FieldDef[] {
  switch (type) {
    case 'login':
      return [
        { key: 'username', label: 'Username / email' },
        { key: 'password', label: 'Password', generator: true },
        { key: 'totp', label: '2FA backup code / TOTP secret' },
        { key: 'notes', label: 'Notes', multiline: true },
      ]
    case 'api_key':
      return [
        { key: 'key', label: 'API key', multiline: true },
        { key: 'project', label: 'Project / scope' },
        { key: 'expires_at', label: 'Expires (YYYY-MM-DD)' },
        { key: 'notes', label: 'Notes', multiline: true },
      ]
    case 'note':
      return [{ key: 'body', label: 'Note body', multiline: true }]
    default:
      return [{ key: 'notes', label: 'Notes', multiline: true }]
  }
}

export default function ItemNew() {
  const { user } = useAuth()
  const { dek } = useVault()
  const toast = useToast()
  const navigate = useNavigate()

  const [type, setType] = useState<ItemType | string>('login')
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [tagsText, setTagsText] = useState('')
  const [tier, setTier] = useState<VisibilityTier>('medium')
  const [values, setValues] = useState<Record<string, string>>({})
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set())
  const [customFields, setCustomFields] = useState<{ key: string; value: string }[]>([])
  const [submitting, setSubmitting] = useState(false)

  const fieldDefs = useMemo(() => fieldsForType(type), [type])

  function toggleReveal(key: string) {
    setRevealedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!user || !dek) return
    if (!title.trim()) {
      toast.error('Title is required')
      return
    }
    setSubmitting(true)
    try {
      const fields: Record<string, string> = {}
      for (const def of fieldDefs) {
        const v = values[def.key]
        if (v && v.length > 0) fields[def.key] = v
      }
      for (const cf of customFields) {
        if (cf.key.trim() && cf.value.length > 0) {
          fields[cf.key.trim()] = cf.value
        }
      }
      const tags = tagsText
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)

      const created = await createItem(
        user.id,
        {
          type,
          title: title.trim(),
          url: url.trim() || null,
          tags,
          visibility_tier: tier,
          fields,
        },
        dek,
      )
      toast.success('Item saved')
      navigate(`/vault/${created.id}`, { replace: true })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Layout>
      <button
        onClick={() => navigate(-1)}
        className="btn-ghost mb-4 !px-2 !py-1.5 !text-ink-400"
      >
        <ArrowLeft size={14} /> Back
      </button>
      <form onSubmit={onSubmit} className="card space-y-5 p-6">
        <h1 className="text-lg font-semibold text-ink-50">New item</h1>

        {/* Type + tier */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="label">Type</label>
            <select
              value={type}
              onChange={(e) => {
                setType(e.target.value)
                setValues({})
                setRevealedKeys(new Set())
              }}
              className="input"
            >
              <option value="login">Login</option>
              <option value="api_key">API key</option>
              <option value="note">Secure note</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label className="label">Visibility tier</label>
            <select
              value={tier}
              onChange={(e) => setTier(e.target.value as VisibilityTier)}
              className="input"
            >
              <option value="low">Low — visible after vault unlock</option>
              <option value="medium">Medium — reveal needs master password</option>
              <option value="high">High — copy only, never shown on screen</option>
            </select>
          </div>
        </div>

        {/* Title + URL */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label">Title</label>
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              autoFocus
              placeholder="e.g. GitHub — work account"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="label">URL (optional, stored as plaintext)</label>
            <input
              className="input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com"
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
        </div>

        {/* Type-specific fields */}
        <div className="border-t border-ink-800 pt-5">
          <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-ink-300">
            Encrypted fields
          </h2>
          <div className="space-y-3">
            {fieldDefs.map((def) => (
              <div key={def.key}>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="label !mb-0">{def.label}</label>
                  <div className="flex items-center gap-1">
                    {!def.multiline && (
                      <button
                        type="button"
                        onClick={() => toggleReveal(def.key)}
                        className="rounded px-1.5 py-0.5 text-xs text-ink-300 hover:bg-ink-800 hover:text-ink-100"
                      >
                        {revealedKeys.has(def.key) ? <EyeOff size={12} /> : <Eye size={12} />}
                      </button>
                    )}
                    {def.generator && (
                      <button
                        type="button"
                        onClick={() => {
                          setValues((v) => ({ ...v, [def.key]: generatePassword(24) }))
                          setRevealedKeys((r) => new Set(r).add(def.key))
                        }}
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-accent-300 hover:bg-ink-800"
                        title="Generate a 24-char random password"
                      >
                        <RefreshCw size={12} /> Generate
                      </button>
                    )}
                  </div>
                </div>
                {def.multiline ? (
                  <textarea
                    className="input-mono min-h-[100px]"
                    value={values[def.key] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [def.key]: e.target.value }))}
                  />
                ) : (
                  <input
                    type={revealedKeys.has(def.key) ? 'text' : 'password'}
                    className="input-mono"
                    value={values[def.key] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [def.key]: e.target.value }))}
                    autoComplete="off"
                  />
                )}
              </div>
            ))}
          </div>

          {/* Custom fields */}
          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-medium uppercase tracking-wide text-ink-300">
                Custom fields
              </h3>
              <button
                type="button"
                onClick={() => setCustomFields((cf) => [...cf, { key: '', value: '' }])}
                className="btn-ghost !px-2 !py-1 !text-xs"
              >
                + Add field
              </button>
            </div>
            {customFields.length === 0 && (
              <p className="text-xs text-ink-400">
                Add any extra fields you want — recovery codes, billing email, etc.
              </p>
            )}
            <div className="space-y-2">
              {customFields.map((cf, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    className="input flex-1"
                    placeholder="Field name"
                    value={cf.key}
                    onChange={(e) =>
                      setCustomFields((arr) => {
                        const next = [...arr]
                        next[i] = { ...next[i], key: e.target.value }
                        return next
                      })
                    }
                  />
                  <input
                    className="input-mono flex-[2]"
                    placeholder="Value"
                    value={cf.value}
                    onChange={(e) =>
                      setCustomFields((arr) => {
                        const next = [...arr]
                        next[i] = { ...next[i], value: e.target.value }
                        return next
                      })
                    }
                  />
                  <button
                    type="button"
                    onClick={() => setCustomFields((arr) => arr.filter((_, j) => j !== i))}
                    className="btn-ghost !px-2 !text-ink-400"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-ink-800 pt-5">
          <button type="button" className="btn-secondary" onClick={() => navigate('/vault')}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={submitting}>
            <Save size={14} />
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Layout>
  )
}
