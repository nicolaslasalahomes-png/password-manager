/**
 * Native macOS notification scheduler.
 *
 * Runs while Keyring is alive (main window visible OR menu-bar tray). Every
 * 60 seconds it:
 *   1. Pulls all open tasks (`due_at != null`, `completed_at == null`)
 *   2. For each task, computes its notification times for *today* given the
 *      task's priority and the user's work hours
 *   3. Fires native notifications via tauri-plugin-notification for any time
 *      that has passed in the last tick AND hasn't been notified yet
 *   4. Sends a single "missed" notification for tasks whose due_at has passed
 *      without being marked complete
 *
 * Dedup memory lives in tauri-plugin-store as `notificationLog` — keyed by
 * `taskId-isoTimestamp` so the same scheduled ping never fires twice.
 */

import { getStoreValue, isDesktop, setStoreValue } from './desktop'
import { computeNotificationTimes, getWorkHours, listOpenTasks } from './tasks'
import type { Priority } from './items'

const LOG_KEY = 'notificationLog'
const FEED_KEY = 'notificationFeed'
const TICK_MS = 60_000

// ── Notification feed (the in-app "all notifications" history) ───────────────
// Separate from the dedup LOG above: the LOG tracks which scheduled pings have
// fired (so they don't repeat); the FEED is the human-readable list the user
// browses. Stored locally (survives reinstalls — app data dir, not the .app
// bundle). Capped so it can't grow unbounded.

export type NotificationKind = 'reminder' | 'missed' | 'info'

export interface FeedEntry {
  id: string
  title: string
  body: string
  kind: NotificationKind
  at: string // ISO timestamp
  itemId?: string
  read: boolean
}

const FEED_CAP = 500

async function appendFeed(entry: {
  title: string
  body: string
  kind: NotificationKind
  itemId?: string
}): Promise<void> {
  const list = (await getStoreValue<FeedEntry[]>(FEED_KEY)) ?? []
  const e: FeedEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: entry.title,
    body: entry.body,
    kind: entry.kind,
    itemId: entry.itemId,
    at: new Date().toISOString(),
    read: false,
  }
  list.push(e)
  await setStoreValue(FEED_KEY, list.slice(-FEED_CAP))
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('keyring:notifications-changed'))
  }
}

/** Newest-first list for the Notifications page. */
export async function listNotifications(): Promise<FeedEntry[]> {
  const list = (await getStoreValue<FeedEntry[]>(FEED_KEY)) ?? []
  return [...list].reverse()
}

export async function getUnreadNotificationCount(): Promise<number> {
  const list = (await getStoreValue<FeedEntry[]>(FEED_KEY)) ?? []
  return list.reduce((n, e) => n + (e.read ? 0 : 1), 0)
}

export async function markAllNotificationsRead(): Promise<void> {
  const list = (await getStoreValue<FeedEntry[]>(FEED_KEY)) ?? []
  if (list.some((e) => !e.read)) {
    await setStoreValue(
      FEED_KEY,
      list.map((e) => ({ ...e, read: true })),
    )
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('keyring:notifications-changed'))
    }
  }
}

/** Push an info-kind entry into the feed (used by the daily briefing, etc.). */
export async function pushInfoNotification(title: string, body: string): Promise<void> {
  await appendFeed({ title, body, kind: 'info' })
}

export async function clearNotifications(): Promise<void> {
  await setStoreValue(FEED_KEY, [])
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('keyring:notifications-changed'))
  }
}

interface NotificationLog {
  /** Keys of fired notifications: `${itemId}|${slotIso}` (precise to the minute). */
  fired: string[]
  /** Keys of fired "missed" notifications: `${itemId}|missed`. */
  missedFired: string[]
}

async function getLog(): Promise<NotificationLog> {
  const stored = await getStoreValue<NotificationLog>(LOG_KEY)
  return stored ?? { fired: [], missedFired: [] }
}

async function setLog(log: NotificationLog): Promise<void> {
  // Cap to last 500 entries so the file doesn't grow unbounded.
  await setStoreValue(LOG_KEY, {
    fired: log.fired.slice(-500),
    missedFired: log.missedFired.slice(-500),
  })
}

