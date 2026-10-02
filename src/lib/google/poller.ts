/**
 * Gmail poller — the engine behind the auto-popover.
 *
 * Lifecycle:
 *   - startGmailPoller() runs immediately, then every `intervalMs` (~10s), and
 *     again whenever the window becomes visible. Runs while hidden too: the
 *     main webview has background throttling disabled (tauri.conf.json) and
 *     the app holds an App Nap opt-out (lib.rs), see KEY-2FA-1.
 *   - Per account: bootstrap (first time) or incremental via history.
 *   - A tick never waits for a slow account: each account runs on its own
 *     (in-flight guard per account), so one account's bootstrap can't hold up
 *     another account's new mail (KEY-2FA-1).
 *   - Bootstrap takes the mailbox cursor from /profile FIRST, so incremental
 *     polling starts on the very next tick; the 200-message backfill of old
 *     mail runs separately at 'low' limiter priority.
 *   - Per new message: parse → detect → cache. If 2FA detected and we haven't
 *     popped this message before → call on2faDetected(); mark popped_at so
 *     we don't re-pop on the next tick.
 *
 * Failure modes per account, all silent (logged in dev):
 *   - 401 invalid_token → token refresh retried once; second 401 → mark
 *     account `needs_reauth` and skip until user re-links.
 *   - 429 rate limited → per-account exponential backoff (5/30/120s).
 *   - history cursor 404 (too old) → re-bootstrap on next tick.
 *   - generic network error → silent; retry next tick.
 */

import {
  GmailAuthError,
  GmailRateLimitError,
  getMessage,
  getProfileHistoryId,
  listHistory,
  listMessages,
  parseMessage,
  type GmailMessageRef,
  type ParsedMessage,
} from './gmail'
import type { RatePriority } from '../rateLimit'
import {
  GoogleOAuthError,
} from './oauth'
import {
  type EmailAccountRow,
  getAccessToken,
  listAccounts,
  updateHistoryCursor,
} from './tokens'
import {
  getAiInboxEnabled,
  getAnthropicApiKey,
  getAuthSenders,
  setMessageImportance,
  setPoppedAt,
  upsertCachedMessage,
} from '../email'
import { AUTO_POP_THRESHOLD, detectTwoFactor, type TwoFactorMatch } from './twoFactor'
import { classifyEmail } from '../ai/classifier'
import { markPopped, wasPopped } from './popLedger'

export interface PollerHandle {
  stop: () => void
}

export interface PollerCallbacks {
  on2faDetected: (
    account: EmailAccountRow,
    parsed: ParsedMessage,
    match: TwoFactorMatch,
  ) => void
  onError?: (account: EmailAccountRow | null, err: unknown) => void
  /**
   * KEY-2FA-2: the account list of every tick, so App.tsx can arm the Rust
   * Gmail watch that keeps popping codes once the vault locks.
   */
  onAccounts?: (accounts: EmailAccountRow[]) => void
}

interface PerAccountState {
  inFlight: boolean
  backoffUntil: number // ms epoch; 0 = no backoff
}

const BACKOFF_LADDER_MS = [5_000, 30_000, 120_000]

// A 2FA popover must only ever fire for an email that JUST arrived. A code you
// need "right now" is seconds-to-minutes old — never a week. This guards the
// pop against OLD emails that re-enter the new-message pipeline: Gmail expires
// history cursors after ~1 week, so when we re-bootstrap (or Gmail re-surfaces
// a message) a stale email can look "new". Real codes older than this window
// are expired anyway, so there's no value in popping them. The inbox still
// badges old 2FA emails — this only suppresses the intrusive popover.
const MAX_POP_AGE_MS = 10 * 60 * 1000 // 10 minutes

