import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Paintbrush, X } from 'lucide-react'
import Layout from '../components/Layout'
import { useAuth } from '../state/AuthContext'
import { useVault } from '../state/VaultContext'
import { useToast } from '../state/ToastContext'
import { decryptItem, type DecryptedItem, type VaultItemRow } from '../lib/items'
import {
  type DayMarkRow,
  deleteDayMark,
  listAllTasks,
  listDayMarks,
  upsertDayMark,
} from '../lib/tasks'

const PALETTE = [
  '#3b82f6', // blue
  '#10b981', // green
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#06b6d4', // cyan
]

function isoDay(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

/** Subtle background tint for a task chip, by priority. Dimmed if completed. */
function priorityTint(priority: string | null, completed: boolean): string {
  if (completed) return 'rgba(255,255,255,0.03)'
  switch (priority) {
    case 'high':
      return 'rgba(239,68,68,0.18)' // red
    case 'medium':
      return 'rgba(245,158,11,0.16)' // amber
    case 'low':
      return 'rgba(255,255,255,0.06)'
    default:
      return 'rgba(255,255,255,0.06)'
  }
}

function priorityDot(priority: string | null): string {
  switch (priority) {
    case 'high':
      return '#ef4444'
    case 'medium':
      return '#f59e0b'
    case 'low':
      return '#6b7280'
    default:
      return '#6b7280'
  }
}

/** Build the month grid: 6 rows × 7 cols, starting on Sunday, with adjacent month's days dim. */
function buildMonthGrid(viewDate: Date): Date[] {
  const start = startOfMonth(viewDate)
  const startWeekday = start.getDay() // 0=Sun
  const gridStart = new Date(start)
  gridStart.setDate(start.getDate() - startWeekday)
  const cells: Date[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart)
    d.setDate(gridStart.getDate() + i)
    cells.push(d)
  }
  return cells
}

