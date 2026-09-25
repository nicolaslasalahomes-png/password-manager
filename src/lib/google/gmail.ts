/**
 * Gmail REST API client. Raw fetch (no `googleapis` npm package — too heavy
 * for a Tauri bundle, and we only need 5 endpoints).
 *
 * All calls assume the caller already obtained a valid access token via
 * tokens.ts → getAccessToken. We throw a typed `GmailAuthError` on 401 so
 * the poller can retry once with a refreshed token and then give up.
 */

import { createRateLimiter } from '../rateLimit'

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

/**
 * Global Gmail API rate limiter — max 40 calls/minute across ALL accounts.
 * Prevents the bootstrap (one getMessage per ~200 messages × N accounts) from
 * bursting into Gmail's per-user rate limit. Shared module-level instance so
 * concurrent account polls draw from the same budget.
 */
const gmailLimiter = createRateLimiter(40)

export class GmailAuthError extends Error {
  constructor() {
    super('Gmail returned 401 (token expired or revoked)')
    this.name = 'GmailAuthError'
  }
}

export class GmailRateLimitError extends Error {
  constructor() {
    super('Gmail returned 429 (rate limited)')
    this.name = 'GmailRateLimitError'
  }
}

export interface GmailMessageRef {
  id: string
  threadId: string
}

interface GmailHeader {
  name: string
  value: string
}

interface GmailPart {
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: { size?: number; data?: string; attachmentId?: string }
  parts?: GmailPart[]
}

export interface GmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  internalDate?: string // ms-since-epoch string
  payload?: GmailPart
}

export interface ParsedMessage {
  id: string
  threadId: string
  subject: string
  fromName: string
  from: string // bare email address
  snippet: string
  bodyText: string
  /** Original HTML body (best effort). Empty when the message is plain-text-only. */
  bodyHtml: string
  receivedAt: string // ISO
  labelIds: string[]
}

interface HistoryResponse {
  history?: Array<{
    id: string
    messages?: GmailMessageRef[]
    messagesAdded?: Array<{ message: GmailMessageRef }>
  }>
  historyId?: string
}

async function gfetch(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  await gmailLimiter()
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${accessToken}`)
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const resp = await fetch(`${BASE}${path}`, { ...init, headers })
  if (resp.status === 401) throw new GmailAuthError()
  if (resp.status === 429) throw new GmailRateLimitError()
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Gmail ${path} failed (${resp.status}): ${text.slice(0, 200)}`)
  }
  return resp
}

/** List messages by query. Used only for the bootstrap fetch (first link). */
export async function listMessages(
  accessToken: string,
  q?: string,
  maxResults = 50,
): Promise<{ messages: GmailMessageRef[]; latestHistoryId?: string }> {
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  params.set('maxResults', String(maxResults))
  const resp = await gfetch(accessToken, `/messages?${params}`)
  const json = (await resp.json()) as { messages?: GmailMessageRef[]; resultSizeEstimate?: number }
  return { messages: json.messages ?? [] }
}

export async function getMessage(accessToken: string, id: string): Promise<GmailMessage> {
  // format=full returns headers + body parts. metadata-only would mean a second
  // call to read the body; one call is simpler.
  const resp = await gfetch(accessToken, `/messages/${id}?format=full`)
  return (await resp.json()) as GmailMessage
}

/**
 * Incremental fetch — returns messages added since `startHistoryId`. The
 * `historyId` in the response is the new cursor. If Gmail says the history
 * cursor is too old (404), the caller should re-bootstrap via listMessages.
 */
export async function listHistory(
  accessToken: string,
  startHistoryId: string,
): Promise<{ historyId: string; added: GmailMessageRef[]; tooOld: boolean }> {
  const params = new URLSearchParams({
    startHistoryId,
    historyTypes: 'messageAdded',
  })
  await gmailLimiter()
  const resp = await fetch(`${BASE}/history?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (resp.status === 401) throw new GmailAuthError()
  if (resp.status === 429) throw new GmailRateLimitError()
  if (resp.status === 404) {
    // History cursor expired (Gmail keeps ~1 week). Caller should re-bootstrap.
    return { historyId: startHistoryId, added: [], tooOld: true }
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Gmail /history failed (${resp.status}): ${text.slice(0, 200)}`)
  }
  const json = (await resp.json()) as HistoryResponse
  const added: GmailMessageRef[] = []
  const seen = new Set<string>()
  for (const h of json.history ?? []) {
    for (const m of h.messagesAdded ?? []) {
      if (!seen.has(m.message.id)) {
        seen.add(m.message.id)
        added.push(m.message)
      }
    }
  }
  return {
    historyId: json.historyId ?? startHistoryId,
    added,
    tooOld: false,
  }
}

