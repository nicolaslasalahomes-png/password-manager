/**
 * VAULT-1: "Needs you now". The current Needs-you list, opened on this device, shown next to
 * the To-Do list and on the Brief page. It never replaces his own tasks: it is a separate
 * card. An item goes away when it is answered and the next list arrives.
 *
 * VAULT-2: every item has a reply box (Enter sends); Instant items also have one-tap answers.
 * Replies are sealed to the reader on his Mac; the card shows "Sent 15:42: <text>" until a later
 * list drops the item. A second reply to the same item supersedes the first.
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, ExternalLink, Inbox, Send } from 'lucide-react'
import { useAuth } from '../state/AuthContext'
import { useVault } from '../state/VaultContext'
import { loadNeedsYou, type NeedsYouLoad } from '../lib/inbox/load'
import { SECTION_LABEL, dueDayStart, type NeedsYouItem } from '../lib/inbox/needsYou'
import { latestReplies, sendReply, type SentReply } from '../lib/inbox/outbox'
import { MAX_REPLY_CHARS, quickAnswers } from '../lib/inbox/reply'
import { useToast } from '../state/ToastContext'

export default function NeedsYouPanel({ className = '' }: { className?: string }) {
  const { dek } = useVault()
  const { user } = useAuth()
  const [state, setState] = useState<NeedsYouLoad | null>(null)
  const [showRest, setShowRest] = useState(false)
  const [sent, setSent] = useState<Record<string, SentReply>>({})
  const toast = useToast()

  useEffect(() => {
    if (!user || !dek) return
    let alive = true
    void loadNeedsYou(user.id, dek).then((r) => {
      if (alive) setState(r)
    })
    return () => {
      alive = false
    }
  }, [user, dek])

  const itemKey = state?.status === 'ok' ? state.snapshot.items.map((i) => i.id).join(',') : ''
  useEffect(() => {
    if (!dek || !itemKey) return
    let alive = true
    latestReplies(dek, itemKey.split(','))
      .then((r) => {
        if (alive) setSent(r)
      })
      .catch((err) => console.warn('[outbox] could not load sent replies', err))
    return () => {
      alive = false
    }
  }, [dek, itemKey])

  const reply = useCallback(
    async (item: NeedsYouItem, text: string): Promise<boolean> => {
      if (!user || !dek || state?.status !== 'ok') return false
      try {
        const r = await sendReply({ userId: user.id, dek, listNo: state.snapshot.list_no, itemId: item.id, title: item.title, text })
        setSent((prev) => ({ ...prev, [item.id]: r }))
        return true
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not send the reply')
        return false
      }
    },
    [user, dek, state, toast],
  )

  if (!state || state.status === 'none') return null

  if (state.status === 'refused') {
    return (
      <div className={`card flex items-start gap-2 border-red-900/60 p-4 text-sm text-red-300 ${className}`} role="alert">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <span>Needs-you list not shown: {state.reason}</span>
      </div>
    )
  }

  const { snapshot, stale } = state
  const now = (s: NeedsYouItem['section']) => snapshot.items.filter((i) => i.section === s)
  const asap = now('asap')
  const instant = now('instant')
  const rest = [...now('think'), ...now('later')]
  const updated = new Date(snapshot.created_at).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <div className={`card p-0 ${className}`} data-testid="needs-you-panel">
      <header className="flex items-center justify-between border-b border-ink-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <Inbox size={14} className="text-accent-400" />
          <span className="text-sm font-semibold text-ink-100">Needs you now</span>
        </div>
        <span className={`text-[11px] tabular-nums ${stale ? 'text-amber-300' : 'text-ink-500'}`}>
          List {snapshot.list_no} · {updated}
          {stale ? ' · may be out of date' : ''}
        </span>
      </header>
      <div className="space-y-3 px-4 py-3">
        {asap.length + instant.length === 0 && <p className="text-sm text-ink-300">Nothing urgent waiting on you.</p>}
        <Section label={SECTION_LABEL.asap} items={asap} sent={sent} onReply={reply} />
        <Section label="Instant decisions" items={instant} sent={sent} onReply={reply} quick />
        {rest.length > 0 && (
          <div>
            <button
              onClick={() => setShowRest((v) => !v)}
              className="flex items-center gap-1 text-xs font-medium text-ink-300 hover:text-ink-100"
            >
              {showRest ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {now('think').length} to think about, {now('later').length} for later
            </button>
            {showRest && (
              <div className="mt-2 space-y-3">
                <Section label={SECTION_LABEL.think} items={now('think')} sent={sent} onReply={reply} />
                <Section label={SECTION_LABEL.later} items={now('later')} sent={sent} onReply={reply} />
              </div>
            )}
          </div>
        )}
        <p className="text-[11px] text-ink-500">Reply here or in chat, by number (e.g. "{(asap[0] ?? instant[0] ?? snapshot.items[0])?.id ?? 'N1'} done").</p>
      </div>
    </div>
  )
}

function Section({
  label,
  items,
  sent,
  onReply,
  quick = false,
}: {
  label: string
  items: NeedsYouItem[]
  sent: Record<string, SentReply>
  onReply: (item: NeedsYouItem, text: string) => Promise<boolean>
  quick?: boolean
}) {
  if (!items.length) return null
  const today = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime()
  return (
    <div>
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-400">{label}</h3>
      <ul className="space-y-2.5">
        {items.map((i) => {
          const day = i.due ? dueDayStart(i.due) : null
          const overdue = !!day && day.getTime() < today
          return (
            <li key={i.id} className="flex items-start gap-2 text-sm">
              <span className="mt-0.5 shrink-0 rounded bg-ink-800 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-ink-200">
                {i.id}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-ink-100">{i.title}</p>
                {i.action && <p className="text-xs text-ink-400">{i.action}</p>}
                {day && (
                  <p className={`text-xs ${overdue ? 'text-red-300' : 'text-ink-400'}`}>
                    {overdue ? 'Overdue, was due ' : 'Due '}
                    {day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                  </p>
                )}
                {i.link && (
                  <a
                    href={i.link}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 break-all text-xs text-accent-400 hover:underline"
                  >
                    {i.link} <ExternalLink size={11} />
                  </a>
                )}
                <ReplyBox item={i} sent={sent[i.id]} onReply={onReply} quick={quick} />
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function ReplyBox({
  item,
  sent,
  onReply,
  quick,
}: {
  item: NeedsYouItem
  sent?: SentReply
  onReply: (item: NeedsYouItem, text: string) => Promise<boolean>
  quick: boolean
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async (t: string) => {
    if (!t.trim() || busy) return
    setBusy(true)
    const ok = await onReply(item, t)
    setBusy(false)
    if (ok) setText('')
  }
  return (
    <div className="mt-1.5 space-y-1">
      {sent && (
        <p className="flex items-start gap-1 text-xs text-emerald-300" data-testid={`sent-${item.id}`}>
          <Check size={12} className="mt-0.5 shrink-0" />
          <span>
            Sent {new Date(sent.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}: {sent.text}
          </span>
        </p>
      )}
      <div className="flex items-center gap-1.5">
        {quick &&
          quickAnswers(item.action).map((a) => (
            <button
              key={a}
              type="button"
              disabled={busy}
              onClick={() => void send(a)}
              className="btn-ghost !px-2 !py-0.5 text-xs"
            >
              {a}
            </button>
          ))}
        <input
          className="input !py-1 text-xs"
          placeholder={sent ? 'Send another reply (replaces the last)' : 'Reply…'}
          value={text}
          maxLength={MAX_REPLY_CHARS}
          disabled={busy}
          aria-label={`Reply to ${item.id}`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send(text)
            }
          }}
        />
        <button
          type="button"
          disabled={busy || !text.trim()}
          onClick={() => void send(text)}
          className="btn-ghost !px-2 !py-1"
          title="Send"
        >
          <Send size={12} />
        </button>
      </div>
    </div>
  )
}
