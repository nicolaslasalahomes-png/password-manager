/**
 * KEY-2FA-2: the 2FA watch while the vault is locked.
 *
 * Nicolas (List 71, N55): "While the vault is locked yes, while its 2FA
 * locked no".
 *
 * Lock states in Keyring and what the Gmail watch does in each:
 *   signed out ............................ off, Rust tokens wiped
 *   email code owed (mfaPending: fresh
 *     sign-in or every app launch) ........ off, Rust tokens wiped
 *   vault locked (idle auto-lock, Lock) ... 'locked': keeps popping codes
 *   vault unlocked ........................ 'unlocked': the full poller
 *
 * While locked this watch only reads new mail, detects a code and pops it.
 * It holds no DEK and no Gmail token: every Gmail call goes through Rust
 * (desktop.ts gmailWatchGet), which adds the token. It writes nothing to
 * Supabase (no cache, no cursor, no popped_at): the unlocked poller picks
 * those messages up from the stored cursor after unlock and fills the
 * inbox, and the shared pop ledger stops a second pop.
 */

import type { VaultStatus } from '../../state/VaultContext'
import {
  GmailAuthError,
  GmailRateLimitError,
  getMessage,
  getProfileHistoryId,
  listHistory,
  parseMessage,
  type GmailFetcher,
  type ParsedMessage,
} from './gmail'
import { AUTO_POP_THRESHOLD, detectTwoFactor, type TwoFactorMatch } from './twoFactor'
import { markPopped, wasPopped } from './popLedger'
import type { AccountCursorRow } from './tokens'
import type { TwoFactorPayload } from '../desktop'

export type WatchMode = 'off' | 'locked' | 'unlocked'

/** The mapping above, as code. */
export function watchModeFor(s: {
  desktop: boolean
  signedIn: boolean
  mfaPending: boolean
  vault: VaultStatus
}): WatchMode {
  if (!s.desktop || !s.signedIn || s.mfaPending) return 'off'
  if (s.vault === 'unlocked') return 'unlocked'
  if (s.vault === 'locked') return 'locked'
  return 'off'
}

/** True when Keyring is in the stronger (account 2FA) lock: hold no tokens. */
export function mustWipeGmailTokens(s: {
  authLoading: boolean
  signedIn: boolean
  mfaPending: boolean
}): boolean {
  return !s.authLoading && (!s.signedIn || s.mfaPending)
}

/** Same rule as the unlocked poller: only pop mail that just arrived. */
export const LOCKED_MAX_POP_AGE_MS = 10 * 60 * 1000
const AUTH_BACKOFF_MS = 60_000
const BACKOFF_LADDER_MS = [5_000, 30_000, 120_000]

export interface LockedWatchDeps {
  /** Ids of the accounts Rust holds tokens for. */
  armedAccountIds: () => Promise<string[]>
  /** Account email + stored cursor, no secret columns. */
  listAccountCursors: () => Promise<AccountCursorRow[]>
  /** A Gmail GET for one account, token added by Rust. */
  fetcherFor: (accountId: string) => GmailFetcher
  getAuthSenders: () => Promise<string[]>
}

export interface LockedWatchCallbacks {
  on2faDetected: (
    account: { id: string; email: string },
    parsed: ParsedMessage,
    match: TwoFactorMatch,
  ) => void
}

export interface LockedWatchHandle {
  stop: () => void
  /** Test hook: run one tick and wait for every account poll to finish. */
  tickNow: () => Promise<void>
}

interface Tracked {
  id: string
  email: string
  cursor: string | null
  inFlight: boolean
  backoffUntil: number
  backoffStep: number
}

