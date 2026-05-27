import { useEffect, useState } from 'react'
import { NavLink, useLocation, useSearchParams } from 'react-router-dom'
import { FileText, Key, LayoutGrid, Lock, Settings as SettingsIcon, Sparkles } from 'lucide-react'
import { listItems } from '../lib/items'

type Counts = Record<string, number> & { _all: number }

interface NavItem {
  label: string
  to: string
  icon: typeof Lock
  /** Matches against the `type` URL query param. `null` = the "all" view (no type filter). undefined = non-vault page. */
  typeKey: string | null | undefined
  /** Item types that count toward this section. Empty = all (for "All items"). null = no count. */
  countTypes: string[] | null
  /** True if this nav entry should ignore the vault-list active-type logic (e.g. Settings). */
  matchesPathOnly?: string
}

const NAV_ITEMS: NavItem[] = [
  { label: 'All items', to: '/vault', icon: LayoutGrid, typeKey: null, countTypes: [] },
  { label: 'Passwords', to: '/vault?type=login', icon: Lock, typeKey: 'login', countTypes: ['login'] },
  { label: 'API keys', to: '/vault?type=api_key', icon: Key, typeKey: 'api_key', countTypes: ['api_key'] },
  { label: 'Notes', to: '/vault?type=note', icon: FileText, typeKey: 'note', countTypes: ['note'] },
  { label: 'Other', to: '/vault?type=other', icon: Sparkles, typeKey: 'other', countTypes: ['other'] },
  { label: 'Settings', to: '/vault/settings', icon: SettingsIcon, typeKey: undefined, countTypes: null, matchesPathOnly: '/vault/settings' },
]

export default function Sidebar() {
  const [counts, setCounts] = useState<Counts | null>(null)
  const [searchParams] = useSearchParams()
  const loc = useLocation()
  const activeType = searchParams.get('type')

  function isActive(item: NavItem): boolean {
    if (item.matchesPathOnly) return loc.pathname === item.matchesPathOnly
    if (loc.pathname !== '/vault') return false // type-based items only highlight on /vault
    return item.typeKey === null ? activeType === null : activeType === item.typeKey
  }

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
    if (item.countTypes === null) return null
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
            const active = isActive(item)
            const count = countFor(item)
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${
                  active
                    ? 'bg-accent-600/10 text-accent-300 ring-1 ring-accent-600/30'
                    : 'text-ink-300 hover:bg-ink-800/60 hover:text-ink-100'
                }`}
              >
                <Icon size={15} />
                <span className="flex-1">{item.label}</span>
                {count !== null && (
                  <span
                    className={`text-xs tabular-nums ${
                      active ? 'text-accent-300/80' : 'text-ink-500'
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
          const active = isActive(item)
          const count = countFor(item)
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={`inline-flex flex-shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs transition ${
                active
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
