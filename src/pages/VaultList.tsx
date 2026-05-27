import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ChevronDown, ChevronRight, FolderClosed, FolderOpen, Search, ShieldOff } from 'lucide-react'
import Layout from '../components/Layout'
import TypeIcon, { typeLabel } from '../components/TypeIcon'
import TierBadge from '../components/TierBadge'
import { listItems, type VaultItemRow } from '../lib/items'
import { useToast } from '../state/ToastContext'

const NO_FOLDER = '__no_folder__'

const SECTION_TITLES: Record<string, string> = {
  login: 'Passwords',
  api_key: 'API keys',
  note: 'Notes',
  other: 'Other',
}

const SECTION_SUBTITLES: Record<string, string> = {
  login: 'Logins for websites, services, and apps.',
  api_key: 'Tokens, PATs, and service credentials.',
  note: 'Free-form encrypted notes — recovery phrases, license keys, anything.',
  other: 'Items that don\'t fit the standard categories.',
}

export default function VaultList() {
  const [searchParams] = useSearchParams()
  const typeFilter = searchParams.get('type') // null = "All items"

  const [items, setItems] = useState<VaultItemRow[] | null>(null)
  const [query, setQuery] = useState('')
  const [folderFilter, setFolderFilter] = useState<string>('all')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toast = useToast()

  useEffect(() => {
    listItems()
      .then(setItems)
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : 'Failed to load items')
        setItems([])
      })
  }, [toast])

  // Reset folder filter when switching sections
  useEffect(() => {
    setFolderFilter('all')
    setQuery('')
    setCollapsed(new Set())
  }, [typeFilter])

  const filtered = useMemo(() => {
    if (!items) return []
    const q = query.trim().toLowerCase()
    return items.filter((it) => {
      if (typeFilter && it.type !== typeFilter) return false
      if (folderFilter !== 'all') {
        const f = it.folder ?? NO_FOLDER
        if (f !== folderFilter) return false
      }
      if (!q) return true
      const hay = [it.title, it.folder ?? '', it.url ?? '', it.username_hint ?? '', ...(it.tags ?? [])]
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [items, query, typeFilter, folderFilter])

  // Folder options derived from the current type-filtered set, so the dropdown
  // doesn't offer folders that have no items in this section.
  const folders = useMemo(() => {
    if (!items) return []
    const scope = typeFilter ? items.filter((it) => it.type === typeFilter) : items
    const set = new Set<string>()
    let hasNone = false
    for (const it of scope) {
      if (it.folder) set.add(it.folder)
      else hasNone = true
    }
    const arr = Array.from(set).sort((a, b) => a.localeCompare(b))
    if (hasNone) arr.push(NO_FOLDER)
    return arr
  }, [items, typeFilter])

  const grouped = useMemo(() => {
    const map = new Map<string, VaultItemRow[]>()
    for (const it of filtered) {
      const key = it.folder ?? NO_FOLDER
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(it)
    }
    return Array.from(map.entries()).sort(([a], [b]) => {
      if (a === NO_FOLDER) return 1
      if (b === NO_FOLDER) return -1
      return a.localeCompare(b)
    })
  }, [filtered])

  function toggleFolder(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const sectionTitle = typeFilter ? SECTION_TITLES[typeFilter] ?? typeLabel(typeFilter) : 'All items'
  const sectionSubtitle = typeFilter ? SECTION_SUBTITLES[typeFilter] : null
  const sectionCount = items
    ? typeFilter
      ? items.filter((it) => it.type === typeFilter).length
      : items.length
    : null

  // Section is empty (no items of this type at all)
  const sectionIsEmpty = items !== null && sectionCount === 0

  return (
    <Layout>
      <header className="mb-5">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold text-ink-50">{sectionTitle}</h1>
          {sectionCount !== null && (
            <span className="text-sm text-ink-500">{sectionCount}</span>
          )}
        </div>
        {sectionSubtitle && <p className="mt-0.5 text-xs text-ink-400">{sectionSubtitle}</p>}
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${sectionTitle.toLowerCase()}…`}
            className="input pl-9"
          />
        </div>
        {folders.length > 1 && (
          <select
            value={folderFilter}
            onChange={(e) => setFolderFilter(e.target.value)}
            className="input w-auto"
          >
            <option value="all">All folders</option>
            {folders.map((f) => (
              <option key={f} value={f}>
                {f === NO_FOLDER ? '— Unfiled —' : f}
              </option>
            ))}
          </select>
        )}
      </div>

      {items === null ? (
        <div className="card p-8 text-center text-ink-300 text-sm">Loading…</div>
      ) : sectionIsEmpty ? (
        <EmptyState section={sectionTitle} hasAnyItems={items.length > 0} />
      ) : filtered.length === 0 ? (
        <div className="card p-8 text-center text-ink-300 text-sm">
          No items match your search.
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map(([folderKey, folderItems]) => {
            const isCollapsed = collapsed.has(folderKey)
            const displayName = folderKey === NO_FOLDER ? 'Unfiled' : folderKey
            return (
              <section key={folderKey}>
                <button
                  onClick={() => toggleFolder(folderKey)}
                  className="mb-2 flex w-full items-center gap-2 text-left text-xs font-medium uppercase tracking-wider text-ink-300 hover:text-ink-100"
                >
                  {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  {isCollapsed ? <FolderClosed size={14} /> : <FolderOpen size={14} />}
                  <span>{displayName}</span>
                  <span className="text-ink-500">·</span>
                  <span className="text-ink-500">{folderItems.length}</span>
                </button>
                {!isCollapsed && (
                  <ul className="space-y-2">
                    {folderItems.map((it) => (
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
              </section>
            )
          })}
        </div>
      )}
    </Layout>
  )
}

function EmptyState({ section, hasAnyItems }: { section: string; hasAnyItems: boolean }) {
  return (
    <div className="card flex flex-col items-center gap-4 p-10 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-ink-800 text-ink-300">
        <ShieldOff />
      </div>
      <div>
        <h2 className="text-lg font-semibold text-ink-100">
          {hasAnyItems ? `No ${section.toLowerCase()} yet` : 'Your vault is empty'}
        </h2>
        <p className="mt-1 text-sm text-ink-400">
          {hasAnyItems
            ? 'Add one with the New button, or check another section in the sidebar.'
            : 'Add your first password, API key, or secure note to get started — or import a batch.'}
        </p>
      </div>
      <div className="flex gap-2">
        <Link to="/vault/new" className="btn-primary">Add an item</Link>
        {!hasAnyItems && (
          <Link to="/vault/import" className="btn-secondary">Import from file</Link>
        )}
      </div>
    </div>
  )
}
