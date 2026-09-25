/**
 * Daily briefing — a once-per-day "here's what to focus on" written by Claude
 * from the user's open tasks + notable emails since the LAST brief.
 *
 * Design honoring the user's requirements:
 *   - Generated only on the first app-open of a calendar day (caller gates on
 *     isNewDaySince + the most recent stored brief).
 *   - The window is "since the last brief", so missed days roll forward into
 *     one catch-up brief rather than being skipped.
 *   - The "last briefed" timestamp lives in Supabase (per account), so it
 *     survives reinstalls and isn't device-local.
 *   - Brief content is AES-GCM encrypted with the DEK before storage — the
 *     server never sees task/email text. Only timestamps are plaintext.
 *
 * Privacy: generating a brief sends task titles + email subjects/senders to
 * Anthropic. It NEVER sends secret field values (passwords, keys). Off by
 * default; the user opts in.
 */

import { supabase } from './supabase'
import { decryptJson, encryptJson } from './encryption'
import { getStoreValue, setStoreValue } from './desktop'
import { listOpenTasks } from './tasks'
import { decryptCachedPayload, getAnthropicApiKey, listCachedMessages, senderEmail } from './email'
import { callClaude } from './ai/anthropic'

/** Keyring's own 2FA emails are sent from here — never surface them in a brief. */
const KEYRING_SENDER = 'keyring@coralautos.com'

const ENABLED_KEY = 'dailyBriefingEnabled'
const SEEN_KEY = 'briefingLastSeenAt'

export interface Briefing {
  id: string
  generated_at: string
  period_start: string | null
  content: string
}

interface BriefingRow {
  id: string
  generated_at: string
  period_start: string | null
  encrypted_content: string
  iv: string
}

const SYSTEM_PROMPT = `You are a concise daily planning assistant for a busy solo developer who juggles several projects and email accounts. Given their open tasks (with due dates + priorities) and notable emails received since their last check-in, write a short morning brief telling them what to focus on.

Rules:
- Under 160 words.
- Open with ONE sentence naming the single most important thing today.
- Then a short bulleted list (use "•") in priority order: overdue first, then high priority, then upcoming.
- Call out any email that likely needs a reply.
- Be direct, practical, lightly motivating. No fluff, no preamble like "Here is your brief".
- Output PLAIN TEXT only — no markdown symbols (#, *, backticks). Use "•" for bullets.
- Never invent tasks or emails that aren't in the data.
- CRITICAL: use the due dates EXACTLY as written in the data. Never compute, infer, or restate the day of the week yourself — copy the date string as given. If a task says "Friday, Jun 5", never call it Thursday.
- Never mention verification codes, 2FA codes, or sign-in/login codes. They are transient and handled elsewhere — they are never action items.`

export async function getBriefingEnabled(): Promise<boolean> {
  return (await getStoreValue<boolean>(ENABLED_KEY)) ?? false
}
export async function setBriefingEnabled(v: boolean): Promise<void> {
  await setStoreValue(ENABLED_KEY, v)
}

/** Most recent brief's timestamp for this account (null if never). */
export async function getLastBriefingMeta(): Promise<{ generated_at: string } | null> {
  const { data, error } = await supabase
    .from('daily_briefings')
    .select('generated_at')
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.warn('[briefing] getLastBriefingMeta failed', error)
    return null
  }
  return data ? { generated_at: (data as { generated_at: string }).generated_at } : null
}

/** True if `lastIso` is on an earlier calendar day than now (local time), or null. */
export function isNewDaySince(lastIso: string | null): boolean {
  if (!lastIso) return true
  const key = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
  return key(new Date(lastIso)) !== key(new Date())
}

/**
 * Build + store a brief covering the period since the last one. Returns it.
 * Throws if no Anthropic key is configured.
 */