/** Archive = remove the INBOX label. */
export async function archive(accessToken: string, id: string): Promise<void> {
  await gfetch(accessToken, `/messages/${id}/modify`, {
    method: 'POST',
    body: JSON.stringify({ removeLabelIds: ['INBOX'] }),
  })
}

/** Trash = move to the trash folder (recoverable for 30 days in Gmail). */
export async function trash(accessToken: string, id: string): Promise<void> {
  await gfetch(accessToken, `/messages/${id}/trash`, { method: 'POST' })
}

// ── Parsing ────────────────────────────────────────────────────────────────

function headerValue(headers: GmailHeader[] | undefined, name: string): string {
  if (!headers) return ''
  const lower = name.toLowerCase()
  for (const h of headers) {
    if (h.name.toLowerCase() === lower) return h.value
  }
  return ''
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function decodePart(part: GmailPart): string {
  const data = part.body?.data
  if (!data) return ''
  // Charset from part headers; default utf-8. We don't currently handle exotic
  // ones (Shift_JIS, ISO-8859-*) — TextDecoder will throw "fatal" if not
  // supported; we catch and fall back to utf-8.
  let charset = 'utf-8'
  const ct = headerValue(part.headers, 'Content-Type')
  const cm = /charset\s*=\s*"?([^";\s]+)/i.exec(ct)
  if (cm) charset = cm[1]
  const bytes = b64urlToBytes(data)
  try {
    return new TextDecoder(charset).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

function walkForBody(part: GmailPart): { text: string; html: string } {
  let text = ''
  let html = ''
  const visit = (p: GmailPart) => {
    if (p.mimeType === 'text/plain' && p.body?.data && !text) {
      text = decodePart(p)
    } else if (p.mimeType === 'text/html' && p.body?.data && !html) {
      html = decodePart(p)
    }
    for (const child of p.parts ?? []) visit(child)
  }
  visit(part)
  return { text, html }
}

/**
 * Decode HTML entities (named + numeric, decimal + hex) using a throwaway
 * textarea — the browser's parser handles every entity correctly for free.
 */
function decodeHtmlEntities(s: string): string {
  if (typeof document === 'undefined') {
    // SSR / Node fallback (we don't really hit this in Tauri, but be safe).
    return s
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
  }
  const ta = document.createElement('textarea')
  ta.innerHTML = s
  return ta.value
}

function stripHtml(html: string): string {
  const stripped = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  return decodeHtmlEntities(stripped)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function parseFromHeader(raw: string): { fromName: string; from: string } {
  // "Name <email@host>" or "email@host"
  const m = /^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$/.exec(raw)
  if (m) return { fromName: m[1]?.trim() || m[2], from: m[2] }
  return { fromName: raw.trim(), from: raw.trim() }
}

/** Full message → flat parsed shape used by the cache, detector, and UI. */
export function parseMessage(msg: GmailMessage): ParsedMessage {
  const subject = headerValue(msg.payload?.headers, 'Subject')
  const fromRaw = headerValue(msg.payload?.headers, 'From')
  const { fromName, from } = parseFromHeader(fromRaw)
  const { text, html } = msg.payload ? walkForBody(msg.payload) : { text: '', html: '' }
  const bodyText = text || stripHtml(html)
  const receivedAt = msg.internalDate
    ? new Date(Number(msg.internalDate)).toISOString()
    : new Date().toISOString()
  return {
    id: msg.id,
    threadId: msg.threadId,
    subject: subject || '(no subject)',
    fromName,
    from,
    snippet: decodeHtmlEntities(msg.snippet ?? ''),
    bodyText,
    bodyHtml: html,
    receivedAt,
    labelIds: msg.labelIds ?? [],
  }
}