export function startLockedGmailWatch(opts: {
  deps: LockedWatchDeps
  callbacks: LockedWatchCallbacks
  intervalMs?: number
  /** Default true. Tests drive ticks themselves. */
  autoStart?: boolean
  now?: () => number
}): LockedWatchHandle {
  const interval = opts.intervalMs ?? 10_000
  const now = opts.now ?? Date.now
  const tracked = new Map<string, Tracked>()
  let stopped = false
  let ticking = false
  let authSenders: string[] = []
  let timer: ReturnType<typeof setInterval> | null = null

  async function syncAccounts(): Promise<void> {
    const armed = await opts.deps.armedAccountIds()
    const armedSet = new Set(armed)
    for (const id of [...tracked.keys()]) if (!armedSet.has(id)) tracked.delete(id)
    const missing = armed.filter((id) => !tracked.has(id))
    if (missing.length === 0) return
    const rows = await opts.deps.listAccountCursors()
    for (const r of rows) {
      if (!missing.includes(r.id) || r.status !== 'ok') continue
      tracked.set(r.id, {
        id: r.id,
        email: r.email,
        cursor: r.history_id || null,
        inFlight: false,
        backoffUntil: 0,
        backoffStep: 0,
      })
    }
  }

  async function pollOne(t: Tracked): Promise<void> {
    if (t.inFlight || t.backoffUntil > now()) return
    t.inFlight = true
    const fetcher = opts.deps.fetcherFor(t.id)
    try {
      if (!t.cursor) {
        // No stored cursor: start from now, in memory only.
        t.cursor = await getProfileHistoryId(fetcher)
        return
      }
      const hist = await listHistory(fetcher, t.cursor)
      if (hist.tooOld) {
        t.cursor = await getProfileHistoryId(fetcher)
        return
      }
      const popNotBefore = now() - LOCKED_MAX_POP_AGE_MS
      for (const ref of [...hist.added].reverse()) {
        if (stopped) return
        if (wasPopped(ref.id)) continue
        try {
          const parsed = parseMessage(await getMessage(fetcher, ref.id, 'high'))
          if (stopped) return
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
          if (!match || match.confidence < AUTO_POP_THRESHOLD) continue
          if (new Date(parsed.receivedAt).getTime() < popNotBefore) continue
          markPopped(parsed.id)
          try {
            opts.callbacks.on2faDetected({ id: t.id, email: t.email }, parsed, match)
          } catch (cbErr) {
            console.warn('[locked-watch] on2faDetected threw:', cbErr)
          }
        } catch (msgErr) {
          if (msgErr instanceof GmailAuthError || msgErr instanceof GmailRateLimitError) throw msgErr
          console.warn(`[locked-watch] message ${ref.id} failed:`, msgErr)
        }
      }
      t.cursor = hist.historyId || t.cursor
      t.backoffStep = 0
    } catch (err) {
      if (err instanceof GmailAuthError) {
        t.backoffUntil = now() + AUTH_BACKOFF_MS
      } else if (err instanceof GmailRateLimitError) {
        const wait = BACKOFF_LADDER_MS[Math.min(t.backoffStep, BACKOFF_LADDER_MS.length - 1)]
        t.backoffStep += 1
        t.backoffUntil = now() + wait
      } else {
        console.warn(`[locked-watch] ${t.email}: tick failed:`, err)
      }
    } finally {
      t.inFlight = false
    }
  }

  async function tick(): Promise<Promise<void>[]> {
    if (stopped || ticking) return []
    ticking = true
    try {
      await syncAccounts()
      authSenders = await opts.deps.getAuthSenders().catch(() => authSenders)
    } catch (err) {
      console.warn('[locked-watch] account sync failed:', err)
      return []
    } finally {
      ticking = false
    }
    if (stopped) return []
    // Not awaited by the timer: one slow account must not hold up the others.
    return [...tracked.values()].map((t) => pollOne(t))
  }

  const onVisible = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') void tick()
  }

  if (opts.autoStart !== false) {
    void tick()
    timer = setInterval(() => void tick(), interval)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
  }

  return {
    stop() {
      stopped = true
      if (timer !== null) clearInterval(timer)
      timer = null
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
    },
    async tickNow() {
      await Promise.all(await tick())
    },
  }
}

/**
 * The 2FA popover payload: sender, subject, code, link. Nothing from the
 * vault, so it is safe to show while the vault is locked.
 */
export function popoverPayloadFor(
  account: { id: string; email: string },
  parsed: ParsedMessage,
  match: TwoFactorMatch,
): TwoFactorPayload {
  return {
    gmailMessageId: parsed.id,
    accountId: account.id,
    accountEmail: account.email,
    fromName: parsed.fromName,
    subject: parsed.subject,
    code: match.code,
    magicLink: match.link,
    receivedAt: parsed.receivedAt,
  }
}

