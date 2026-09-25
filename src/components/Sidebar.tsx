import { useEffect, useState } from 'react'
import { NavLink, useLocation, useSearchParams } from 'react-router-dom'
import {
  Bell,
  CalendarDays,
  CheckSquare,
  FileText,
  Inbox as InboxIcon,
  Key,
  LayoutGrid,
  Lock,
  Mail,
  Settings as SettingsIcon,
  Sparkles,
} from 'lucide-react'
import { listItems } from '../lib/items'
import { countCachedSince, getLastInboxSeenAt } from '../lib/email'
import { getUnreadNotificationCount } from '../lib/notifications'
import { hasUnseenBriefing } from '../lib/briefing'

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
  { label: 'To-Do', to: '/vault/todo', icon: CheckSquare, typeKey: undefined, countTypes: null, matchesPathOnly: '/vault/todo' },
  { label: 'Calendar', to: '/vault/calendar', icon: CalendarDays, typeKey: undefined, countTypes: null, matchesPathOnly: '/vault/calendar' },
  { label: 'Notifications', to: '/vault/notifications', icon: Bell, typeKey: undefined, countTypes: null, matchesPathOnly: '/vault/notifications' },
  { label: 'Daily brief', to: '/vault/briefing', icon: Sparkles, typeKey: undefined, countTypes: null, matchesPathOnly: '/vault/briefing' },
  { label: 'Inbox', to: '/vault/inbox', icon: InboxIcon, typeKey: undefined, countTypes: null, matchesPathOnly: '/vault/inbox' },
  { label: 'All emails', to: '/vault/inbox/all', icon: Mail, typeKey: undefined, countTypes: null, matchesPathOnly: '/vault/inbox/all' },
  { label: 'Settings', to: '/vault/settings', icon: SettingsIcon, typeKey: undefined, countTypes: null, matchesPathOnly: '/vault/settings' },
]

