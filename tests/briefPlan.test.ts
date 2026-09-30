/**
 * VAULT-1, Nicolas: "Make sure my to do list in the keyring app is not ignored here".
 * A day with 5 of his own tasks and 10 Needs-you items still shows every overdue and due-today
 * task of his, ordered by urgency across both sources, each tagged with its source.
 */
import { describe, it, expect } from 'vitest'
import { buildBriefPlan, ensureMustShow, type OwnTask } from '../src/lib/briefPlan'
import type { NeedsYouSnapshot } from '../src/lib/inbox/needsYou'

const now = new Date(2026, 8, 30, 9, 0) // Wed 30 Sep 2026, 09:00 local
const at = (d: number, h: number) => new Date(2026, 8, d, h, 0).toISOString()
const fmtDue = (d: Date) => d.toLocaleString('en-GB', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const fmtDay = (d: Date) => d.toLocaleDateString('en-GB', { weekday: 'long', month: 'short', day: 'numeric' })

const tasks: OwnTask[] = [
  { title: 'Pay the car insurance', due_at: at(28, 12), priority: 'high' }, // overdue
  { title: 'Call the notary', due_at: at(29, 17), priority: 'low' }, // overdue
  { title: 'Send the Gibraltar form', due_at: at(30, 16), priority: 'medium' }, // today
  { title: 'Book the dentist', due_at: at(3, 10).replace('-09-', '-10-'), priority: 'high' }, // later, high
  { title: 'Renew the domain', due_at: new Date(2026, 9, 12, 10).toISOString(), priority: 'low' }, // later
]

const needs: NeedsYouSnapshot = {
  v: 1,
  source: 'needs_you',
  list_no: 7,
  created_at: '2026-09-30T06:00:00Z',
  items: [
    { id: 'N20', section: 'asap', title: 'Natalia: press Enable' },
    { id: 'N31', section: 'asap', title: 'Sign the lease', due: '2026-09-29' }, // overdue
    { id: 'N32', section: 'asap', title: 'Reply to the bank' },
    { id: 'N23', section: 'instant', title: 'Exclude interns from Sal sweeps?' },
    { id: 'N33', section: 'instant', title: 'Pick the tile', due: '2026-09-30' }, // today
    { id: 'N34', section: 'instant', title: 'Approve the deck' },
    { id: 'N9', section: 'think', title: 'Real logins' },
    { id: 'N5', section: 'think', title: 'Missing listings' },
    { id: 'N12', section: 'think', title: 'Brokers own clients only' },
    { id: 'N21', section: 'later', title: 'Own check server' },
  ],
}

describe('buildBriefPlan', () => {
  const plan = buildBriefPlan({ tasks, needs, now, fmtDue, fmtDay })

  it('keeps every overdue and due-today task of his own, as MUST lines', () => {
    const own = plan.must.filter((l) => l.source === 'task').map((l) => l.match)
    expect(own).toEqual(['pay the car insurance', 'call the notary', 'send the gibraltar form'])
    // and his other tasks are still in the list, not dropped
    expect(plan.lines.filter((l) => l.source === 'task')).toHaveLength(5)
  })

  it('orders by urgency across both sources: overdue, then today, then Do ASAP, then Instant, then his upcoming', () => {
    const order = plan.lines.map((l) => (l.source === 'task' ? l.match.split(' ').slice(0, 2).join(' ') : l.match))
    expect(order).toEqual([
      'pay the', // overdue 28 Sep
      'N31', // overdue 29 Sep (day)
      'call the', // overdue 29 Sep 17:00
      'N33', // today
      'send the', // today 16:00
      'N20',
      'N32',
      'N23',
      'N34',
      'book the', // his high-priority upcoming
      'renew the',
    ])
  })

  it('tags every line with its source', () => {
    for (const l of plan.lines) expect(l.text).toMatch(l.source === 'task' ? /^\[Task\] / : /^\[N\d+ · /)
    expect(plan.lines[0].text).toContain('(OVERDUE)')
  })

  it('Think about and Later are one count line', () => {
    expect(plan.lines.some((l) => ['N9', 'N5', 'N12', 'N21'].includes(l.match))).toBe(false)
    expect(plan.countsLine).toBe('Also waiting on you: 3 to think about, 1 for later (Needs-you List 7).')
  })

  it('raises the word limit only for the extra MUST lines', () => {
    expect(plan.must).toHaveLength(9) // 3 own + 6 Needs-you (2 dated, 4 ASAP/Instant)
    expect(plan.wordLimit).toBe(160 + 15 * 5)
    expect(buildBriefPlan({ tasks: [], needs: null, now, fmtDue, fmtDay }).wordLimit).toBe(160)
  })

  it('without a Needs-you list, the brief is his tasks exactly as before', () => {
    const p = buildBriefPlan({ tasks, needs: null, now, fmtDue, fmtDay })
    expect(p.lines).toHaveLength(5)
    expect(p.countsLine).toBeNull()
  })
})

describe('ensureMustShow', () => {
  const plan = buildBriefPlan({ tasks, needs, now, fmtDue, fmtDay })

  it('appends, word for word, every MUST item the model left out', () => {
    const model = 'Sign the lease first.\n• N31: Sign the lease\n• N20: Natalia\n• Task: Pay the car insurance'
    const out = ensureMustShow(model, plan)
    expect(out).toContain('Also on for today:')
    expect(out).toContain('• Task: Call the notary')
    expect(out).toContain('• Task: Send the Gibraltar form')
    for (const id of ['N32', 'N23', 'N33', 'N34']) expect(out).toMatch(new RegExp(`• ${id} `))
    expect(out).not.toMatch(/• N31 \(/) // already there, not repeated
    expect(out).toContain('3 to think about, 1 for later')
  })

  it('leaves a complete brief alone', () => {
    const full = plan.must.map((l) => `• ${l.fallback}`).join('\n') + `\n${plan.countsLine}`
    expect(ensureMustShow(full, plan)).toBe(full)
  })

  it('an N-ID only counts as a whole word (N2 is not N20)', () => {
    const p = buildBriefPlan({ tasks: [], needs: { ...needs, items: [{ id: 'N2', section: 'asap', title: 'x' }] }, now, fmtDue, fmtDay })
    expect(ensureMustShow('• N20: something', p)).toContain('• N2 (Do ASAP): x')
  })
})