export async function generateBriefing(userId: string, dek: Uint8Array): Promise<Briefing> {
  const apiKey = await getAnthropicApiKey()
  if (!apiKey) {
    throw new Error('Set your Anthropic API key (Inbox Settings) to enable daily briefings.')
  }

  const last = await getLastBriefingMeta()
  const periodStart = last?.generated_at ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  // Open tasks (titles + due/priority are plaintext columns). Pre-format the
  // due date WITH the weekday so the model never has to compute day-of-week.
  const tasks = await listOpenTasks()
  const now = Date.now()
  const fmtDue = (d: Date) =>
    d.toLocaleString(undefined, {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  const taskLines = tasks
    .map((t) => {
      const due = t.due_at ? new Date(t.due_at) : null
      const overdue = due ? due.getTime() < now : false
      return `- ${t.title} [priority: ${t.priority ?? 'n/a'}${
        due ? `, due ${fmtDue(due)}${overdue ? ' (OVERDUE)' : ''}` : ', no due date'
      }]`
    })
    .join('\n')

  // Important emails since the last brief (requires the AI classifier to have
  // run; if it hasn't, this is just empty and the brief is task-only).
  let emailLines = ''
  try {
    const msgs = await listCachedMessages({ limit: 500 })
    const since = new Date(periodStart).getTime()
    const important = msgs
      .filter(
        (m) =>
          m.is_important === true &&
          !m.is_2fa_candidate && // codes are transient, never "to read"
          senderEmail(m.sender) !== KEYRING_SENDER && // our own 2FA emails
          new Date(m.received_at).getTime() > since,
      )
      .slice(0, 15)
    const decoded = await Promise.all(
      important.map(async (m) => {
        try {
          const p = await decryptCachedPayload(m, dek)
          return `- ${m.sender ?? 'unknown'}: ${p.subject}`
        } catch {
          return null
        }
      }),
    )
    emailLines = decoded.filter(Boolean).join('\n')
  } catch (err) {
    console.warn('[briefing] email gather failed (non-fatal)', err)
  }

  const userMsg = `Right now it is ${new Date().toLocaleString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })}. Use this as "today" when judging what's due soon or overdue.

Open tasks:
${taskLines || '(none)'}

Notable emails since last brief:
${emailLines || '(none)'}`

  const content = await callClaude({
    apiKey,
    system: SYSTEM_PROMPT,
    maxTokens: 400,
    messages: [{ role: 'user', content: userMsg }],
  })

  const { ciphertext, iv } = await encryptJson(content, dek)
  const { data, error } = await supabase
    .from('daily_briefings')
    .insert({
      user_id: userId,
      generated_at: new Date().toISOString(),
      period_start: periodStart,
      encrypted_content: ciphertext,
      iv,
    })
    .select('id, generated_at, period_start, encrypted_content, iv')
    .single()
  if (error) throw error
  const row = data as BriefingRow
  return { id: row.id, generated_at: row.generated_at, period_start: row.period_start, content }
}

/** Decrypt the full history (newest first) for the Briefing tab. */
export async function listBriefings(dek: Uint8Array, limit = 120): Promise<Briefing[]> {
  const { data, error } = await supabase
    .from('daily_briefings')
    .select('id, generated_at, period_start, encrypted_content, iv')
    .order('generated_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  const out: Briefing[] = []
  for (const row of (data ?? []) as BriefingRow[]) {
    try {
      out.push({
        id: row.id,
        generated_at: row.generated_at,
        period_start: row.period_start,
        content: await decryptJson<string>(row.encrypted_content, row.iv, dek),
      })
    } catch {
      /* skip undecryptable */
    }
  }
  return out
}

// ── "Unseen brief" tracking (local) — drives the sidebar dot ─────────────────
export async function getBriefingLastSeen(): Promise<string | null> {
  return (await getStoreValue<string>(SEEN_KEY)) ?? null
}
export async function markBriefingsSeen(ts: Date = new Date()): Promise<void> {
  await setStoreValue(SEEN_KEY, ts.toISOString())
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('keyring:briefing-changed'))
  }
}
/** True if the newest brief is newer than the last time the user opened the tab. */
export async function hasUnseenBriefing(): Promise<boolean> {
  const [last, seen] = await Promise.all([getLastBriefingMeta(), getBriefingLastSeen()])
  if (!last) return false
  if (!seen) return true
  return new Date(last.generated_at).getTime() > new Date(seen).getTime()
}

/** Decrypt the most recent brief for re-reading. */
export async function getLatestBriefing(dek: Uint8Array): Promise<Briefing | null> {
  const { data, error } = await supabase
    .from('daily_briefings')
    .select('id, generated_at, period_start, encrypted_content, iv')
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error || !data) return null
  const row = data as BriefingRow
  try {
    const content = await decryptJson<string>(row.encrypted_content, row.iv, dek)
    return { id: row.id, generated_at: row.generated_at, period_start: row.period_start, content }
  } catch {
    return null
  }
}
