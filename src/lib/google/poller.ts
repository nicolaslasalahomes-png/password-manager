/**
 * Gmail poller — the engine behind the auto-popover.
 *
 * Lifecycle:
 *   - startGmailPoller() runs immediately, then every `intervalMs` (~10s).
 *   - Skips ticks while document.hidden (window minimized / app backgrounded).
 *   - Per account: bootstrap (first time) or incremental via history.
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
  listHistory,
  listMessages,
  parseMessage,
  type ParsedMessage,
} from './gmail'
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
  let backoffStep = new Map<string, number>()
  let stopped = false
  let timer: number | null = null
  // Re-entrancy guard so a slow tick doesn't overlap with the next interval fire.
  let ticking = false
  // User's manual "always auth" sender list — refreshed each tick, read by the
  // per-message 2FA detection inside pollOne.
  let authSenders: string[] = []

  function shouldSkipThisTick(): boolean {
    // Previously paused on document.hidden so the poller only ran when Keyring
    // had focus. Removed — the user explicitly wants 24/7 background polling so
    // the 2FA popover fires while they're working in other apps. The Tauri tray
    // icon keeps the process alive even when the main window is hidden.
    //
    // Trade-offs at this cadence (10s tick × ~6 accounts × ~5 quota units = ~3
    // quota/sec): well under Gmail's per-user 250/sec cap and trivial CPU.
    return false
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

      let newMessageRefs: { id: string; threadId: string }[] = []
      let nextHistoryId: string | null = null

      if (!account.history_id) {
        // Bootstrap — read the latest 200 inbox messages so newly-linked
        // accounts start with substantive history. Do NOT auto-pop (these
        // existed before the user linked the account).
        const { messages } = await listMessages(accessToken, 'in:inbox', 200)
        newMessageRefs = messages
        // We'll set the cursor from the first message we fetch, since the
        // listMessages response doesn't include historyId.
      } else {
        const hist = await listHistory(accessToken, account.history_id)
        if (hist.tooOld) {
          // Cursor expired; re-bootstrap on the NEXT tick by nulling the cursor.
          await updateHistoryCursor(account.id, '') // empty string → treat as bootstrap
          return
        }
        newMessageRefs = hist.added
        nextHistoryId = hist.historyId
      }

      // Process each new message ref.
      for (const ref of newMessageRefs) {
        try {
          const full = await getMessage(accessToken, ref.id)
          const parsed = parseMessage(full)
          // historyId from a getMessage call isn't returned; we use the
          // listHistory's nextHistoryId, or for bootstrap we leave it and
          // fetch fresh on next tick.
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

          // Fire-and-forget AI classification on FRESH inserts only. The
          // poller doesn't await this; the importance flag lands in the DB
          // a few hundred ms later and the inbox UI picks it up on next refresh.
          if (inserted) {
            void classifyInBackground(row.id, parsed)
          }

          // Pop only on FRESH inserts (not on re-fetches of bootstrap rows),
          // only when we have a real cursor (i.e., not bootstrap), only if not
          // already popped — AND only if the email actually just arrived. The
          // freshness check is what stops week-old emails from popping when the
          // history cursor expires and we re-bootstrap.
          const fresh =
            new Date(parsed.receivedAt).getTime() >= Date.now() - MAX_POP_AGE_MS
          if (
            inserted &&
            is2fa &&
            !row.popped_at &&
            account.history_id // never pop on the first-ever bootstrap
          ) {
            if (fresh) {
              await setPoppedAt(row.id)
              try {
                opts.callbacks.on2faDetected(account, parsed, match!)
              } catch (cbErr) {
                console.warn('[poller] on2faDetected callback threw:', cbErr)
              }
            } else {
              // Stale 2FA email surfaced as "new" (cursor reset / re-surface).
              // Mark it popped so it never queues, but don't show the popover.
              await setPoppedAt(row.id)
              console.debug(
                `[poller] suppressed stale 2FA popover for "${parsed.subject}" (received ${parsed.receivedAt})`,
              )
            }
          }
        } catch (msgErr) {
          // Individual message failure — log and continue with the next.
          console.warn(`[poller] message ${ref.id} failed:`, msgErr)
        }
      }

      // After the bootstrap pass, set history_id so future ticks use incremental.
      if (!account.history_id && newMessageRefs.length > 0) {
        // Re-fetch one message to grab its historyId — Gmail's bootstrap APIs
        // don't return a global cursor. Cheap (1 unit).
        try {
          const probe = await getMessage(accessToken, newMessageRefs[0].id)
          // The message object includes `historyId` on it. (It's typed loosely
          // here; cast.)
          const probeHistoryId = (probe as unknown as { historyId?: string }).historyId
          if (probeHistoryId) {
            await updateHistoryCursor(account.id, probeHistoryId)
            account.history_id = probeHistoryId // mutate locally so we don't re-bootstrap next tick
          }
        } catch (probeErr) {
          console.warn('[poller] could not set history cursor after bootstrap:', probeErr)
        }
      } else if (nextHistoryId && nextHistoryId !== account.history_id) {
        await updateHistoryCursor(account.id, nextHistoryId)
        account.history_id = nextHistoryId
      }

      // Reset backoff on success.
      backoffStep.delete(account.id)
      s.backoffUntil = 0
    } catch (err) {
      if (err instanceof GmailAuthError) {
        // getAccessToken should have refreshed before we got here; if Gmail
        // still says 401, the refresh token is dead. Try one explicit re-fetch.
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
    if (shouldSkipThisTick()) return
    ticking = true
    try {
      let accounts: EmailAccountRow[] = []
      try {
        accounts = await listAccounts()
        authSenders = await getAuthSenders()
      } catch (listErr) {
        opts.callbacks.onError?.(null, listErr)
        return
      }
      await Promise.allSettled(accounts.map((a) => pollOne(a)))
    } finally {
      ticking = false
    }
  }

  // Kick off immediately, then on interval.
  void tick()
  timer = window.setInterval(() => void tick(), interval)

  return {
    stop() {
      stopped = true
      if (timer !== null) {
        window.clearInterval(timer)
        timer = null
      }
    },
  }
}
