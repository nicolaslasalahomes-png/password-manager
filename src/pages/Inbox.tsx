import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  Archive,
  ChevronLeft,
  Cog,
  ExternalLink,
  Mail,
  RefreshCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Trash2,
  X,
} from 'lucide-react'
import Layout from '../components/Layout'
import { useVault } from '../state/VaultContext'
import { useToast } from '../state/ToastContext'
import { openExternalUrl, useIsDesktop } from '../lib/desktop'
import {
  type CachedMessageRow,
  type DecryptedCachedMessage,
  addAuthSender,
  addSpamSender,
  decryptCachedPayload,
  deleteCachedMessage,
  getAiInboxEnabled,
  getAuthSenders,
  getSpamSenders,
  listCachedMessages,
  markInboxSeen,
  senderEmail,
  upsertCachedMessage,
} from '../lib/email'
import {
  type EmailAccountRow,
  getAccessToken,
  listAccounts,
} from '../lib/google/tokens'
import {
  archive as gmailArchive,
  getMessage,
  parseMessage,
  trash as gmailTrash,
} from '../lib/google/gmail'
import { detectTwoFactor } from '../lib/google/twoFactor'

type FilterKey = 'all' | 'unread' | '2fa' | 'today' | 'week'

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: '2fa', label: '2FA' },
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This week' },
]

/** Gmail categories we consider "noise" — promotions, social, forums, spam. */
const NOISE_LABELS = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS', 'SPAM'])

export default function Inbox() {
  const isDesktop = useIsDesktop()
  if (!isDesktop) return <InboxWebFallback />
  return <InboxDesktop />
}

function InboxWebFallback() {
  return (
    <Layout>
      <div className="card mx-auto max-w-md p-6 text-center">
        <Mail className="mx-auto mb-3 text-accent-400" size={32} />
        <h1 className="text-lg font-semibold">Inbox is desktop-only</h1>
        <p className="mt-2 text-sm text-ink-300">
          The unified Gmail inbox and 2FA auto-popups need the Mac app — they
          rely on a background poller and a native popover window the browser
          can't provide.
        </p>
        <p className="mt-3 text-xs text-ink-400">
          Open Keyring on your Mac to set this up.
        </p>
      </div>
    </Layout>
  )
}