export default function Calendar() {
  const { user } = useAuth()
  const { dek, highDek } = useVault()
  const toast = useToast()
  const navigate = useNavigate()
  const [viewDate, setViewDate] = useState(() => new Date())
  const [tasks, setTasks] = useState<VaultItemRow[] | null>(null)
  const [marks, setMarks] = useState<DayMarkRow[]>([])
  const [decryptedById, setDecryptedById] = useState<Record<string, DecryptedItem>>({})
  const [selectedDay, setSelectedDay] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const [ts, ms] = await Promise.all([listAllTasks(), listDayMarks()])
      setTasks(ts)
      setMarks(ms)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load calendar')
    }
  }, [toast])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    if (!tasks || !dek) return
    let cancelled = false
    ;(async () => {
      const next: Record<string, DecryptedItem> = {}
      for (const r of tasks) {
        try {
          next[r.id] = await decryptItem(r, { dek, highDek })
        } catch {
          /* skip */
        }
      }
      if (!cancelled) setDecryptedById(next)
    })()
    return () => {
      cancelled = true
    }
  }, [tasks, dek, highDek])

  const grid = useMemo(() => buildMonthGrid(viewDate), [viewDate])
  const tasksByDay = useMemo(() => {
    const m = new Map<string, VaultItemRow[]>()
    for (const t of tasks ?? []) {
      if (!t.due_at) continue
      const key = isoDay(new Date(t.due_at))
      const arr = m.get(key) ?? []
      arr.push(t)
      m.set(key, arr)
    }
    return m
  }, [tasks])
  const marksByDay = useMemo(() => {
    const m = new Map<string, DayMarkRow>()
    for (const mk of marks) m.set(mk.day, mk)
    return m
  }, [marks])

  const monthLabel = viewDate.toLocaleString(undefined, { month: 'long', year: 'numeric' })
  const todayIso = isoDay(new Date())

  async function setColor(day: string, color: string | null, label: string | null) {
    if (!user) return
    try {
      if (color === null) {
        const existing = marksByDay.get(day)
        if (existing) await deleteDayMark(existing.id)
      } else {
        await upsertDayMark(user.id, day, color, label)
      }
      await reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update day color')
    }
  }

  const selectedTasks = selectedDay ? tasksByDay.get(selectedDay) ?? [] : []
  const selectedMark = selectedDay ? marksByDay.get(selectedDay) : undefined

  return (
    <Layout>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-ink-50">{monthLabel}</h1>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1))}
              className="btn-ghost !px-2 !py-1.5"
              title="Previous month"
            >
              <ChevronLeft size={14} />
            </button>
            <button
              onClick={() => setViewDate(new Date())}
              className="btn-secondary !px-2 !py-1.5 !text-xs"
            >
              Today
            </button>
            <button
              onClick={() => setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1))}
              className="btn-ghost !px-2 !py-1.5"
              title="Next month"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>

      {tasks === null ? (
        <p className="text-center text-sm text-ink-300 py-12">Loading…</p>
      ) : (
        <div className="card p-3">
          <div className="grid grid-cols-7 gap-1 pb-2 text-center text-[11px] uppercase tracking-wider text-ink-500">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
              <div key={d}>{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {grid.map((d, i) => {
              const inMonth = d.getMonth() === viewDate.getMonth()
              const dayIso = isoDay(d)
              const isToday = dayIso === todayIso
              const dayTasks = tasksByDay.get(dayIso) ?? []
              const mark = marksByDay.get(dayIso)
              return (
                <button
                  key={i}
                  onClick={() => setSelectedDay(dayIso)}
                  className={`relative flex h-28 flex-col items-stretch overflow-hidden rounded-md border p-1.5 text-left text-xs transition ${
                    selectedDay === dayIso
                      ? 'border-accent-500 ring-1 ring-accent-500/50'
                      : 'border-ink-800 hover:border-ink-700'
                  } ${inMonth ? '' : 'opacity-40'}`}
                  style={mark ? { backgroundColor: mark.color + '22', borderColor: mark.color + '55' } : {}}
                >
                  <div className="flex items-start justify-between">
                    <span
                      className={`text-[11px] tabular-nums ${
                        isToday
                          ? 'rounded-full bg-accent-500 px-1.5 py-0.5 font-bold text-on-accent'
                          : 'text-ink-300'
                      }`}
                    >
                      {d.getDate()}
                    </span>
                    {mark && (
                      <span
                        className="h-2 w-2 flex-shrink-0 rounded-full"
                        style={{ backgroundColor: mark.color }}
                        title={mark.label ?? undefined}
                      />
                    )}
                  </div>
                  {dayTasks.length > 0 && (
                    <div className="mt-1 flex-1 space-y-0.5 overflow-hidden">
                      {dayTasks.slice(0, 3).map((t) => (
                        <div
                          key={t.id}
                          title={t.title}
                          className={`flex items-center gap-1 truncate rounded px-1 py-0.5 text-[10px] leading-tight ${
                            t.completed_at ? 'text-ink-500 line-through' : 'text-ink-100'
                          }`}
                          style={{ backgroundColor: priorityTint(t.priority, !!t.completed_at) }}
                        >
                          <span
                            className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                            style={{ backgroundColor: priorityDot(t.priority) }}
                          />
                          <span className="truncate">{t.title}</span>
                        </div>
                      ))}
                      {dayTasks.length > 3 && (
                        <div className="px-1 text-[9px] text-ink-500">+{dayTasks.length - 3} more</div>
                      )}
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {selectedDay && (
        <DayDetailPanel
          day={selectedDay}
          tasks={selectedTasks}
          decryptedById={decryptedById}
          mark={selectedMark}
          onClose={() => setSelectedDay(null)}
          onSetColor={(color, label) => setColor(selectedDay, color, label)}
          onTaskClick={(id) => navigate(`/vault/${id}`)}
        />
      )}
    </Layout>
  )
}

function DayDetailPanel({
  day,
  tasks,
  decryptedById,
  mark,
  onClose,
  onSetColor,
  onTaskClick,
}: {
  day: string
  tasks: VaultItemRow[]
  decryptedById: Record<string, DecryptedItem>
  mark: DayMarkRow | undefined
  onClose: () => void
  onSetColor: (color: string | null, label: string | null) => void
  onTaskClick: (id: string) => void
}) {
  const [labelDraft, setLabelDraft] = useState(mark?.label ?? '')
  useEffect(() => {
    setLabelDraft(mark?.label ?? '')
  }, [mark?.label])

  const dateObj = new Date(day + 'T00:00:00')
  const dateLabel = dateObj.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-md p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold text-ink-50">{dateLabel}</h2>
            <p className="mt-0.5 text-xs text-ink-400">
              {tasks.length} task{tasks.length === 1 ? '' : 's'} due
            </p>
          </div>
          <button onClick={onClose} className="btn-ghost !px-2 !py-1.5">
            <X size={14} />
          </button>
        </div>

        <section className="space-y-2 border-b border-ink-800 pb-4">
          <h3 className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-ink-400">
            <Paintbrush size={11} /> Day color
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {PALETTE.map((c) => (
              <button
                key={c}
                onClick={() => onSetColor(c, labelDraft || null)}
                className={`h-7 w-7 rounded-md ring-2 ring-offset-2 ring-offset-ink-900 transition ${
                  mark?.color === c ? 'ring-ink-50' : 'ring-transparent hover:ring-ink-600'
                }`}
                style={{ backgroundColor: c }}
                title={c}
              />
            ))}
            <button
              onClick={() => onSetColor(null, null)}
              className="h-7 w-7 rounded-md border border-ink-700 text-[10px] text-ink-400 hover:text-ink-100"
              title="Clear"
            >
              ✕
            </button>
          </div>
          <input
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            onBlur={() => {
              if (mark && labelDraft !== (mark.label ?? '')) {
                onSetColor(mark.color, labelDraft || null)
              }
            }}
            placeholder="Day label (e.g. Sprint planning)"
            className="input !py-1.5 text-xs"
            disabled={!mark}
          />
        </section>

        <section className="mt-4">
          <h3 className="mb-2 text-[11px] uppercase tracking-wider text-ink-400">Tasks</h3>
          {tasks.length === 0 ? (
            <p className="text-center text-xs text-ink-500 py-4">No tasks due this day.</p>
          ) : (
            <ul className="space-y-1.5">
              {tasks.map((t) => {
                const dec = decryptedById[t.id]
                const done = !!t.completed_at
                return (
                  <li key={t.id}>
                    <button
                      onClick={() => onTaskClick(t.id)}
                      className="flex w-full items-center justify-between gap-2 rounded-md border border-ink-800 px-3 py-2 text-left text-xs hover:border-ink-700"
                    >
                      <span className={done ? 'text-ink-500 line-through' : 'text-ink-100'}>
                        {dec?.title ?? t.title}
                      </span>
                      <span className="text-[10px] text-ink-500">
                        {t.priority ?? 'no priority'}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
