import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Circle,
  Plus,
  Save,
  Square,
  X,
} from 'lucide-react'
import Layout from '../components/Layout'
import DateTimePicker from '../components/DateTimePicker'
import { useAuth } from '../state/AuthContext'
import { useVault } from '../state/VaultContext'
import { useToast } from '../state/ToastContext'
import { createItem, decryptItem } from '../lib/items'
import type { DecryptedItem, Priority, VaultItemRow } from '../lib/items'
import { listAllTasks, markTaskComplete, markTaskIncomplete } from '../lib/tasks'

const PRIORITY_RANK: Record<Priority, number> = { high: 0, medium: 1, low: 2 }

export default function Todo() {
  const { dek, highDek } = useVault()
  const { user } = useAuth()
  const toast = useToast()
  const navigate = useNavigate()
  const [rows, setRows] = useState<VaultItemRow[] | null>(null)
  const [decryptedById, setDecryptedById] = useState<Record<string, DecryptedItem>>({})
  const [showCompleted, setShowCompleted] = useState(false)
  // New-task inline form
  const [adding, setAdding] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDue, setNewDue] = useState('')
  const [newPriority, setNewPriority] = useState<Priority>('medium')
  const [newNote, setNewNote] = useState('')
  const [creating, setCreating] = useState(false)

  const reload = useCallback(async () => {
    try {
      // Load ALL tasks (open + completed). Completed ones become the history
      // section below — they stay as a record, they just stop pinging you.
      const tasks = await listAllTasks()
      setRows(tasks)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load tasks')
    }
  }, [toast])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    if (!rows || !dek) return
    let cancelled = false
    ;(async () => {
      const next: Record<string, DecryptedItem> = {}
      for (const r of rows) {
        try {
          next[r.id] = await decryptItem(r, { dek, highDek })
        } catch {
          // High-tier without elevation; skip — won't show title but row is still visible
        }
      }
      if (!cancelled) setDecryptedById(next)
    })()
    return () => {
      cancelled = true
    }
  }, [rows, dek, highDek])

  const openSorted = useMemo(() => {
    if (!rows) return []
    const now = Date.now()
    return rows
      .filter((r) => !r.completed_at)
      .sort((a, b) => {
        const aDue = a.due_at ? new Date(a.due_at).getTime() : 0
        const bDue = b.due_at ? new Date(b.due_at).getTime() : 0
        // Overdue first
        const aOverdue = aDue < now
        const bOverdue = bDue < now
        if (aOverdue !== bOverdue) return aOverdue ? -1 : 1
        // Then priority
        const aP = a.priority ? PRIORITY_RANK[a.priority] : 3
        const bP = b.priority ? PRIORITY_RANK[b.priority] : 3
        if (aP !== bP) return aP - bP
        // Then due date ascending
        return aDue - bDue
      })
  }, [rows])

  const completedSorted = useMemo(() => {
    if (!rows) return []
    return rows
      .filter((r) => !!r.completed_at)
      .sort((a, b) => {
        // Most recently completed first — reads like a history feed.
        const at = a.completed_at ? new Date(a.completed_at).getTime() : 0
        const bt = b.completed_at ? new Date(b.completed_at).getTime() : 0
        return bt - at
      })
  }, [rows])

  async function onComplete(row: VaultItemRow) {
    try {
      await markTaskComplete(row.id)
      const ts = new Date().toISOString()
      // Keep the row — just flip it to completed so it slides into history.
      setRows((prev) => prev?.map((r) => (r.id === row.id ? { ...r, completed_at: ts } : r)) ?? null)
      toast.success('Task completed — kept in your history')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not mark complete')
    }
  }

  async function onReopen(row: VaultItemRow) {
    try {
      await markTaskIncomplete(row.id)
      setRows((prev) => prev?.map((r) => (r.id === row.id ? { ...r, completed_at: null } : r)) ?? null)
      toast.success('Task reopened')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not reopen task')
    }
  }

  async function onCreate() {
    if (!user || !dek) return
    if (!newTitle.trim()) {
      toast.error('Title is required')
      return
    }
    if (!newDue) {
      toast.error('A task needs a due date')
      return
    }
    setCreating(true)
    try {
      await createItem(
        user.id,
        {
          type: 'task',
          title: newTitle.trim(),
          visibility_tier: 'medium',
          fields: newNote.trim() ? { body: newNote.trim() } : {},
          due_at: new Date(newDue).toISOString(),
          priority: newPriority,
        },
        { dek, highDek },
      )
      toast.success('Task added')
      setNewTitle('')
      setNewDue('')
      setNewNote('')
      setNewPriority('medium')
      setAdding(false)
      await reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create task')
    } finally {
      setCreating(false)
    }
  }

  return (
    <Layout>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink-50">To-Do</h1>
          <p className="mt-0.5 text-sm text-ink-300">
            Tasks with deadlines. Sorted overdue → priority → due date.
          </p>
        </div>
        {!adding && (
          <button onClick={() => setAdding(true)} className="btn-primary !px-3 !py-1.5">
            <Plus size={14} /> New task
          </button>
        )}
      </div>

      {adding && (
        <div className="card mb-4 space-y-3 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink-100">New task</h2>
            <button
              onClick={() => setAdding(false)}
              className="text-ink-400 hover:text-ink-100"
              title="Cancel"
            >
              <X size={16} />
            </button>
          </div>
          <input
            className="input"
            placeholder="Task title (e.g. Finish microsite import)"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            autoFocus
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Due date &amp; time</label>
              <DateTimePicker value={newDue} onChange={setNewDue} />
            </div>
            <div>
              <label className="label">Priority</label>
              <select
                value={newPriority}
                onChange={(e) => setNewPriority(e.target.value as Priority)}
                className="input"
              >
                <option value="low">Low — 1 reminder/day</option>
                <option value="medium">Medium — 2 reminders/day</option>
                <option value="high">High — 4 reminders/day</option>
              </select>
            </div>
          </div>
          <textarea
            className="input-mono min-h-[60px]"
            placeholder="Details (optional)"
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
          />
          <div className="flex justify-end">
            <button onClick={onCreate} disabled={creating} className="btn-primary">
              <Save size={14} /> {creating ? 'Adding…' : 'Add task'}
            </button>
          </div>
        </div>
      )}

      {rows === null ? (
        <p className="text-center text-sm text-ink-300 py-12">Loading…</p>
      ) : openSorted.length === 0 ? (
        !adding && <EmptyState onAdd={() => setAdding(true)} hasHistory={completedSorted.length > 0} />
      ) : (
        <div className="card divide-y divide-ink-800">
          {openSorted.map((r) => {
            const dec = decryptedById[r.id]
            const dueMs = r.due_at ? new Date(r.due_at).getTime() : 0
            const overdue = dueMs < Date.now()
            return (
              <div key={r.id} className="flex items-start gap-3 px-4 py-3">
                <button
                  onClick={() => onComplete(r)}
                  className="mt-0.5 text-ink-400 hover:text-emerald-400"
                  title="Mark complete"
                >
                  <Square size={16} />
                </button>
                <button
                  onClick={() => navigate(`/vault/${r.id}`)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink-100">
                      {dec ? dec.title : r.title}
                    </span>
                    {r.priority && <PriorityBadge priority={r.priority as Priority} />}
                    {overdue && (
                      <span className="inline-flex items-center gap-1 rounded bg-red-950/50 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-red-300">
                        <AlertTriangle size={9} /> overdue
                      </span>
                    )}
                  </div>
                  <p className={`mt-0.5 text-xs ${overdue ? 'text-red-300' : 'text-ink-400'}`}>
                    {r.due_at ? formatDueRelative(r.due_at) : '(no due date)'}
                  </p>
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* Completed history — kept as a record; these no longer send reminders. */}
      {completedSorted.length > 0 && (
        <div className="mt-6">
          <button
            onClick={() => setShowCompleted((v) => !v)}
            className="flex w-full items-center gap-2 text-sm font-medium text-ink-300 hover:text-ink-100"
          >
            {showCompleted ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
            <CheckCircle2 size={14} className="text-emerald-500/70" />
            Completed
            <span className="rounded-full bg-ink-800 px-2 py-0.5 text-[11px] text-ink-300">
              {completedSorted.length}
            </span>
          </button>
          {showCompleted && (
            <div className="card mt-3 divide-y divide-ink-800">
              {completedSorted.map((r) => {
                const dec = decryptedById[r.id]
                return (
                  <div key={r.id} className="flex items-start gap-3 px-4 py-3">
                    <button
                      onClick={() => onReopen(r)}
                      className="mt-0.5 text-emerald-500 hover:text-emerald-300"
                      title="Reopen task"
                    >
                      <CheckSquare size={16} />
                    </button>
                    <button
                      onClick={() => navigate(`/vault/${r.id}`)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-ink-400 line-through">
                          {dec ? dec.title : r.title}
                        </span>
                        {r.priority && <PriorityBadge priority={r.priority as Priority} muted />}
                      </div>
                      <p className="mt-0.5 text-xs text-ink-500">
                        {r.completed_at ? `Completed ${formatStamp(r.completed_at)}` : 'Completed'}
                        {r.due_at && ` · was due ${formatStamp(r.due_at)}`}
                      </p>
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </Layout>
  )
}

function EmptyState({ onAdd, hasHistory }: { onAdd: () => void; hasHistory: boolean }) {
  return (
    <div className="card mx-auto max-w-md p-8 text-center">
      <CheckCircle2 className="mx-auto mb-3 text-accent-400" size={32} />
      <h2 className="text-lg font-semibold">No open tasks</h2>
      <p className="mt-2 text-sm text-ink-300">
        {hasHistory
          ? 'All caught up. Your completed tasks are kept in the history below.'
          : 'Add a task with a due date + priority and it shows up here, on the calendar, and starts sending you reminders.'}
      </p>
      <button onClick={onAdd} className="btn-primary mt-5 inline-flex">
        <Plus size={14} /> New task
      </button>
    </div>
  )
}

function PriorityBadge({ priority, muted }: { priority: Priority; muted?: boolean }) {
  if (muted) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-ink-800/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-ink-500">
        <Circle size={7} fill="currentColor" /> {priority}
      </span>
    )
  }
  const cls =
    priority === 'high'
      ? 'bg-red-950/50 text-red-300'
      : priority === 'medium'
      ? 'bg-amber-950/50 text-amber-300'
      : 'bg-ink-800 text-ink-300'
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${cls}`}>
      <Circle size={7} fill="currentColor" /> {priority}
    </span>
  )
}

function formatStamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatDueRelative(iso: string): string {
  const t = new Date(iso).getTime()
  const diff = t - Date.now()
  if (diff < 0) {
    const ago = Math.abs(diff)
    if (ago < 3600_000) return `Overdue by ${Math.round(ago / 60_000)}m`
    if (ago < 86400_000) return `Overdue by ${Math.round(ago / 3600_000)}h`
    return `Overdue by ${Math.round(ago / 86400_000)}d (was ${new Date(iso).toLocaleString()})`
  }
  if (diff < 3600_000) return `Due in ${Math.round(diff / 60_000)}m`
  if (diff < 86400_000) return `Due in ${Math.round(diff / 3600_000)}h (${new Date(iso).toLocaleString()})`
  return `Due in ${Math.round(diff / 86400_000)}d (${new Date(iso).toLocaleString()})`
}
