import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, ExternalLink, Trash2 } from 'lucide-react'
import Layout from '../components/Layout'
import TypeIcon, { typeLabel } from '../components/TypeIcon'
import TierBadge from '../components/TierBadge'
import SecretField from '../components/SecretField'
import {
  decryptItem,
  deleteItem,
  getItem,
  touchLastAccessed,
  type DecryptedItem,
} from '../lib/items'
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

export default function ItemView() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { dek } = useVault()
  const toast = useToast()
  const [item, setItem] = useState<DecryptedItem | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    if (!id || !dek) return
    let cancelled = false
    ;(async () => {
      try {
        const row = await getItem(id)
        if (!row) {
          setError('Item not found')
          return
        }
        const decrypted = await decryptItem(row, dek)
        if (cancelled) return
        setItem(decrypted)
        touchLastAccessed(id).catch(() => {
          /* non-fatal */
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load item')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id, dek])

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

        <div className="mt-6 space-y-4 border-t border-ink-800 pt-5">
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
        </div>

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
    </Layout>
  )
}
