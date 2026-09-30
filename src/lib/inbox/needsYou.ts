/**
 * VAULT-1: Nicolas's Needs-you list, as Claude's needs-you-list skill records it.
 *
 * One snapshot of the whole current list per push, replacing the last one: an ID he has
 * answered simply is not in the next snapshot, so nothing is retired item by item. IDs
 * (N1, N2, ...) are permanent and shown as written, so he can answer "N20 done" in chat.
 *
 * Everything here is treated as DATA: text is length-capped, links must be https, and the
 * brief's prompt says so too.
 */

export type NeedsYouSection = 'asap' | 'instant' | 'think' | 'later'

export interface NeedsYouItem {
  id: string
  section: NeedsYouSection
  title: string
  action?: string
  link?: string
  /** 'YYYY-MM-DD' or a full ISO time, when the item has a date. */
  due?: string
}

export interface NeedsYouSnapshot {
  v: 1
  source: 'needs_you'
  list_no: number
  created_at: string
  items: NeedsYouItem[]
}

export const NEEDS_YOU_SOURCE = 'needs_you'
export const SECTION_LABEL: Record<NeedsYouSection, string> = {
  asap: 'Do ASAP',
  instant: 'Instant decision',
  think: 'Think about',
  later: 'Later',
}
/** An item's plain explanation: a few short lines (what is going on, the options, the recommendation). */
export const MAX_ACTION_CHARS = 1500
const SECTIONS = new Set<NeedsYouSection>(['asap', 'instant', 'think', 'later'])
/** Snapshots older than this are shown with their date, as possibly out of date. */
export const STALE_AFTER_MS = 36 * 60 * 60 * 1000

const cap = (v: unknown, n: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined

/** Validate what came out of the envelope; drop anything malformed rather than trusting it. */
export function toSnapshot(json: unknown, header: { created_at: string; list_no: number }): NeedsYouSnapshot {
  const j = json as Partial<NeedsYouSnapshot> | null
  if (!j || j.v !== 1 || j.source !== NEEDS_YOU_SOURCE || !Array.isArray(j.items)) {
    throw new Error('Not a Needs-you list')
  }
  if (j.created_at !== header.created_at || j.list_no !== header.list_no) {
    throw new Error('The list inside does not match its envelope')
  }
  const items: NeedsYouItem[] = []
  for (const raw of j.items.slice(0, 200)) {
    const r = raw as Partial<NeedsYouItem>
    const id = cap(r?.id, 12)
    const title = cap(r?.title, 300)
    if (!id || !/^N\d{1,4}[a-z]?$/.test(id) || !title || !SECTIONS.has(r.section as NeedsYouSection)) continue
    const link = cap(r.link, 500)
    const due = cap(r.due, 40)
    items.push({
      id,
      section: r.section as NeedsYouSection,
      title,
      action: cap(r.action, MAX_ACTION_CHARS),
      link: link && /^https:\/\/[^\s]+$/.test(link) ? link : undefined,
      due: due && !Number.isNaN(Date.parse(due)) ? due : undefined,
    })
  }
  return { v: 1, source: NEEDS_YOU_SOURCE, list_no: j.list_no, created_at: j.created_at, items }
}

/**
 * Rollback guard: a list older than one this device has already shown is refused, so an old
 * (validly signed) envelope put back into the table cannot hide newer items.
 */
export function isRollback(createdAt: string, lastSeen: string | null): boolean {
  return !!lastSeen && Date.parse(createdAt) < Date.parse(lastSeen)
}

export function isStale(createdAt: string, now: Date = new Date()): boolean {
  return now.getTime() - Date.parse(createdAt) > STALE_AFTER_MS
}

/** Local calendar day of a due value ('YYYY-MM-DD' is taken as that local day). */
export function dueDayStart(due: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    const [y, m, d] = due.split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  const t = new Date(due)
  return new Date(t.getFullYear(), t.getMonth(), t.getDate())
}
