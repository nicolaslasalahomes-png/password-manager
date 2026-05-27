import { useEffect, useState } from 'react'
import { NavLink, useSearchParams } from 'react-router-dom'
import { FileText, Key, LayoutGrid, Lock, Sparkles } from 'lucide-react'
import { listItems } from '../lib/items'

type Counts = Record<string, number> & { _all: number }

interface NavItem {
  label: string
  to: string
  icon: typeof Lock
  /** Matches against the `type` URL query param. `null` = the "all" view (no type filter). */
  typeKey: string | null
  /** Item types that count toward this section. Empty = all (for "All items"). */
  countTypes: string[]
}

const NAV_ITEMS: NavItem[] = [
  { label: 'All items', to: '/vault', icon: LayoutGrid, typeKey: null, countTypes: [] },
  { label: 'Passwords', to: '/vault?type=login', icon: Lock, typeKey: 'login', countTypes: ['login'] },
  { label: 'API keys', to: '/vault?type=api_key', icon: Key, typeKey: 'api_key', countTypes: ['api_key'] },
  { label: 'Notes', to: '/vault?type=note', icon: FileText, typeKey: 'note', countTypes: ['note'] },
  { label: 'Other', to: '/vault?type=other', icon: Sparkles, typeKey: 'other', countTypes: ['other'] },
]

export default function Sidebar() {
  const [counts, setCounts] = useState<Counts | null>(null)
  const [searchParams] = useSearchParams()
  const activeType = searchParams.get('type')

  useEffect(() => {
    listItems()
      .then((items) => {
        const c: Counts = { _all: items.length }
        for (const it of items) {
          c[it.type] = (c[it.type] ?? 0) + 1
        }
        setCounts(c)
      })
      .catch(() => setCounts({ _all: 0 } as Counts))
  }, [])

  function countFor(item: NavItem): number | null {
    if (!counts) return null
    if (item.countTypes.length === 0) return counts._all
    return item.countTypes.reduce((sum, t) => sum + (counts[t] ?? 0), 0)
  }

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:block md:w-52 md:flex-shrink-0">
        <nav className="sticky top-20 space-y-0.5">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const isActive =
              item.typeKey === null ? activeType === null : activeType === item.typeKey
            const count = countFor(item)
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${
                  isActive
                    ? 'bg-accent-600/10 text-accent-300 ring-1 ring-accent-600/30'
                    : 'text-ink-300 hover:bg-ink-800/60 hover:text-ink-100'
                }`}
              >
                <Icon size={15} />
                <span className="flex-1">{item.label}</span>
                {count !== null && (
                  <span
                    className={`text-xs tabular-nums ${
                      isActive ? 'text-accent-300/80' : 'text-ink-500'
                    }`}
                  >
                    {count}
                  </span>
                )}
              </NavLink>
            )
          })}
        </nav>
      </aside>

      {/* Mobile: horizontal scroll tabs */}
      <nav className="md:hidden -mx-4 flex gap-1 overflow-x-auto border-b border-ink-800 px-4 pb-3">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon
          const isActive =
            item.typeKey === null ? activeType === null : activeType === item.typeKey
          const count = countFor(item)
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={`inline-flex flex-shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs transition ${
                isActive
                  ? 'bg-accent-600/10 text-accent-300 ring-1 ring-accent-600/30'
                  : 'bg-ink-800/60 text-ink-300 hover:text-ink-100'
              }`}
            >
              <Icon size={12} />
              {item.label}
              {count !== null && count > 0 && (
                <span className="text-ink-500">· {count}</span>
              )}
            </NavLink>
          )
        })}
      </nav>
    </>
  )
}