export default function Sidebar() {
  const [counts, setCounts] = useState<Counts | null>(null)
  const [unreadEmails, setUnreadEmails] = useState<number>(0)
  const [unreadNotifs, setUnreadNotifs] = useState<number>(0)
  const [briefUnseen, setBriefUnseen] = useState<boolean>(false)
  const [searchParams] = useSearchParams()
  const loc = useLocation()
  const activeType = searchParams.get('type')

  function isActive(item: NavItem): boolean {
    if (item.matchesPathOnly) return loc.pathname === item.matchesPathOnly
    if (loc.pathname !== '/vault') return false
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

  // Unread email count = emails received since the user last visited the
  // Inbox tab. Computed with a HEAD count query (countCachedSince) — it returns
  // ONLY a number, never row bodies.
  //
  // History: this used to pull every cached row (with its ~28 KB encrypted
  // body) every 15s to count client-side. That re-downloaded the whole ~12 MB
  // cache four times a minute, 24/7, and blew Supabase's egress quota — which
  // restricted the entire project (v0.5.6). Now: a cheap count, on a 60s timer
  // that ONLY fires while the window is visible, plus the event-driven refresh.
  useEffect(() => {
    let cancelled = false
    async function refresh() {
      try {
        const lastSeen = await getLastInboxSeenAt()
        if (cancelled) return
        if (!lastSeen) {
          // First-ever load: don't show a badge until they've seen the inbox once.
          setUnreadEmails(0)
          return
        }
        const count = await countCachedSince(lastSeen)
        if (!cancelled) setUnreadEmails(count)
      } catch {
        // Vault locked / not signed in / no accounts — silently ignore.
        if (!cancelled) setUnreadEmails(0)
      }
    }
    void refresh()
    const id = window.setInterval(() => {
      // Don't poll while the app is hidden/backgrounded — no point spending
      // requests (or egress) when the badge isn't on screen.
      if (document.visibilityState === 'visible') void refresh()
    }, 60_000)
    const onChange = () => void refresh()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    window.addEventListener('keyring:inbox-changed', onChange)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      window.clearInterval(id)
      window.removeEventListener('keyring:inbox-changed', onChange)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  // Unread notification count — refreshed on mount, every 15s, and whenever a
  // notification fires or is marked read ('keyring:notifications-changed').
  useEffect(() => {
    let cancelled = false
    async function refresh() {
      try {
        const n = await getUnreadNotificationCount()
        if (!cancelled) setUnreadNotifs(n)
      } catch {
        if (!cancelled) setUnreadNotifs(0)
      }
    }
    void refresh()
    const id = window.setInterval(refresh, 15_000)
    const onChange = () => void refresh()
    window.addEventListener('keyring:notifications-changed', onChange)
    return () => {
      cancelled = true
      window.clearInterval(id)
      window.removeEventListener('keyring:notifications-changed', onChange)
    }
  }, [])

  // Unseen daily-brief dot — refreshed on mount, every 30s, and on the
  // 'keyring:briefing-changed' event (fired when a brief is generated or seen).
  useEffect(() => {
    let cancelled = false
    async function refresh() {
      try {
        const v = await hasUnseenBriefing()
        if (!cancelled) setBriefUnseen(v)
      } catch {
        if (!cancelled) setBriefUnseen(false)
      }
    }
    void refresh()
    const id = window.setInterval(refresh, 30_000)
    const onChange = () => void refresh()
    window.addEventListener('keyring:briefing-changed', onChange)
    return () => {
      cancelled = true
      window.clearInterval(id)
      window.removeEventListener('keyring:briefing-changed', onChange)
    }
  }, [])

  function countFor(item: NavItem): number | null {
    if (item.countTypes === null) return null
    if (!counts) return null
    if (item.countTypes.length === 0) return counts._all
    return item.countTypes.reduce((sum, t) => sum + (counts[t] ?? 0), 0)
  }

  function badgeFor(item: NavItem, active: boolean): React.ReactNode {
    if (item.matchesPathOnly === '/vault/inbox' && unreadEmails > 0 && !active) {
      return (
        <span className="rounded-full bg-accent-500 px-1.5 py-0.5 text-[10px] font-semibold text-white tabular-nums">
          {unreadEmails > 99 ? '99+' : unreadEmails}
        </span>
      )
    }
    if (item.matchesPathOnly === '/vault/notifications' && unreadNotifs > 0 && !active) {
      return (
        <span className="rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-semibold text-white tabular-nums">
          {unreadNotifs > 99 ? '99+' : unreadNotifs}
        </span>
      )
    }
    if (item.matchesPathOnly === '/vault/briefing' && briefUnseen && !active) {
      return <span className="h-2 w-2 rounded-full bg-accent-400" title="New brief" />
    }
    const count = countFor(item)
    if (count === null) return null
    return (
      <span className={`text-xs tabular-nums ${active ? 'text-accent-300/80' : 'text-ink-500'}`}>
        {count}
      </span>
    )
  }

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:block md:w-52 md:flex-shrink-0">
        <nav className="sticky top-20 space-y-0.5">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const active = isActive(item)
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
                {badgeFor(item, active)}
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
          const showInboxBadge = item.matchesPathOnly === '/vault/inbox' && unreadEmails > 0 && !active
          const showNotifBadge =
            item.matchesPathOnly === '/vault/notifications' && unreadNotifs > 0 && !active
          const showBriefDot =
            item.matchesPathOnly === '/vault/briefing' && briefUnseen && !active
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
              {showInboxBadge ? (
                <span className="ml-0.5 rounded-full bg-accent-500 px-1 py-0.5 text-[9px] font-semibold text-white">
                  {unreadEmails > 99 ? '99+' : unreadEmails}
                </span>
              ) : showNotifBadge ? (
                <span className="ml-0.5 rounded-full bg-red-500 px-1 py-0.5 text-[9px] font-semibold text-white">
                  {unreadNotifs > 99 ? '99+' : unreadNotifs}
                </span>
              ) : showBriefDot ? (
                <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-accent-400" />
              ) : count !== null && count > 0 ? (
                <span className="text-ink-500">· {count}</span>
              ) : null}
            </NavLink>
          )
        })}
      </nav>
    </>
  )
}
