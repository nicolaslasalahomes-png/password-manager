/**
 * KEY-TODO-1: Claude's to-dos from message aggregation (emails, WhatsApps, calendar, logs) become real
 * Keyring tasks, with deadlines, in the To-Do list and on the Calendar.
 *
 * Claude seals the whole list (source 'todos') through the signed inbox, like the Needs-you list. Claude
 * cannot write vault items itself (titles are fine, but notes are encrypted under his vault key), so the
 * app does it here after unlock:
 *   - a to-do never seen before becomes a task in folder "Claude", tagged `claude:<id>`;
 *   - a to-do Claude marks done is ticked off;
 *   - a to-do Claude changes is updated, unless Nicolas edited that task himself since;
 *   - nothing is ever deleted, and a to-do that drops out of the list is left alone.
 *
 * Everything here is treated as DATA: text is length-capped, links must be https.
 */
import type { Priority, VaultItemRow } from '../items'

export type TodoOrigin = 'email' | 'whatsapp' | 'calendar' | 'logs' | 'claude'

export interface ClaudeTodo {
  /** Stable, e.g. "e-justin-openai-spend". */
  id: string
  title: string
  /** 'YYYY-MM-DD' (due 09:00 local that day) or a full ISO time. */
  due: string
  priority: Priority
  note?: string
  link?: string
  origin: TodoOrigin
  /** Claude learned it is done or no longer needed: tick it off. */
  done?: boolean
}

export interface TodoFeed {
  v: 1
  source: 'todos'
  list_no: number
  created_at: string
  todos: ClaudeTodo[]
}

export const TODOS_SOURCE = 'todos'
export const TODO_FOLDER = 'Claude'
export const TAG_PREFIX = 'claude:'
const ORIGINS = new Set<TodoOrigin>(['email', 'whatsapp', 'calendar', 'logs', 'claude'])
const PRIORITIES = new Set<Priority>(['low', 'medium', 'high'])
const DAY = /^\d{4}-\d{2}-\d{2}$/

const cap = (v: unknown, n: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined

export function toTodoFeed(json: unknown, header: { created_at: string; list_no: number }): TodoFeed {
  const j = json as Partial<TodoFeed> | null
  if (!j || j.v !== 1 || j.source !== TODOS_SOURCE || !Array.isArray(j.todos)) throw new Error('Not a to-do list')
  if (j.created_at !== header.created_at || j.list_no !== header.list_no) {
    throw new Error('The list inside does not match its envelope')
  }
  const todos: ClaudeTodo[] = []
  const seen = new Set<string>()
  for (const raw of j.todos.slice(0, 300)) {
    const r = raw as Partial<ClaudeTodo>
    const id = cap(r?.id, 64)
    const title = cap(r?.title, 200)
    const due = cap(r?.due, 40)
    if (!id || !/^[A-Za-z0-9_.:-]+$/.test(id) || seen.has(id) || !title || !due) continue
    if (!DAY.test(due) && Number.isNaN(Date.parse(due))) continue
    if (!ORIGINS.has(r.origin as TodoOrigin)) continue
    seen.add(id)
    const link = cap(r.link, 500)
    todos.push({
      id,
      title,
      due,
      priority: PRIORITIES.has(r.priority as Priority) ? (r.priority as Priority) : 'medium',
      note: cap(r.note, 2000),
      link: link && /^https:\/\/[^\s]+$/.test(link) ? link : undefined,
      origin: r.origin as TodoOrigin,
      done: r.done === true,
    })
  }
  return { v: 1, source: TODOS_SOURCE, list_no: j.list_no, created_at: j.created_at, todos }
}

/** A date-only deadline means 09:00 local time that day. */
export function dueAt(due: string): string {
  return (DAY.test(due) ? new Date(`${due}T09:00:00`) : new Date(due)).toISOString()
}

const ORIGIN_LINE: Record<TodoOrigin, string> = {
  email: 'From an email',
  whatsapp: 'From WhatsApp',
  calendar: 'From the calendar',
  logs: 'From program logs',
  claude: 'Added by Claude',
}

/** The task's (encrypted) note: what it is, where it came from, the link. */
export function todoBody(t: ClaudeTodo): string {
  return [t.note, t.link, `${ORIGIN_LINE[t.origin]} (message aggregation)`].filter(Boolean).join('\n\n')
}

/** What Claude last wrote for a to-do; a change means the task needs updating. */
export function revision(t: ClaudeTodo): string {
  return JSON.stringify([t.title, t.due, t.priority, t.note ?? '', t.link ?? ''])
}

/**
 * Per to-do: the revision Claude applied, and a fingerprint of the task as Claude left it (title, due,
 * priority, note). A different fingerprint now means Nicolas edited the task, so Claude leaves it be.
 * (updated_at cannot tell: a trigger bumps it on every write, even just opening the task.)
 */
export type Applied = Record<string, { rev: string; sig: string }>

/** Fingerprint of a task's editable content; no content is stored, only this hash. */
export async function taskSig(title: string, due_at: string | null, priority: string | null, body: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([title, due_at ? Date.parse(due_at) : null, priority, body]))
  const d = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
}

export interface TodoPlan {
  create: ClaudeTodo[]
  update: { row: VaultItemRow; todo: ClaudeTodo }[]
  complete: { row: VaultItemRow; todo: ClaudeTodo }[]
}

export function claudeIdOf(row: VaultItemRow): string | null {
  const tag = (row.tags ?? []).find((t) => t.startsWith(TAG_PREFIX))
  return tag ? tag.slice(TAG_PREFIX.length) : null
}

/** Decide what to do, without touching anything (pure, for the tests). */
export function planTodoSync(
  feed: TodoFeed,
  rows: VaultItemRow[],
  applied: Applied,
  currentSig: Record<string, string>,
): TodoPlan {
  const byId = new Map<string, VaultItemRow>()
  for (const r of rows) {
    const id = claudeIdOf(r)
    if (id && !byId.has(id)) byId.set(id, r)
  }
  const plan: TodoPlan = { create: [], update: [], complete: [] }
  for (const t of feed.todos) {
    const row = byId.get(t.id)
    if (!row) {
      if (!t.done) plan.create.push(t)
      continue
    }
    if (row.completed_at) continue // done is done, whoever ticked it
    if (t.done) {
      plan.complete.push({ row, todo: t })
      continue
    }
    const a = applied[t.id]
    const editedByHim = !a || currentSig[row.id] !== a.sig
    if (a?.rev !== revision(t) && !editedByHim) plan.update.push({ row, todo: t })
  }
  return plan
}
