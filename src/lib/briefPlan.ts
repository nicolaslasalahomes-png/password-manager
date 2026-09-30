/**
 * VAULT-1: what goes into the daily brief, and in what order. Pure, so it is tested.
 *
 * Nicolas, 30 Sep 2026: "Make sure my to do list in the keyring app is not ignored here".
 * So his own Keyring tasks and the Needs-you items are ONE list ordered by urgency, whichever
 * source they come from:
 *   0. overdue (either source)          1. due today (either source)
 *   2. Needs-you "Do ASAP"              3. Needs-you "Instant decision"
 *   4. his own high-priority tasks      5. his other upcoming tasks
 * "Think about" and "Later" go in as one count line. Every line carries its source tag
 * ("Task" or the N-ID). Every overdue or due-today item, and every Do ASAP and Instant item,
 * MUST appear in the brief: ensureMustShow() appends any the model left out, word for word.
 */
import type { Priority } from './items'
import { SECTION_LABEL, dueDayStart, type NeedsYouSnapshot } from './inbox/needsYou'

export interface OwnTask {
  title: string
  due_at: string | null
  priority: Priority | null
}

export interface PlanLine {
  source: 'task' | 'needs'
  tier: number
  must: boolean
  /** The line given to the model, tag first. */
  text: string
  /** What is appended if the model leaves a MUST line out. */
  fallback: string
  /** How to tell the model kept it: the N-ID, or the task title (lower case). */
  match: string
}

export interface BriefPlan {
  lines: PlanLine[]
  must: PlanLine[]
  countsLine: string | null
  wordLimit: number
  maxTokens: number
}

const BASE_WORDS = 160
const WORDS_PER_EXTRA_MUST = 15
const MAX_WORDS = 320

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

export function buildBriefPlan(args: {
  tasks: OwnTask[]
  needs: NeedsYouSnapshot | null
  now: Date
  /** Formats a due time WITH its weekday, so the model never computes one (the existing rule). */
  fmtDue: (d: Date) => string
  fmtDay: (d: Date) => string
}): BriefPlan {
  const { tasks, needs, now, fmtDue, fmtDay } = args
  const today = startOfDay(now).getTime()
  const tomorrow = today + 86_400_000
  const rows: Array<PlanLine & { sortAt: number; order: number }> = []

  tasks.forEach((t, i) => {
    const due = t.due_at ? new Date(t.due_at) : null
    const dueMs = due ? due.getTime() : Number.POSITIVE_INFINITY
    const overdue = !!due && dueMs < now.getTime()
    const dueToday = !!due && !overdue && dueMs < tomorrow
    const tier = overdue ? 0 : dueToday ? 1 : t.priority === 'high' ? 4 : 5
    const when = due ? `due ${fmtDue(due)}${overdue ? ' (OVERDUE)' : ''}` : 'no due date'
    rows.push({
      source: 'task',
      tier,
      must: tier <= 1,
      text: `[Task] ${t.title} [priority: ${t.priority ?? 'n/a'}, ${when}]`,
      fallback: `Task: ${t.title}, ${when}`,
      match: t.title.trim().toLowerCase().slice(0, 40),
      sortAt: dueMs,
      order: i,
    })
  })

  let think = 0
  let later = 0
  needs?.items.forEach((n, i) => {
    const day = n.due ? dueDayStart(n.due).getTime() : null
    const overdue = day !== null && day < today
    const dueToday = day === today
    let tier: number
    if (overdue) tier = 0
    else if (dueToday) tier = 1
    else if (n.section === 'asap') tier = 2
    else if (n.section === 'instant') tier = 3
    else {
      if (n.section === 'think') think++
      else later++
      return
    }
    const when = n.due ? ` [due ${fmtDay(dueDayStart(n.due))}${overdue ? ' (OVERDUE)' : ''}]` : ''
    const what = `${n.title}${n.action ? `: ${n.action}` : ''}`
    rows.push({
      source: 'needs',
      tier,
      must: true,
      text: `[${n.id} · ${SECTION_LABEL[n.section]}] ${what}${when}${n.link ? ` (${n.link})` : ''}`,
      fallback: `${n.id} (${SECTION_LABEL[n.section]}): ${what}${when}`,
      match: n.id,
      sortAt: day ?? Number.POSITIVE_INFINITY,
      order: 1000 + i,
    })
  })

  rows.sort((a, b) => a.tier - b.tier || a.sortAt - b.sortAt || a.order - b.order)
  const lines: PlanLine[] = rows.map(({ sortAt: _s, order: _o, ...l }) => l)
  const must = lines.filter((l) => l.must)
  const countsLine =
    needs && think + later > 0
      ? `Also waiting on you: ${think} to think about, ${later} for later (Needs-you List ${needs.list_no}).`
      : null
  const extra = Math.max(0, must.length - 4)
  return {
    lines,
    must,
    countsLine,
    wordLimit: Math.min(MAX_WORDS, BASE_WORDS + WORDS_PER_EXTRA_MUST * extra),
    maxTokens: Math.min(900, 400 + 25 * extra),
  }
}

/** True when the brief mentions this line: the N-ID as a word, or the task title. */
export function mentions(content: string, line: PlanLine): boolean {
  if (line.source === 'needs') return new RegExp(`\\b${line.match}\\b`).test(content)
  return content.toLowerCase().includes(line.match)
}

/** Append, word for word, every MUST line the model left out, and the count line if missing. */
export function ensureMustShow(content: string, plan: BriefPlan): string {
  let out = content.trimEnd()
  const missing = plan.must.filter((l) => !mentions(out, l))
  if (missing.length) out += `\n\nAlso on for today:\n${missing.map((l) => `• ${l.fallback}`).join('\n')}`
  if (plan.countsLine && !out.includes('to think about')) out += `\n\n${plan.countsLine}`
  return out
}
