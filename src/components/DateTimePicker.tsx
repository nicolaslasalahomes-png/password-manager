import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { listDayMarks } from '../lib/tasks'

/**
 * Custom date+time picker that renders the user's calendar day-color marks in
 * its month grid — something the native <input type="datetime-local"> picker
 * can't do (its dropdown is OS-rendered and unstyleable).
 *
 * Value format matches datetime-local: 'YYYY-MM-DDTHH:MM', so callers that did
 * `new Date(value).toISOString()` keep working unchanged.
 */

interface DayMark {
  color: string
  label: string | null
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function parseValue(v: string): { date: string; time: string } {
  if (!v) return { date: '', time: '12:00' }
  const [date, time] = v.split('T')
  return { date: date ?? '', time: (time ?? '12:00').slice(0, 5) }
}

/** Monday-first 6×7 grid covering the given month. */
function buildGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1)
  const dow = (first.getDay() + 6) % 7 // Mon=0 … Sun=6
  const start = new Date(first)
  start.setDate(1 - dow)
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    return d
  })
}

export default function DateTimePicker({
  value,
  onChange,
  placeholder = 'Pick a date & time',
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  const parsed = parseValue(value)
  const [open, setOpen] = useState(false)
  const [time, setTime] = useState(parsed.time)
  const [marks, setMarks] = useState<Record<string, DayMark>>({})
  const ref = useRef<HTMLDivElement>(null)

  const initial = parsed.date ? new Date(parsed.date + 'T00:00:00') : new Date()
  const [viewYear, setViewYear] = useState(initial.getFullYear())
  const [viewMonth, setViewMonth] = useState(initial.getMonth())

  // Keep internal time in sync if the value is changed externally.
  useEffect(() => {
    setTime(parseValue(value).time)
  }, [value])

  // Load day marks when the calendar opens.
  useEffect(() => {
    if (!open) return
    listDayMarks()
      .then((rows) => {
        const m: Record<string, DayMark> = {}
        for (const r of rows) m[r.day] = { color: r.color, label: r.label }
        setMarks(m)
      })
      .catch(() => {})
  }, [open])

  // Click-away to close.
  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const grid = useMemo(() => buildGrid(viewYear, viewMonth), [viewYear, viewMonth])
  const selectedDate = parsed.date
  const todayIso = isoDay(new Date())
  const monthLabel = new Date(viewYear, viewMonth, 1).toLocaleString(undefined, {
    month: 'long',
    year: 'numeric',
  })

  function emit(date: string, t: string) {
    if (!date) return
    onChange(`${date}T${t}`)
  }

  function displayLabel(): string {
    if (!value) return placeholder
    const d = new Date(value)
    return d.toLocaleString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="input flex w-full items-center gap-2 text-left"
      >
        <CalendarDays size={14} className="flex-shrink-0 text-ink-400" />
        <span className={value ? 'text-ink-100' : 'text-ink-500'}>{displayLabel()}</span>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-[300px] rounded-lg border border-ink-700 bg-ink-900 p-3 shadow-2xl">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-ink-100">{monthLabel}</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  const m = viewMonth - 1
                  if (m < 0) {
                    setViewMonth(11)
                    setViewYear((y) => y - 1)
                  } else setViewMonth(m)
                }}
                className="rounded p-1 text-ink-400 hover:bg-ink-800 hover:text-ink-100"
              >
                <ChevronLeft size={14} />
              </button>
              <button
                type="button"
                onClick={() => {
                  const m = viewMonth + 1
                  if (m > 11) {
                    setViewMonth(0)
                    setViewYear((y) => y + 1)
                  } else setViewMonth(m)
                }}
                className="rounded p-1 text-ink-400 hover:bg-ink-800 hover:text-ink-100"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-7 gap-0.5 pb-1 text-center text-[10px] uppercase tracking-wider text-ink-500">
            {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d) => (
              <div key={d}>{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-0.5">
            {grid.map((d, i) => {
              const dayIso = isoDay(d)
              const inMonth = d.getMonth() === viewMonth
              const isToday = dayIso === todayIso
              const isSelected = dayIso === selectedDate
              const mark = marks[dayIso]
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => emit(dayIso, time || '12:00')}
                  title={mark?.label ?? undefined}
                  className={`relative flex h-8 items-center justify-center rounded text-xs transition ${
                    isSelected
                      ? 'bg-accent-600 font-semibold text-on-accent'
                      : isToday
                      ? 'font-bold text-accent-300'
                      : inMonth
                      ? 'text-ink-200 hover:bg-ink-800'
                      : 'text-ink-600 hover:bg-ink-800/50'
                  }`}
                  style={
                    mark && !isSelected
                      ? { backgroundColor: mark.color + '33', boxShadow: `inset 0 0 0 1px ${mark.color}66` }
                      : {}
                  }
                >
                  {d.getDate()}
                  {mark && !isSelected && (
                    <span
                      className="absolute bottom-0.5 h-1 w-1 rounded-full"
                      style={{ backgroundColor: mark.color }}
                    />
                  )}
                </button>
              )
            })}
          </div>

          <div className="mt-3 flex items-center gap-2 border-t border-ink-800 pt-3">
            <span className="text-xs text-ink-400">Time</span>
            <input
              type="time"
              value={time}
              onChange={(e) => {
                const t = e.target.value || '12:00'
                setTime(t)
                if (selectedDate) emit(selectedDate, t)
              }}
              className="input-mono !w-28 !py-1.5 text-xs"
            />
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="btn-secondary ml-auto !px-3 !py-1.5 !text-xs"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