async function classifyInBackground(
  rowId: string,
  parsed: { subject: string; from: string; snippet: string; bodyText: string },
): Promise<void> {
  try {
    const enabled = await getAiInboxEnabled()
    if (!enabled) return
    const apiKey = await getAnthropicApiKey()
    if (!apiKey) return
    const result = await classifyEmail(
      {
        subject: parsed.subject,
        from: parsed.from,
        snippet: parsed.snippet,
        bodyText: parsed.bodyText,
      },
      apiKey,
    )
    await setMessageImportance(rowId, result.important, result.reason)
  } catch (err) {
    console.warn('[poller] AI classify failed (non-fatal):', err)
  }
}

export function startGmailPoller(opts: {
  dek: Uint8Array
  userId: string
  intervalMs?: number
  callbacks: PollerCallbacks
}): PollerHandle {
  const interval = opts.intervalMs ?? 10_000
  const state = new Map<string, PerAccountState>()
  const backoffStep = new Map<string, number>()
  const backfilling = new Set<string>()
  let stopped = false
  let timer: ReturnType<typeof setInterval> | null = null
  // Re-entrancy guard for the account listing only. Account polls are NOT
  // awaited by the tick (see header).
  let ticking = false
  // User's manual "always auth" sender list — refreshed each tick, read by the
  // per-message 2FA detection.
  let authSenders: string[] = []

  /**
   * Fetch, detect, cache one message. Pops the 2FA popover when the message
   * is a fresh insert, a confident 2FA match, not already popped, and
   * received at or after `popNotBefore` (ms epoch).
   */
  async function processMessage(
    account: EmailAccountRow,
    accessToken: string,
    ref: GmailMessageRef,
    popNotBefore: number,
    priority: RatePriority,
  ): Promise<void> {
    const full = await getMessage(accessToken, ref.id, priority)
    if (stopped) return
    const parsed = parseMessage(full)
    const match = detectTwoFactor(
      {
        subject: parsed.subject,
        from: parsed.from,
        snippet: parsed.snippet,
        bodyText: parsed.bodyText,
        bodyHtml: parsed.bodyHtml,
        labelIds: parsed.labelIds,
      },
      { authSenders },
    )
    const is2fa = !!match && match.confidence >= AUTO_POP_THRESHOLD
    const { inserted, row } = await upsertCachedMessage(
      opts.userId,
      account.id,
      parsed,
      is2fa,
      opts.dek,
    )

    // Fire-and-forget AI classification on FRESH inserts only.
    if (inserted) {
      void classifyInBackground(row.id, parsed)
    }

    if (!(inserted && is2fa && !row.popped_at)) return
    // A 2FA popover must only ever fire for an email that JUST arrived: never
    // for week-old mail re-surfaced by a cursor reset, never for mail that
    // existed before the account was linked (backfill passes its start time).
    const receivedMs = new Date(parsed.receivedAt).getTime()
    await setPoppedAt(row.id)
    if (wasPopped(parsed.id)) return // already popped while the vault was locked
    if (receivedMs >= popNotBefore && !stopped) {
      markPopped(parsed.id)
      try {
        opts.callbacks.on2faDetected(account, parsed, match!)
      } catch (cbErr) {
        console.warn('[poller] on2faDetected callback threw:', cbErr)
      }
    } else {
      console.debug(
        `[poller] suppressed stale 2FA popover for "${parsed.subject}" (received ${parsed.receivedAt})`,
      )
    }
  }

  /**
   * Bootstrap backfill: the newest 200 inbox messages so a newly-linked (or
   * re-bootstrapped) account has history in the inbox. 'low' priority, so it
   * never delays new mail. Does not hold the account's in-flight guard.
   */
  async function backfill(account: EmailAccountRow, accessToken: string, startedAt: number) {
    if (backfilling.has(account.id)) return
    backfilling.add(account.id)
    try {
      const { messages } = await listMessages(accessToken, 'in:inbox', 200, 'high')
      for (const ref of messages) {
        if (stopped) return
        try {
          // Pops only for mail that arrived after the bootstrap began.
          await processMessage(account, accessToken, ref, startedAt, 'low')
        } catch (msgErr) {
          console.warn(`[poller] backfill message ${ref.id} failed:`, msgErr)
        }
      }
    } catch (err) {
      console.warn(`[poller] ${account.email}: backfill failed:`, err)
    } finally {
      backfilling.delete(account.id)
    }
  }

  async function pollOne(account: EmailAccountRow): Promise<void> {
    const s = state.get(account.id) ?? { inFlight: false, backoffUntil: 0 }
    state.set(account.id, s)
    if (s.inFlight) return
    if (s.backoffUntil > Date.now()) return
    if (account.status !== 'ok') return

    s.inFlight = true
    try {
      const accessToken = await getAccessToken(account, opts.dek)

      if (!account.history_id) {
        // Bootstrap. Cursor first (one cheap call), so the next tick already
        // sees new mail; then backfill old mail in the background.
        const startedAt = Date.now()
        const historyId = await getProfileHistoryId(accessToken)
        await updateHistoryCursor(account.id, historyId)
        account.history_id = historyId
        void backfill(account, accessToken, startedAt)
      } else {
        const hist = await listHistory(accessToken, account.history_id)
        if (hist.tooOld) {
          // Cursor expired; re-bootstrap on the NEXT tick by nulling the cursor.
          await updateHistoryCursor(account.id, '') // empty string → treat as bootstrap
          return
        }
        // Newest first: in a burst, the code you are waiting for is usually
        // the last message added.
        const popNotBefore = Date.now() - MAX_POP_AGE_MS
        for (const ref of [...hist.added].reverse()) {
          if (stopped) return
          try {
            await processMessage(account, accessToken, ref, popNotBefore, 'high')
          } catch (msgErr) {
            console.warn(`[poller] message ${ref.id} failed:`, msgErr)
          }
        }
        if (hist.historyId && hist.historyId !== account.history_id) {
          await updateHistoryCursor(account.id, hist.historyId)
          account.history_id = hist.historyId
        }
      }

      // Reset backoff on success.
      backoffStep.delete(account.id)
      s.backoffUntil = 0
    } catch (err) {
      if (err instanceof GmailAuthError) {
        // getAccessToken should have refreshed before we got here; if Gmail
        // still says 401, the refresh token is dead.
        // (getAccessToken already marks needs_reauth on `invalid_grant`.)
        console.warn(`[poller] ${account.email}: auth error, may need reauth`)
      } else if (err instanceof GmailRateLimitError) {
        const step = backoffStep.get(account.id) ?? 0
        const wait = BACKOFF_LADDER_MS[Math.min(step, BACKOFF_LADDER_MS.length - 1)]
        backoffStep.set(account.id, step + 1)
        s.backoffUntil = Date.now() + wait
        console.warn(`[poller] ${account.email}: rate limited, backing off ${wait}ms`)
      } else if (err instanceof GoogleOAuthError && err.message === 'REAUTH_REQUIRED') {
        // Already handled by markNeedsReauth in tokens.ts.
        console.warn(`[poller] ${account.email}: marked needs_reauth`)
      } else {
        console.warn(`[poller] ${account.email}: tick failed:`, err)
        opts.callbacks.onError?.(account, err)
      }
    } finally {
      s.inFlight = false
    }
  }

  async function tick(): Promise<void> {
    if (stopped || ticking) return
    ticking = true
    let accounts: EmailAccountRow[] = []
    try {
      accounts = await listAccounts()
      authSenders = await getAuthSenders()
    } catch (listErr) {
      opts.callbacks.onError?.(null, listErr)
      return
    } finally {
      ticking = false
    }
    if (stopped) return
    try {
      opts.callbacks.onAccounts?.(accounts)
    } catch (armErr) {
      console.warn('[poller] onAccounts threw:', armErr)
    }
    // Deliberately not awaited: a slow account must not delay the others.
    for (const a of accounts) void pollOne(a)
  }

  const onVisible = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') void tick()
  }

  // Kick off immediately, then on interval.
  void tick()
  timer = setInterval(() => void tick(), interval)
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)

  return {
    stop() {
      stopped = true
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible)
      }
    },
  }
}
