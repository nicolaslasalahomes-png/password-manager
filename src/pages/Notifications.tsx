import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlarmClock, Bell, CheckCheck, Info, Trash2, TriangleAlert } from 'lucide-react'
import Layout from '../components/Layout'
import { useToast } from '../state/ToastContext'
import {
  type FeedEntry,
  type NotificationKind,
  clearNotifications,
  listNotifications,
  markAllNotificationsRead,
} from '../lib/notifications'

export default function Notifications() {
  const toast = useToast()
  const navigate = useNavigate()
  const [items, setItems] = useState<FeedEntry[] | null>(null)

  const reload = useCallback(async () => {
    setItems(await listNotifications())
  }, [])

  useEffect(() => {
    void reload()
    // Mark everything read once the user is looking at the feed (clears the
    // sidebar badge). Slight delay so the unread styling is visible first.
    const t = window.setTimeout(() => void markAllNotificationsRead(), 1200)
    const onChange = () => void reload()
    window.addEventListener('keyring:notifications-changed', onChange)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener('keyring:notifications-changed', onChange)
    }
  }, [reload])

  async function onClear() {
    if (!confirm('Clear all notifications? This only clears the in-app history.')) return
    await clearNotifications()
    await reload()
    toast.success('Notifications cleared')
  }

  // Group by calendar day for readable ordering.
  const groups: { label: string; entries: FeedEntry[] }[] = []
  if (items) {
    const byDay = new Map<string, FeedEntry[]>()
    for (const e of items) {
      const key = new Date(e.at).toDateString()
      const arr = byDay.get(key) ?? []
      arr.push(e)
      byDay.set(key, arr)
    }
    for (const [key, entries] of byDay) groups.push({ label: dayLabel(key), entries })
  }

  return (
    <Layout
      rightSlot={
        items && items.length > 0 ? (
          <>
            <button
              onClick={() => void markAllNotificationsRead()}
              className="btn-ghost !px-2 !py-1.5"
              title="Mark all read"
            >
              <CheckCheck size={16} />
            </button>
            <button
              onClick={onClear}
              className="btn-ghost !px-2 !py-1.5 !text-red-400 hover:!bg-red-950/40"
              title="Clear all"
            >
              <Trash2 size={16} />
            </button>
          </>
        ) : null
      }
    >
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-ink-50">Notifications</h1>
        <p className="mt-1 text-sm text-ink-300">
          Every reminder and alert, newest first. Cleared automatically after 500 entries.
        </p>
      </div>

      {items === null ? (
        <p className="py-12 text-center text-sm text-ink-300">Loading…</p>
      ) : items.length === 0 ? (
        <div className="card mx-auto max-w-md p-8 text-center">
          <Bell className="mx-auto mb-3 text-accent-400" size={28} />
          <p className="text-sm text-ink-200">No notifications yet</p>
          <p className="mt-1 text-xs text-ink-400">
            Task reminders and missed-deadline alerts will collect here as they fire.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <div key={g.label}>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-500">
                {g.label}
              </h2>
              <div className="card divide-y divide-ink-800 p-0">
                {g.entries.map((e) => (
                  <button
                    key={e.id}
                    onClick={() => e.itemId && navigate(`/vault/${e.itemId}`)}
                    disabled={!e.itemId}
                    className={`flex w-full items-start gap-3 px-4 py-3 text-left transition ${
                      e.itemId ? 'hover:bg-ink-900/40' : 'cursor-default'
                    } ${!e.read ? 'bg-ink-900/30' : ''}`}
                  >
                    <div className="mt-0.5 flex-shrink-0">
                      <KindIcon kind={e.kind} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-ink-100">{e.title}</span>
                        {!e.read && (
                          <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent-500" />
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-ink-300">{e.body}</p>
                    </div>
                    <span className="flex-shrink-0 text-[11px] tabular-nums text-ink-500">
                      {new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Layout>
  )
}

function KindIcon({ kind }: { kind: NotificationKind }) {
  if (kind === 'missed')
    return (
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-red-950/40 text-red-300">
        <TriangleAlert size={13} />
      </span>
    )
  if (kind === 'reminder')
    return (
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-amber-950/40 text-amber-300">
        <AlarmClock size={13} />
      </span>
    )
  return (
    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-ink-800 text-ink-300">
      <Info size={13} />
    </span>
  )
}

function dayLabel(dateString: string): string {
  const d = new Date(dateString)
  const today = new Date().toDateString()
  const yesterday = new Date(Date.now() - 86_400_000).toDateString()
  if (dateString === today) return 'Today'
  if (dateString === yesterday) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}
