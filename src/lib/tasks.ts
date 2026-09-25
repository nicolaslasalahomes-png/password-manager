/**
 * Task layer on top of vault_items.
 *
 * A "task" is a vault_item with type='note' AND due_at IS NOT NULL. Same
 * row, same encryption (title + body still ciphertext under DEK); the
 * plaintext columns we lean on are due_at, priority, completed_at — used
 * for the to-do list query, calendar grid, and notification scheduler.
 *
 * Plaintext rationale: dates and priority levels are low-sensitivity
 * metadata (server sees you have N items due Y, not what they are). Keeps
 * the to-do query a single SQL filter rather than client-side decrypt-all.
 */

import { supabase } from './supabase'
import type { Priority, VaultItemRow } from './items'
import { getStoreValue, setStoreValue } from './desktop'

/** Items with a due date that aren't completed yet. */
export async function listOpenTasks(): Promise<VaultItemRow[]> {
  const { data, error } = await supabase
    .from('vault_items')
    .select('*')
    .not('due_at', 'is', null)
    .is('completed_at', null)
    .order('due_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as VaultItemRow[]
}

/** All items with a due date (open + completed). For calendar view. */
export async function listAllTasks(): Promise<VaultItemRow[]> {
  const { data, error } = await supabase
    .from('vault_items')
    .select('*')
    .not('due_at', 'is', null)
    .order('due_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as VaultItemRow[]
}

export async function markTaskComplete(id: string): Promise<void> {
  const { error } = await supabase
    .from('vault_items')
    .update({ completed_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

export async function markTaskIncomplete(id: string): Promise<void> {
  const { error } = await supabase
    .from('vault_items')
    .update({ completed_at: null })
    .eq('id', id)
  if (error) throw error
}

// ── Calendar day marks ──────────────────────────────────────────────────────

export interface DayMarkRow {
  id: string
  user_id: string
  day: string // ISO date 'YYYY-MM-DD'
  color: string
  label: string | null
  created_at: string
}

export async function listDayMarks(): Promise<DayMarkRow[]> {
  const { data, error } = await supabase
    .from('calendar_day_marks')
    .select('*')
    .order('day', { ascending: true })
  if (error) throw error
  return (data ?? []) as DayMarkRow[]
}

export async function upsertDayMark(
  userId: string,
  day: string,
  color: string,
  label: string | null,
): Promise<DayMarkRow> {
  const { data, error } = await supabase
    .from('calendar_day_marks')
    .upsert({ user_id: userId, day, color, label }, { onConflict: 'user_id,day' })
    .select('*')
    .single()
  if (error) throw error
  return data as DayMarkRow
}

export async function deleteDayMark(id: string): Promise<void> {
  const { error } = await supabase.from('calendar_day_marks').delete().eq('id', id)
  if (error) throw error
}

// ── Work hours config (local Tauri store; per-device) ───────────────────────

export interface WorkHours {
  /** 'HH:MM' 24h. e.g. '09:00'. */
  start: string
  /** 'HH:MM' 24h. e.g. '18:00'. */
  end: string
  /** Days of week as 0-6 (Sun=0). Default Mon-Fri = [1,2,3,4,5]. */
  days: number[]
}

const WORK_HOURS_KEY = 'workHours'
const DEFAULT_WORK_HOURS: WorkHours = { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] }

export async function getWorkHours(): Promise<WorkHours> {
  const stored = await getStoreValue<WorkHours>(WORK_HOURS_KEY)
  return stored ?? DEFAULT_WORK_HOURS
}

export async function setWorkHours(wh: WorkHours): Promise<void> {
  await setStoreValue(WORK_HOURS_KEY, wh)
}

// ── Notification computation ────────────────────────────────────────────────

/**
 * Compute the scheduled notification times for a task on a given calendar day,
 * given the work-hour window.
 *
 * Priority rules:
 *   high   → 4 pings, evenly spaced through work hours with mild jitter
 *            (≥2h apart enforced when work window allows; otherwise even spacing)
 *   medium → 2 pings: mid-day and ~1h before work_end
 *   low    → 1 ping at mid-day
 *
 * Output: array of Date objects on `day`. Caller filters past times.
 * Deterministic per (taskId, day) — uses a tiny seedable PRNG so re-running
 * the scheduler within a day yields the same times. Prevents notification
 * drift if the app restarts mid-day.
 */
export function computeNotificationTimes(
  taskId: string,
  day: Date,
  priority: Priority,
  wh: WorkHours,
): Date[] {
  // If today isn't a configured work day, no notifications.
  if (!wh.days.includes(day.getDay())) return []

  const [sh, sm] = wh.start.split(':').map(Number)
  const [eh, em] = wh.end.split(':').map(Number)
  const startMin = sh * 60 + sm
  const endMin = eh * 60 + em
  if (endMin <= startMin) return [] // misconfigured

  const span = endMin - startMin
  const seed = hashStr(`${taskId}-${day.toDateString()}`)
  const rng = mulberry32(seed)

  function at(minOfDay: number): Date {
    const d = new Date(day)
    d.setHours(Math.floor(minOfDay / 60), minOfDay % 60, 0, 0)
    return d
  }

  if (priority === 'low') {
    return [at(startMin + Math.floor(span / 2))]
  }
  if (priority === 'medium') {
    const midDay = startMin + Math.floor(span / 2)
    const endish = endMin - 60 // 1h before end of day
    return [at(midDay), at(Math.max(midDay + 60, endish))]
  }
  // high: 4 evenly-spaced with jitter, enforce ≥120 min gaps where possible
  const slots = 4
  const segment = span / slots
  const minGap = Math.min(120, segment) // can't enforce 120 if span < 480
  const jitterRange = Math.min(30, Math.floor(segment / 4))
  const times: number[] = []
  for (let i = 0; i < slots; i++) {
    const center = startMin + Math.floor(segment * (i + 0.5))
    const jitter = Math.floor((rng() - 0.5) * 2 * jitterRange)
    let t = center + jitter
    if (times.length > 0 && t - times[times.length - 1] < minGap) {
      t = times[times.length - 1] + minGap
    }
    // Clamp into work window
    t = Math.max(startMin, Math.min(endMin - 1, t))
    times.push(t)
  }
  return times.map(at)
}

// Tiny seedable PRNG + string hash for deterministic notification times.
function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}
function mulberry32(seed: number) {
  let a = seed
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