async function ensureNotificationPermission(): Promise<boolean> {
  if (!isDesktop()) return false
  try {
    const { isPermissionGranted, requestPermission } = await import(
      '@tauri-apps/plugin-notification'
    )
    let granted = await isPermissionGranted()
    if (!granted) {
      const res = await requestPermission()
      granted = res === 'granted'
    }
    return granted
  } catch (err) {
    console.warn('[notif] permission check failed', err)
    return false
  }
}

async function fireNotification(
  title: string,
  body: string,
  kind: NotificationKind,
  itemId?: string,
): Promise<void> {
  // Always log to the in-app feed first, even if the native send fails — the
  // user's Notifications tab is the durable record.
  await appendFeed({ title, body, kind, itemId })
  if (!isDesktop()) return
  try {
    const { sendNotification } = await import('@tauri-apps/plugin-notification')
    sendNotification({ title, body })
  } catch (err) {
    console.warn('[notif] send failed', err)
  }
}

function formatRemaining(dueAt: string): string {
  const ms = new Date(dueAt).getTime() - Date.now()
  if (ms < 0) return 'overdue'
  const hours = Math.round(ms / (60 * 60 * 1000))
  if (hours < 24) return `due in ${hours}h`
  const days = Math.round(hours / 24)
  return `due in ${days}d`
}

export interface SchedulerHandle {
  stop: () => void
}

export function startNotificationScheduler(): SchedulerHandle {
  let stopped = false
  let timer: number | null = null
  let ticking = false

  // Track last tick time so we know which notifications "just became due"
  // on this tick (anything between lastTick and now). On first run we
  // process the past 5 minutes' window so we catch anything if the user
  // re-launched Keyring just after a scheduled ping.
  let lastTickAt: number = Date.now() - 5 * 60 * 1000

  async function tick(): Promise<void> {
    if (stopped || ticking) return
    ticking = true
    try {
      const granted = await ensureNotificationPermission()
      if (!granted) return

      const [tasks, wh, log] = await Promise.all([
        listOpenTasks(),
        getWorkHours(),
        getLog(),
      ])

      const now = Date.now()
      const firedSet = new Set(log.fired)
      const missedSet = new Set(log.missedFired)
      let logDirty = false

      for (const task of tasks) {
        if (!task.due_at || !task.priority) continue
        const priority = task.priority as Priority

        // Missed-deadline notification (one-shot per task)
        const dueMs = new Date(task.due_at).getTime()
        const missedKey = `${task.id}|missed`
        if (dueMs < now && !missedSet.has(missedKey)) {
          await fireNotification(
            'Task deadline passed',
            `"${task.title}" was due ${new Date(task.due_at).toLocaleString()} — mark it complete or extend the deadline.`,
            'missed',
            task.id,
          )
          missedSet.add(missedKey)
          logDirty = true
          continue // skip further pings for this task today; deadline already missed
        }

        // Scheduled pings for today
        const today = new Date(now)
        const times = computeNotificationTimes(task.id, today, priority, wh)
        for (const t of times) {
          const tMs = t.getTime()
          if (tMs <= lastTickAt) continue // already past on previous tick
          if (tMs > now) continue // future — wait for it
          const slotKey = `${task.id}|${t.toISOString().slice(0, 16)}`
          if (firedSet.has(slotKey)) continue

          await fireNotification(
            `Reminder · ${priority} priority`,
            `${task.title} — ${formatRemaining(task.due_at)}`,
            'reminder',
            task.id,
          )
          firedSet.add(slotKey)
          logDirty = true
        }
      }

      if (logDirty) {
        await setLog({ fired: Array.from(firedSet), missedFired: Array.from(missedSet) })
      }
      lastTickAt = now
    } catch (err) {
      console.warn('[notif] scheduler tick failed', err)
    } finally {
      ticking = false
    }
  }

  void tick()
  timer = window.setInterval(() => void tick(), TICK_MS)

  return {
    stop() {
      stopped = true
      if (timer !== null) {
        window.clearInterval(timer)
        timer = null
      }
    },
  }
}

// Convenience for Settings UI to test/initiate the OS permission prompt.
export async function requestNotificationPermissionOnce(): Promise<boolean> {
  return ensureNotificationPermission()
}