function InboxDesktop() {
  const { dek } = useVault()
  const toast = useToast()
  const location = useLocation()
  // Route mode: "main" path /vault/inbox (smart-filtered); "all" path /vault/inbox/all (unfiltered)
  const mode: 'main' | 'all' = location.pathname.endsWith('/all') ? 'all' : 'main'

  const [accounts, setAccounts] = useState<EmailAccountRow[] | null>(null)
  const [rows, setRows] = useState<CachedMessageRow[] | null>(null)
  const [spamSenders, setSpamSenders] = useState<Set<string>>(new Set())
  const [authSenders, setAuthSenders] = useState<Set<string>>(new Set())
  const [aiEnabled, setAiEnabled] = useState(false)
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set())
  const [activeFilter, setActiveFilter] = useState<FilterKey>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null)
  const [decryptedById, setDecryptedById] = useState<Record<string, DecryptedCachedMessage>>({})
  const [refreshing, setRefreshing] = useState(false)

  const reload = useCallback(async () => {
    try {
      const [accs, msgs, spams, auths, ai] = await Promise.all([
        listAccounts(),
        listCachedMessages({ limit: 2000 }),
        getSpamSenders(),
        getAuthSenders(),
        getAiInboxEnabled(),
      ])
      setAccounts(accs)
      setRows(msgs)
      setSpamSenders(new Set(spams))
      setAuthSenders(new Set(auths))
      setAiEnabled(ai)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load inbox')
    }
  }, [toast])

  useEffect(() => {
    void reload()
  }, [reload])

  // Mark inbox as seen whenever the user lands on this page (clears the badge
  // on the Sidebar). Also fire a custom event so the Sidebar refreshes its
  // count immediately rather than waiting for its next 15s tick.
  useEffect(() => {
    void markInboxSeen()
    window.dispatchEvent(new Event('keyring:inbox-changed'))
    return () => {
      // On unmount (leaving inbox), also stamp current time so emails arriving
      // after this point count toward the next badge.
      void markInboxSeen()
    }
  }, [])

  // Stream decryption in batches of 50 so 2000-email inboxes don't freeze UI.
  useEffect(() => {
    if (!rows || !dek) return
    let cancelled = false
    ;(async () => {
      const BATCH = 50
      const local: Record<string, DecryptedCachedMessage> = { ...decryptedById }
      const todo = rows.filter((r) => !local[r.id])
      for (let i = 0; i < todo.length; i += BATCH) {
        if (cancelled) return
        const slice = todo.slice(i, i + BATCH)
        await Promise.all(
          slice.map(async (r) => {
            try {
              local[r.id] = await decryptCachedPayload(r, dek)
            } catch (err) {
              console.warn('[inbox] decrypt failed for', r.id, err)
            }
          }),
        )
        if (!cancelled) setDecryptedById({ ...local })
        await new Promise((r) => setTimeout(r, 0))
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, dek])

  const authSendersList = useMemo(() => Array.from(authSenders), [authSenders])

  const liveIs2fa = useMemo(() => {
    const out: Record<string, boolean> = {}
    if (!rows) return out
    for (const r of rows) {
      const dec = decryptedById[r.id]
      if (!dec) continue
      // A manually-marked auth sender always counts, even if no code/link is
      // extractable from the cached payload.
      if (senderEmail(r.sender) && authSenders.has(senderEmail(r.sender))) {
        out[r.id] = true
        continue
      }
      const match = detectTwoFactor(
        {
          subject: dec.subject,
          from: r.sender ?? '',
          snippet: dec.snippet,
          bodyText: dec.bodyText,
          bodyHtml: dec.bodyHtml,
          labelIds: dec.labelIds,
        },
        { authSenders: authSendersList },
      )
      out[r.id] = !!match && match.confidence >= 0.6
    }
    return out
  }, [rows, decryptedById, authSenders, authSendersList])

  const filteredRows = useMemo(() => {
    if (!rows) return []
    const now = Date.now()
    const dayMs = 24 * 60 * 60 * 1000
    const q = searchQuery.trim().toLowerCase()
    return rows.filter((r) => {
      const dec = decryptedById[r.id]

      // Main inbox filter. AI mode takes precedence when enabled — it's
      // strictly more accurate than heuristics. Heuristic fallback runs when
      // AI is disabled or the row hasn't been classified yet (NULL).
      if (mode === 'main') {
        const senderAddr = senderEmail(r.sender)
        if (senderAddr && spamSenders.has(senderAddr) && !liveIs2fa[r.id]) return false
        if (aiEnabled && r.is_important !== null) {
          if (r.is_important !== true && !liveIs2fa[r.id]) return false
        } else if (dec) {
          const hasNoise = dec.labelIds.some((l) => NOISE_LABELS.has(l))
          if (hasNoise && !liveIs2fa[r.id]) return false
        }
      }

      // Account filter
      if (selectedAccountIds.size > 0 && !selectedAccountIds.has(r.account_id)) return false

      // Filter chip
      if (activeFilter === 'unread') {
        if (!dec || !dec.labelIds.includes('UNREAD')) return false
      } else if (activeFilter === '2fa') {
        if (!liveIs2fa[r.id]) return false
      } else if (activeFilter === 'today') {
        if (now - new Date(r.received_at).getTime() > dayMs) return false
      } else if (activeFilter === 'week') {
        if (now - new Date(r.received_at).getTime() > 7 * dayMs) return false
      }

      if (q) {
        const hay =
          (r.sender ?? '').toLowerCase() +
          ' ' +
          (dec?.fromName ?? '').toLowerCase() +
          ' ' +
          (dec?.subject ?? '').toLowerCase() +
          ' ' +
          (dec?.snippet ?? '').toLowerCase() +
          ' ' +
          (dec?.bodyText ?? '').toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [rows, decryptedById, selectedAccountIds, activeFilter, searchQuery, liveIs2fa, mode, spamSenders, aiEnabled])

  const selectedRow = selectedRowId ? rows?.find((r) => r.id === selectedRowId) ?? null : null
  const selectedDecrypted = selectedRowId ? decryptedById[selectedRowId] ?? null : null

  function toggleAccount(id: string) {
    setSelectedAccountIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function onArchive(row: CachedMessageRow) {
    if (!dek) return
    const account = accounts?.find((a) => a.id === row.account_id)
    if (!account) return
    try {
      const accessToken = await getAccessToken(account, dek)
      await gmailArchive(accessToken, row.gmail_message_id)
      await deleteCachedMessage(row.id)
      setRows((prev) => prev?.filter((r) => r.id !== row.id) ?? null)
      if (selectedRowId === row.id) setSelectedRowId(null)
      window.dispatchEvent(new Event('keyring:inbox-changed'))
      toast.success('Archived')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Archive failed')
    }
  }

  async function onTrash(row: CachedMessageRow) {
    if (!dek) return
    if (!confirm('Move this email to Trash?')) return
    const account = accounts?.find((a) => a.id === row.account_id)
    if (!account) return
    try {
      const accessToken = await getAccessToken(account, dek)
      await gmailTrash(accessToken, row.gmail_message_id)
      await deleteCachedMessage(row.id)
      setRows((prev) => prev?.filter((r) => r.id !== row.id) ?? null)
      if (selectedRowId === row.id) setSelectedRowId(null)
      window.dispatchEvent(new Event('keyring:inbox-changed'))
      toast.success('Moved to Trash')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Trash failed')
    }
  }

  async function onMarkSpam(row: CachedMessageRow) {
    const addr = senderEmail(row.sender)
    if (!addr) return
    if (!confirm(`Mark ${addr} as spam? Future emails from this sender will be hidden from your main Inbox (still visible in All emails).`)) return
    try {
      const next = await addSpamSender(addr)
      setSpamSenders(new Set(next))
      // Deselect this email since it's about to vanish from main.
      if (mode === 'main' && selectedRowId === row.id) setSelectedRowId(null)
      toast.success(`${addr} marked as spam`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not mark as spam')
    }
  }

  async function onMarkAuth(row: CachedMessageRow) {
    const addr = senderEmail(row.sender)
    if (!addr) return
    try {
      const next = await addAuthSender(addr)
      setAuthSenders(new Set(next))
      toast.success(`${addr} marked as an auth sender`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not mark as auth')
    }
  }

  /**
   * Open an email: select it (preview pane swaps) AND if the cached payload
   * doesn't have HTML, backfill it from Gmail so subsequent opens are instant.
   */
  async function onOpenEmail(row: CachedMessageRow) {
    setSelectedRowId(row.id)
    const initial = decryptedById[row.id]
    if (!initial) return
    if (initial.bodyHtml && initial.bodyHtml.length > 0) return
    if (!dek || !accounts) return
    const account = accounts.find((a) => a.id === row.account_id)
    if (!account) return
    try {
      const accessToken = await getAccessToken(account, dek)
      const full = await getMessage(accessToken, row.gmail_message_id)
      const parsed = parseMessage(full)
      const m = detectTwoFactor({
        subject: parsed.subject,
        from: parsed.from,
        snippet: parsed.snippet,
        bodyText: parsed.bodyText,
        labelIds: parsed.labelIds,
      })
      const is2fa = !!m && m.confidence >= 0.6
      await upsertCachedMessage(account.user_id, account.id, parsed, is2fa, dek)
      const updatedDec: DecryptedCachedMessage = {
        ...initial,
        bodyText: parsed.bodyText,
        bodyHtml: parsed.bodyHtml,
        snippet: parsed.snippet,
      }
      setDecryptedById((prev) => ({ ...prev, [row.id]: updatedDec }))
    } catch (err) {
      console.warn('[inbox] backfill HTML failed for', row.id, err)
    }
  }

  return (
    <Layout
      rightSlot={
        <>
          <button
            onClick={() => {
              setRefreshing(true)
              void reload().finally(() => setRefreshing(false))
            }}
            className="btn-ghost !px-2 !py-1.5"
            title="Refresh"
            disabled={refreshing}
          >
            <RefreshCcw size={16} className={refreshing ? 'animate-spin' : ''} />
          </button>
          <Link to="/vault/inbox/settings" className="btn-ghost !px-2 !py-1.5" title="Inbox settings">
            <Cog size={16} />
          </Link>
        </>
      }
    >
      {accounts === null || rows === null ? (
        <p className="text-center text-sm text-ink-300 py-12">Loading inbox…</p>
      ) : accounts.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="flex h-[calc(100vh-7rem)] gap-4">
          {/* List pane */}
          <div className="flex w-[420px] flex-shrink-0 flex-col gap-3 overflow-hidden">
            <div className="flex-shrink-0 space-y-2">
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-semibold text-ink-50">
                  {mode === 'main' ? 'Inbox' : 'All emails'}
                </h1>
                <span className="text-[11px] text-ink-500">
                  {filteredRows.length} of {rows.length}
                </span>
              </div>

              <div className="relative">
                <Search
                  size={14}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400"
                />
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search subject, sender, body…"
                  className="input pl-9 pr-9"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-100"
                    title="Clear search"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>

              <div className="flex flex-wrap gap-1.5">
                <AccountChip
                  label="All"
                  count={rows.length}
                  active={selectedAccountIds.size === 0}
                  onClick={() => setSelectedAccountIds(new Set())}
                />
                {accounts.map((a) => (
                  <AccountChip
                    key={a.id}
                    label={a.email}
                    count={rows.filter((r) => r.account_id === a.id).length}
                    active={selectedAccountIds.has(a.id)}
                    warn={a.status === 'needs_reauth'}
                    onClick={() => toggleAccount(a.id)}
                  />
                ))}
              </div>

              <div className="flex flex-wrap gap-1.5 border-t border-ink-800 pt-2">
                {FILTERS.map((f) => (
                  <button
                    key={f.key}
                    onClick={() => setActiveFilter(f.key)}
                    className={`rounded-full px-2.5 py-1 text-[11px] transition ${
                      activeFilter === f.key
                        ? 'bg-ink-100 text-ink-950'
                        : 'bg-ink-800 text-ink-300 hover:text-ink-100'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="card flex-1 divide-y divide-ink-800 overflow-y-auto p-0">
              {filteredRows.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-ink-400">
                  {searchQuery || activeFilter !== 'all' || selectedAccountIds.size > 0
                    ? 'No matches. Try clearing filters or search.'
                    : mode === 'main'
                    ? 'No important emails. Switch to All emails to see everything.'
                    : "No emails in cache yet — they'll appear here as the poller picks them up."}
                </p>
              ) : (
                filteredRows.map((r) => {
                  const dec = decryptedById[r.id]
                  const unread = dec?.labelIds.includes('UNREAD')
                  const isSelected = selectedRowId === r.id
                  return (
                    <button
                      key={r.id}
                      onClick={() => onOpenEmail(r)}
                      className={`flex w-full items-start gap-3 px-3 py-2.5 text-left transition ${
                        isSelected
                          ? 'bg-accent-600/15 ring-1 ring-accent-600/30'
                          : unread
                          ? 'bg-ink-900/30 hover:bg-ink-900/60'
                          : 'hover:bg-ink-900/40'
                      }`}
                    >
                      <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-ink-800 text-ink-300">
                        {liveIs2fa[r.id] ? (
                          <ShieldAlert size={12} className="text-amber-300" />
                        ) : (
                          <Mail size={12} />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span
                            className={`truncate text-[13px] ${
                              unread ? 'font-semibold text-ink-50' : 'font-medium text-ink-100'
                            }`}
                          >
                            {dec?.fromName || r.sender || '(unknown)'}
                          </span>
                          <span className="ml-auto flex-shrink-0 text-[10px] tabular-nums text-ink-500">
                            {formatRelative(r.received_at)}
                          </span>
                        </div>
                        <p
                          className={`mt-0.5 truncate text-[12px] ${
                            unread ? 'text-ink-100' : 'text-ink-200'
                          }`}
                        >
                          {dec ? dec.subject : <span className="italic text-ink-500">decrypting…</span>}
                        </p>
                        {dec?.snippet && (
                          <p className="mt-0.5 truncate text-[11px] text-ink-500">{dec.snippet}</p>
                        )}
                      </div>
                    </button>
                  )
                })
              )}
            </div>
          </div>

          {/* Preview pane */}
          <div className="card flex flex-1 flex-col overflow-hidden p-0">
            {selectedRow && selectedDecrypted ? (
              <PreviewPane
                row={selectedRow}
                message={selectedDecrypted}
                accountEmail={
                  accounts?.find((a) => a.id === selectedRow.account_id)?.email ?? ''
                }
                onArchive={() => onArchive(selectedRow)}
                onTrash={() => onTrash(selectedRow)}
                onMarkSpam={() => onMarkSpam(selectedRow)}
                onMarkAuth={() => onMarkAuth(selectedRow)}
                isAuthSender={authSenders.has(senderEmail(selectedRow.sender))}
                onClose={() => setSelectedRowId(null)}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-ink-500">
                <Mail size={28} />
                <p className="text-sm">Select an email to preview</p>
              </div>
            )}
          </div>
        </div>
      )}
    </Layout>
  )
}

function EmptyState() {
  return (
    <div className="card mx-auto max-w-md p-8 text-center">
      <Mail className="mx-auto mb-3 text-accent-400" size={32} />
      <h1 className="text-lg font-semibold">No Google accounts linked yet</h1>
      <p className="mt-2 text-sm text-ink-300">
        Link one or more Gmail accounts to see a unified inbox here. The 2FA
        popover fires the moment a verification email arrives.
      </p>
      <Link to="/vault/inbox/settings" className="btn-primary mt-5 inline-flex">
        <ExternalLink size={14} /> Connect a Google account
      </Link>
    </div>
  )
}

function AccountChip({
  label,
  count,
  active,
  warn,
  onClick,
}: {
  label: string
  count: number
  active: boolean
  warn?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] transition ${
        active
          ? 'bg-accent-600/15 text-accent-200 ring-1 ring-accent-600/40'
          : warn
          ? 'bg-amber-950/30 text-amber-200 ring-1 ring-amber-500/30 hover:text-amber-100'
          : 'bg-ink-800 text-ink-300 hover:text-ink-100'
      }`}
    >
      {warn && <ShieldAlert size={10} />}
      <span className="max-w-[140px] truncate">{label}</span>
      <span className={active ? 'text-accent-300/80' : 'text-ink-500'}>· {count}</span>
    </button>
  )
}

function PreviewPane({
  row,
  message,
  accountEmail,
  onArchive,
  onTrash,
  onMarkSpam,
  onMarkAuth,
  isAuthSender,
  onClose,
}: {
  row: CachedMessageRow
  message: DecryptedCachedMessage
  accountEmail: string
  onArchive: () => void
  onTrash: () => void
  onMarkSpam: () => void
  onMarkAuth: () => void
  isAuthSender: boolean
  onClose: () => void
}) {
  return (
    <>
      <header className="flex flex-shrink-0 items-start gap-3 border-b border-ink-800 px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink-100">{message.fromName}</p>
          <p className="truncate text-[11px] text-ink-500">
            {row.sender ?? ''} → {accountEmail}
          </p>
          <h2 className="mt-2 text-base font-semibold text-ink-50">{message.subject}</h2>
          <p className="mt-0.5 text-[11px] text-ink-500">
            {new Date(row.received_at).toLocaleString()}
          </p>
        </div>
        <div className="flex flex-shrink-0 flex-wrap items-center gap-1">
          <button
            onClick={() => {
              const url = `https://mail.google.com/mail/u/${encodeURIComponent(
                accountEmail,
              )}/#all/${row.thread_id}`
              void openExternalUrl(url)
            }}
            className="btn-ghost !px-2 !py-1.5"
            title="Open in Gmail"
          >
            <ExternalLink size={14} />
          </button>
          <button
            onClick={onMarkAuth}
            className={`btn-ghost !px-2 !py-1.5 ${isAuthSender ? '!text-emerald-400' : '!text-accent-300'} hover:!bg-accent-950/40`}
            title={isAuthSender ? 'Already an auth sender' : 'Mark sender as auth (2FA)'}
            disabled={isAuthSender}
          >
            <ShieldCheck size={14} />
          </button>
          <button onClick={onArchive} className="btn-ghost !px-2 !py-1.5" title="Archive">
            <Archive size={14} />
          </button>
          <button
            onClick={onMarkSpam}
            className="btn-ghost !px-2 !py-1.5 !text-amber-400 hover:!bg-amber-950/40"
            title="Mark sender as spam"
          >
            <ShieldOff size={14} />
          </button>
          <button
            onClick={onTrash}
            className="btn-ghost !px-2 !py-1.5 !text-red-400 hover:!bg-red-950/40"
            title="Move to Trash"
          >
            <Trash2 size={14} />
          </button>
          <button onClick={onClose} className="btn-ghost !px-2 !py-1.5" title="Deselect">
            <ChevronLeft size={14} />
          </button>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto bg-white">
        {message.bodyHtml && message.bodyHtml.trim().length > 0 ? (
          <HtmlEmailRenderer html={message.bodyHtml} />
        ) : (
          <pre className="whitespace-pre-wrap p-5 font-sans text-sm text-ink-950">
            {message.bodyText}
          </pre>
        )}
      </div>
    </>
  )
}

function HtmlEmailRenderer({ html }: { html: string }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [height, setHeight] = useState<number>(400)

  const srcDoc = useMemo(() => {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<base target="_blank">
<style>
  html, body { margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 16px; color: #1f2937; background: #ffffff; word-wrap: break-word; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100% !important; }
  a { color: #2563eb; }
</style>
</head>
<body>
${html}
<script>
  document.addEventListener('click', function(e) {
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (a && a.href) {
      e.preventDefault();
      e.stopPropagation();
      try { parent.postMessage({ type: 'keyring:open-url', url: a.href }, '*'); } catch (err) {}
    }
  }, true);
  function reportHeight() {
    var h = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    try { parent.postMessage({ type: 'keyring:height', height: h }, '*'); } catch (err) {}
  }
  window.addEventListener('load', reportHeight);
  setTimeout(reportHeight, 50);
  setTimeout(reportHeight, 300);
  setTimeout(reportHeight, 1000);
  document.querySelectorAll('img').forEach(function(img) {
    img.addEventListener('load', reportHeight);
    img.addEventListener('error', reportHeight);
  });
</script>
</body>
</html>`
  }, [html])

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      const data = e.data as { type?: string; url?: string; height?: number } | null
      if (!data || typeof data !== 'object') return
      if (data.type === 'keyring:open-url' && data.url) {
        void openExternalUrl(data.url)
      } else if (data.type === 'keyring:height' && typeof data.height === 'number') {
        setHeight(Math.min(Math.max(data.height + 32, 200), 6000))
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      sandbox="allow-scripts allow-popups"
      style={{ width: '100%', height: `${height}px`, border: 'none', background: 'white' }}
      title="Email body"
    />
  )
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime()
  const diff = Date.now() - t
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`
  return new Date(iso).toLocaleDateString()
}
