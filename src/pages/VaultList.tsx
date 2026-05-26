import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Search, ShieldOff } from 'lucide-react'
import Layout from '../components/Layout'
import TypeIcon, { typeLabel } from '../components/TypeIcon'
import TierBadge from '../components/TierBadge'
import { listItems, type VaultItemRow } from '../lib/items'
import { useToast } from '../state/ToastContext'

export default function VaultList() {
  const [items, setItems] = useState<VaultItemRow[] | null>(null)
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const toast = useToast()

  useEffect(() => {
    listItems()
      .then(setItems)
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : 'Failed to load items')
        setItems([])
      })
  }, [toast])

  const filtered = useMemo(() => {
    if (!items) return []
    const q = query.trim().toLowerCase()
    return items.filter((it) => {
      if (typeFilter !== 'all' && it.type !== typeFilter) return false
      if (!q) return true
      const hay = [it.title, it.url ?? '', it.username_hint ?? '', ...(it.tags ?? [])]
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [items, query, typeFilter])

  const types = useMemo(() => {
    if (!items) return []
    return Array.from(new Set(items.map((it) => it.type))).sort()
  }, [items])

  return (
    <Layout>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by title, URL, hint, or tag…"
            className="input pl-9"
          />
        </div>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="input w-auto"
        >
          <option value="all">All types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {typeLabel(t)}
            </option>
          ))}
        </select>
      </div>

      {items === null ? (
        <div className="card p-8 text-center text-ink-300 text-sm">Loading…</div>
      ) : items.length === 0 ? (
        <EmptyState />
      ) : filtered.length === 0 ? (
        <div className="card p-8 text-center text-ink-300 text-sm">
          No items match your search.
        </div>
      ) : (
        <ul className="space-y-2">
          {filtered.map((it) => (
            <li key={it.id}>
              <Link
                to={`/vault/${it.id}`}
                className="card flex items-center gap-3 p-3 transition hover:border-accent-500/40 hover:bg-ink-800/60"
              >
                <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-ink-800 text-ink-300">
                  <TypeIcon type={it.type} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-ink-100">{it.title}</span>
                    <TierBadge tier={it.visibility_tier} compact />
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-400">
                    <span>{typeLabel(it.type)}</span>
                    {it.url && (
                      <>
                        <span>·</span>
                        <span className="truncate">{it.url}</span>
                      </>
                    )}
                    {it.tags?.length > 0 && (
                      <>
                        <span>·</span>
                        <span className="truncate">{it.tags.join(', ')}</span>
                      </>
                    )}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Layout>
  )
}

function EmptyState() {
  return (
    <div className="card flex flex-col items-center gap-4 p-10 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-ink-800 text-ink-300">
        <ShieldOff />
      </div>
      <div>
        <h2 className="text-lg font-semibold text-ink-100">Your vault is empty</h2>
        <p className="mt-1 text-sm text-ink-400">
          Add your first password, API key, or secure note to get started.
        </p>
      </div>
      <Link to="/vault/new" className="btn-primary">
        Add the first item
      </Link>
    </div>
  )
}
