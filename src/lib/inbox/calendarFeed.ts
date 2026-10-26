/**
 * KEY-CAL-1: Claude's calendar feed. Events Claude collected for Nicolas (Google Calendar,
 * dates found in emails, WhatsApps he forwarded, deadlines from the Needs-you list), sealed
 * into the inbox under source 'calendar' and drawn on the Calendar page next to his own tasks.
 *
 * One snapshot of the whole feed per push, replacing the last one, so an event Claude drops
 * simply is not in the next snapshot. Nothing here is written into vault_items: the feed is
 * read-only and lives only in the sealed envelope.
 *
 * Everything here is treated as DATA: text is length-capped, links must be https.
 */

export type CalendarOrigin = 'google' | 'email' | 'whatsapp' | 'needs_you' | 'claude'

export interface CalendarFeedEvent {
  /** Stable per event, so a re-push of the same event keeps its identity. */
  id: string
  title: string
  /** 'YYYY-MM-DD' for all-day events, otherwise a full ISO time with an offset. */
  start: string
  end?: string
  all_day: boolean
  where?: string
  note?: string
  link?: string
  origin: CalendarOrigin
}

export interface CalendarFeed {
  v: 1
  source: 'calendar'
  list_no: number
  created_at: string
  events: CalendarFeedEvent[]
}

export const CALENDAR_SOURCE = 'calendar'
export const MAX_EVENTS = 500
export const ORIGIN_LABEL: Record<CalendarOrigin, string> = {
  google: 'Google Calendar',
  email: 'From an email',
  whatsapp: 'From WhatsApp',
  needs_you: 'Needs you',
  claude: 'Added by Claude',
}
const ORIGINS = new Set<CalendarOrigin>(['google', 'email', 'whatsapp', 'needs_you', 'claude'])
const DAY = /^\d{4}-\d{2}-\d{2}$/

const cap = (v: unknown, n: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined

/** A start/end value: a plain day for all-day events, otherwise a parseable ISO time. */
function when(v: unknown, allDay: boolean): string | undefined {
  const s = cap(v, 40)
  if (!s) return undefined
  if (allDay) return DAY.test(s) ? s : undefined
  return !DAY.test(s) && !Number.isNaN(Date.parse(s)) ? s : undefined
}

/** Validate what came out of the envelope; drop anything malformed rather than trusting it. */
export function toCalendarFeed(json: unknown, header: { created_at: string; list_no: number }): CalendarFeed {
  const j = json as Partial<CalendarFeed> | null
  if (!j || j.v !== 1 || j.source !== CALENDAR_SOURCE || !Array.isArray(j.events)) {
    throw new Error('Not a calendar feed')
  }
  if (j.created_at !== header.created_at || j.list_no !== header.list_no) {
    throw new Error('The feed inside does not match its envelope')
  }
  const events: CalendarFeedEvent[] = []
  const seen = new Set<string>()
  for (const raw of j.events.slice(0, MAX_EVENTS)) {
    const r = raw as Partial<CalendarFeedEvent>
    const id = cap(r?.id, 64)
    const title = cap(r?.title, 200)
    const allDay = r?.all_day === true
    const start = when(r?.start, allDay)
    if (!id || !/^[A-Za-z0-9_.:-]+$/.test(id) || seen.has(id) || !title || !start) continue
    if (!ORIGINS.has(r.origin as CalendarOrigin)) continue
    seen.add(id)
    const link = cap(r.link, 500)
    events.push({
      id,
      title,
      start,
      end: when(r.end, allDay),
      all_day: allDay,
      where: cap(r.where, 200),
      note: cap(r.note, 1000),
      link: link && /^https:\/\/[^\s]+$/.test(link) ? link : undefined,
      origin: r.origin as CalendarOrigin,
    })
  }
  return { v: 1, source: CALENDAR_SOURCE, list_no: j.list_no, created_at: j.created_at, events }
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * The local days an event covers, for the month grid. An all-day event's end is exclusive
 * (Google's convention: a one-day event on the 21st ends on the 22nd). Capped at 31 days.
 */
export function eventDays(e: CalendarFeedEvent): string[] {
  if (e.all_day) {
    const days: string[] = []
    const d = new Date(e.start + 'T00:00:00')
    const end = e.end ? new Date(e.end + 'T00:00:00') : null
    do {
      days.push(localDay(d))
      d.setDate(d.getDate() + 1)
    } while (end && d < end && days.length < 31)
    return days
  }
  return [localDay(new Date(e.start))]
}

/** "09:30" for a timed event, '' for an all-day one. */
export function eventTime(e: CalendarFeedEvent): string {
  if (e.all_day) return ''
  return new Date(e.start).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}
