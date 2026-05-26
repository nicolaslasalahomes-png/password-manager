import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, CheckCircle2, FileUp, Loader2, Upload } from 'lucide-react'
import Layout from '../components/Layout'
import TypeIcon, { typeLabel } from '../components/TypeIcon'
import TierBadge from '../components/TierBadge'
import {
  createItem,
  validateImport,
  type BulkImportFile,
  type BulkImportItem,
} from '../lib/items'
import { useAuth } from '../state/AuthContext'
import { useVault } from '../state/VaultContext'
import { useToast } from '../state/ToastContext'

type Phase =
  | { kind: 'idle' }
  | { kind: 'preview'; file: BulkImportFile }
  | { kind: 'importing'; total: number; done: number; failed: number }
  | { kind: 'done'; total: number; succeeded: number; failed: number; errors: string[] }

const SAMPLE = `{
  "version": 1,
  "items": [
    {
      "type": "api_key",
      "title": "Example service key",
      "folder": "My Project",
      "tags": ["example"],
      "visibility_tier": "high",
      "url": "https://example.com",
      "fields": {
        "key": "sk_live_...",
        "notes": "Test key"
      }
    }
  ]
}`

export default function VaultImport() {
  const { user } = useAuth()
  const { dek } = useVault()
  const toast = useToast()
  const navigate = useNavigate()
  const fileInput = useRef<HTMLInputElement>(null)
  const [pasted, setPasted] = useState('')
  const [parseError, setParseError] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  const grouped = useMemo(() => {
    if (phase.kind !== 'preview') return []
    const map = new Map<string, BulkImportItem[]>()
    for (const it of phase.file.items) {
      const k = it.folder || '— Unfiled —'
      if (!map.has(k)) map.set(k, [])
      map.get(k)!.push(it)
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [phase])

  function loadFromText(text: string) {
    setParseError(null)
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Invalid JSON')
      return
    }
    const result = validateImport(raw)
    if (!result.ok) {
      setParseError(result.error)
      return
    }
    setPhase({ kind: 'preview', file: result.file })
  }

  async function onFileSelect(file: File) {
    const text = await file.text()
    setPasted(text)
    loadFromText(text)
  }

  async function runImport() {
    if (phase.kind !== 'preview' || !user || !dek) return
    const items = phase.file.items
    const errors: string[] = []
    let done = 0
    let failed = 0
    setPhase({ kind: 'importing', total: items.length, done: 0, failed: 0 })
    for (const it of items) {
      try {
        await createItem(
          user.id,
          {
            type: it.type,
            title: it.title,
            folder: it.folder ?? null,
            tags: it.tags ?? [],
            visibility_tier: it.visibility_tier ?? 'medium',
            url: it.url ?? null,
            username_hint: it.username_hint ?? null,
            fields: it.fields,
          },
          dek,
        )
        done++
      } catch (err) {
        failed++
        errors.push(`${it.title}: ${err instanceof Error ? err.message : 'unknown error'}`)
      }
      setPhase({ kind: 'importing', total: items.length, done, failed })
    }
    setPhase({ kind: 'done', total: items.length, succeeded: done, failed, errors })
    if (failed === 0) toast.success(`Imported ${done} items`)
    else toast.error(`Imported ${done}, failed ${failed}`)
  }

  return (
    <Layout>
      <button
        onClick={() => navigate('/vault')}
        className="btn-ghost mb-4 !px-2 !py-1.5 !text-ink-400"
      >
        <ArrowLeft size={14} /> Back to vault
      </button>

      <div className="card p-6">
        <h1 className="text-lg font-semibold text-ink-50">Bulk import</h1>
        <p className="mt-1 text-sm text-ink-400">
          Upload or paste a JSON file. Items are encrypted in your browser before they're sent —
          your master password and the secret values never leave this tab.
        </p>

        {phase.kind === 'idle' || phase.kind === 'preview' ? (
          <>
            <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className="card flex flex-col items-center justify-center gap-2 border-dashed py-8 text-ink-300 hover:border-accent-500/40 hover:text-ink-100"
              >
                <FileUp size={22} />
                <span className="text-sm font-medium">Upload JSON file</span>
                <span className="text-xs text-ink-400">.json — opened locally, never uploaded as-is</span>
              </button>
              <input
                ref={fileInput}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void onFileSelect(f)
                }}
              />
              <div className="card flex flex-col gap-2 p-4">
                <span className="text-xs font-medium uppercase tracking-wide text-ink-300">
                  …or paste JSON
                </span>
                <textarea
                  value={pasted}
                  onChange={(e) => setPasted(e.target.value)}
                  className="input-mono min-h-[120px] text-xs"
                  placeholder={SAMPLE}
                />
                <button
                  type="button"
                  onClick={() => loadFromText(pasted)}
                  disabled={!pasted.trim()}
                  className="btn-secondary self-end !py-1 !text-xs"
                >
                  Parse
                </button>
              </div>
            </div>

            {parseError && (
              <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-950/40 p-3 text-sm text-red-200">
                <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
                <span>{parseError}</span>
              </div>
            )}

            {phase.kind === 'preview' && (
              <div className="mt-6">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-medium text-ink-100">
                    Ready to import — {phase.file.items.length} items
                  </h2>
                  <button onClick={runImport} className="btn-primary">
                    <Upload size={14} /> Encrypt &amp; import
                  </button>
                </div>
                <div className="space-y-4">
                  {grouped.map(([folder, items]) => (
                    <div key={folder}>
                      <h3 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-300">
                        {folder} <span className="text-ink-500">· {items.length}</span>
                      </h3>
                      <ul className="space-y-1.5">
                        {items.map((it, i) => (
                          <li
                            key={i}
                            className="flex items-center gap-2 rounded-md border border-ink-700/50 bg-ink-800/40 px-2.5 py-1.5 text-sm"
                          >
                            <TypeIcon type={it.type} size={13} />
                            <span className="flex-1 truncate text-ink-100">{it.title}</span>
                            <span className="text-xs text-ink-400">{typeLabel(it.type)}</span>
                            <TierBadge tier={it.visibility_tier ?? 'medium'} compact />
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : phase.kind === 'importing' ? (
          <div className="mt-6 flex flex-col items-center gap-3 py-8">
            <Loader2 className="h-6 w-6 animate-spin text-accent-400" />
            <p className="text-sm text-ink-200">
              Encrypting &amp; uploading — {phase.done + phase.failed} / {phase.total}
              {phase.failed > 0 && (
                <span className="ml-2 text-red-300">({phase.failed} failed)</span>
              )}
            </p>
            <div className="h-1.5 w-full max-w-md overflow-hidden rounded-full bg-ink-800">
              <div
                className="h-full bg-accent-500 transition-all"
                style={{ width: `${((phase.done + phase.failed) / phase.total) * 100}%` }}
              />
            </div>
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            <div
              className={`flex items-start gap-3 rounded-lg border p-4 ${
                phase.failed === 0
                  ? 'border-emerald-500/40 bg-emerald-950/40 text-emerald-100'
                  : 'border-amber-500/40 bg-amber-950/40 text-amber-100'
              }`}
            >
              <CheckCircle2 size={20} className="mt-0.5" />
              <div>
                <p className="font-medium">
                  Imported {phase.succeeded} of {phase.total} items
                  {phase.failed > 0 && ` (${phase.failed} failed)`}
                </p>
                {phase.errors.length > 0 && (
                  <ul className="mt-2 space-y-1 text-xs">
                    {phase.errors.map((e, i) => (
                      <li key={i}>• {e}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => navigate('/vault')} className="btn-primary">
                Go to vault
              </button>
              <button
                onClick={() => {
                  setPhase({ kind: 'idle' })
                  setPasted('')
                  setParseError(null)
                }}
                className="btn-secondary"
              >
                Import another file
              </button>
            </div>
          </div>
        )}
      </div>

      {phase.kind === 'idle' && (
        <details className="mt-6">
          <summary className="cursor-pointer text-sm text-ink-300 hover:text-ink-100">
            JSON schema reference
          </summary>
          <pre className="card mt-3 max-h-72 overflow-auto p-4 text-xs text-ink-200">
{`{
  "version": 1,
  "items": [
    {
      "type": "login" | "api_key" | "note" | "other",
      "title": "string (required)",
      "folder": "string or null",
      "tags": ["string", ...],
      "visibility_tier": "low" | "medium" | "high",
      "url": "string or null",
      "fields": { "<any field name>": "<string value>" }
    }
  ]
}`}
          </pre>
        </details>
      )}
    </Layout>
  )
}
