/**
 * Encrypted cache of fetched Gmail messages.
 *
 * `email_message_cache` row layout:
 *   - Plaintext metadata: gmail_message_id (PK dedup), thread_id, sender,
 *     received_at, is_2fa_candidate, popped_at.
 *   - Encrypted blob: { subject, snippet, body_text } JSON, AES-GCM under DEK.
 *   - Encrypted header: { subject, snippet, fromName, labelIds } only, ~300 B,
 *     same DEK. The inbox list reads THIS, never the payload: the payloads
 *     average ~48 KB (full HTML), and selecting 1,000 of them (44 MB) on every
 *     inbox open timed out and took the nano database down (2026-09-30,
 *     KEY-PERF-1). Bodies are fetched one row at a time when a message opens.
 *
 * Why some metadata stays plaintext: the dedup index needs `gmail_message_id`,
 * the inbox query orders by `received_at`, and `popped_at` gates re-popping
 * the same email. Sender is plaintext because Google already sees it and we
 * want fast filtering. Subject + body stay zero-knowledge.
 */

import { supabase } from './supabase'
import { decryptJson, encryptJson } from './encryption'
import type { ParsedMessage } from './google/gmail'

/** Plaintext row metadata plus the small encrypted header. No body. */
export interface CachedMessageMeta {
  id: string
  user_id: string
  account_id: string
  gmail_message_id: string
  thread_id: string
  received_at: string
  sender: string | null
  is_2fa_candidate: boolean
  iv_payload: string
  /** Null on rows written before headers existed; backfilled by the inbox. */
  encrypted_header: string | null
  iv_header: string | null
  popped_at: string | null
  created_at: string
  /** AI classification: true = worth reading, false = noise, null = not yet classified. */
  is_important: boolean | null
  classified_at: string | null
  classification_reason: string | null
}

/** A row including the full encrypted body. Only ever fetched by id. */
export interface CachedMessageRow extends CachedMessageMeta {
  encrypted_payload: string
}

/** What the inbox list needs to render a row. */
export interface CachedMessageHeader {
  subject: string
  snippet: string
  fromName: string
  labelIds: string[]
}

export interface CachedMessagePayload {
  subject: string
  snippet: string
  bodyText: string
  /** Original HTML body. Empty for legacy cache entries (re-fetched on demand). */
  bodyHtml?: string
  fromName: string
  labelIds: string[]
}

export interface DecryptedCachedMessage extends CachedMessagePayload {
  id: string
  account_id: string
  gmail_message_id: string
  thread_id: string
  received_at: string
  sender: string | null
  is_2fa_candidate: boolean
  popped_at: string | null
}

/** Everything except encrypted_payload. Safe to select in bulk. */
const META_COLUMNS =
  'id, user_id, account_id, gmail_message_id, thread_id, received_at, sender, is_2fa_candidate, iv_payload, encrypted_header, iv_header, popped_at, created_at, is_important, classified_at, classification_reason'

/** Rows per request for bulk metadata reads (PostgREST caps a response at 1,000). */
const PAGE = 500
/** Rows per request when bodies are needed in bulk (~48 KB each on average). */
const PAYLOAD_BATCH = 10

function headerOf(p: CachedMessagePayload): CachedMessageHeader {
  return { subject: p.subject, snippet: p.snippet, fromName: p.fromName, labelIds: p.labelIds }
}

/**
 * Upsert a parsed message into the cache. Returns true if the row was newly
 * inserted (so the caller knows it's a fresh email that may warrant a popup),
 * false if it was an update of an existing row.
 */
export async function upsertCachedMessage(
  userId: string,
  accountId: string,
  parsed: ParsedMessage,
  is2faCandidate: boolean,
  dek: Uint8Array,
): Promise<{ inserted: boolean; row: CachedMessageMeta }> {
  // Check existence first so we can report inserted-vs-updated.
  const { data: existing } = await supabase
    .from('email_message_cache')
    .select('id, popped_at')
    .eq('user_id', userId)
    .eq('gmail_message_id', parsed.id)
    .maybeSingle()

  const payload: CachedMessagePayload = {
    subject: parsed.subject,
    snippet: parsed.snippet,
    bodyText: parsed.bodyText,
    bodyHtml: parsed.bodyHtml,
    fromName: parsed.fromName,
    labelIds: parsed.labelIds,
  }
  const { ciphertext, iv } = await encryptJson(payload, dek)
  const header = await encryptJson(headerOf(payload), dek)

  const upsertRow = {
    user_id: userId,
    account_id: accountId,
    gmail_message_id: parsed.id,
    thread_id: parsed.threadId,
    received_at: parsed.receivedAt,
    sender: parsed.from,
    is_2fa_candidate: is2faCandidate,
    encrypted_payload: ciphertext,
    iv_payload: iv,
    encrypted_header: header.ciphertext,
    iv_header: header.iv,
  }
  // Don't echo the ~48 KB payload back; the caller has it already.
  const { data, error } = await supabase
    .from('email_message_cache')
    .upsert(upsertRow, { onConflict: 'user_id,gmail_message_id' })
    .select(META_COLUMNS)
    .single()
  if (error) throw error
  return { inserted: !existing, row: data as CachedMessageMeta }
}

/**
 * Count cached messages received strictly after `sinceIso`. Uses a HEAD count
 * query — the response carries ONLY the number (in a Content-Range header),
 * never any row bodies.
 *
 * This exists because the sidebar unread badge used to call listCachedMessages
 * (which pulls every row INCLUDING the encrypted email body, ~28 KB each) on a
 * 15s timer, 24/7. That dragged the entire ~12 MB cache across the wire every
 * 15 seconds and blew Supabase's 5 GB/month egress quota in hours, which
 * restricted the whole project. A count query is a few bytes. (v0.5.6 fix.)
 */
export async function countCachedSince(sinceIso: string): Promise<number> {
  const { count, error } = await supabase
    .from('email_message_cache')
    .select('id', { count: 'exact', head: true })
    .gt('received_at', sinceIso)
  if (error) throw error
  return count ?? 0
}

/**
 * Newest-first metadata + encrypted headers, paged past PostgREST's silent
 * 1,000-row cap. Never includes bodies. `onPage` lets the inbox paint the
 * first page before the rest arrive.
 */
export async function listCachedMessages(opts: {
  accountId?: string | null
  limit?: number
  onPage?: (rowsSoFar: CachedMessageMeta[]) => void
} = {}): Promise<CachedMessageMeta[]> {
  const limit = opts.limit ?? 100
  const out: CachedMessageMeta[] = []
  while (out.length < limit) {
    const from = out.length
    const to = Math.min(from + PAGE, limit) - 1
    let query = supabase
      .from('email_message_cache')
      .select(META_COLUMNS)
      .order('received_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to)
    if (opts.accountId) query = query.eq('account_id', opts.accountId)
    const { data, error } = await query
    if (error) throw error
    const page = (data ?? []) as CachedMessageMeta[]
    out.push(...page)
    opts.onPage?.(out.slice())
    if (page.length < to - from + 1) break
  }
  return out
}

/** One message's full encrypted body. */
export async function getCachedPayload(rowId: string): Promise<CachedMessageRow | null> {
  const { data, error } = await supabase
    .from('email_message_cache')
    .select(`${META_COLUMNS}, encrypted_payload`)
    .eq('id', rowId)
    .maybeSingle()
  if (error) throw error
  return (data as CachedMessageRow | null) ?? null
}

/** A request failed with a 5xx: the database is struggling, so stop bulk work. */
export class ServerStrainError extends Error {
  constructor(public status: number, message: string) {
    super(`Supabase ${status}: ${message}`)
    this.name = 'ServerStrainError'
  }
}

/** Full bodies for several rows, PAYLOAD_BATCH per request so no single query is heavy. */
export async function getCachedPayloads(rowIds: string[]): Promise<CachedMessageRow[]> {
  const out: CachedMessageRow[] = []
  for (let i = 0; i < rowIds.length; i += PAYLOAD_BATCH) {
    const { data, error, status } = await supabase
      .from('email_message_cache')
      .select(`${META_COLUMNS}, encrypted_payload`)
      .in('id', rowIds.slice(i, i + PAYLOAD_BATCH))
    if (status >= 500) throw new ServerStrainError(status, error?.message ?? 'server error')
    if (error) throw error
    out.push(...((data ?? []) as CachedMessageRow[]))
  }
  return out
}

/** Decrypt a row's header, or null if the row predates headers. */
export async function decryptCachedHeader(
  row: CachedMessageMeta,
  dek: Uint8Array,
): Promise<CachedMessageHeader | null> {
  if (!row.encrypted_header || !row.iv_header) return null
  return decryptJson<CachedMessageHeader>(row.encrypted_header, row.iv_header, dek)
}

/**
 * Write the header for a legacy row (derived from its decrypted payload).
 * Touches only the header columns.
 */
export async function backfillCachedHeader(
  rowId: string,
  payload: CachedMessagePayload,
  dek: Uint8Array,
): Promise<CachedMessageHeader> {
  const header = headerOf(payload)
  const { ciphertext, iv } = await encryptJson(header, dek)
  const { error, status } = await supabase
    .from('email_message_cache')
    .update({ encrypted_header: ciphertext, iv_header: iv })
    .eq('id', rowId)
  if (status >= 500) throw new ServerStrainError(status, error?.message ?? 'server error')
  if (error) console.warn('[email] header backfill failed:', rowId, error)
  return header
}

/**
 * Header for any row: decrypt the stored header, or (legacy rows) fetch the
 * body once, derive the header and save it so the next read is cheap.
 */
export async function resolveHeaders(
  rows: CachedMessageMeta[],
  dek: Uint8Array,
): Promise<Record<string, CachedMessageHeader>> {
  const out: Record<string, CachedMessageHeader> = {}
  const legacy: string[] = []
  for (const r of rows) {
    try {
      const h = await decryptCachedHeader(r, dek)
      if (h) out[r.id] = h
      else legacy.push(r.id)
    } catch (err) {
      console.warn('[email] header decrypt failed', r.id, err)
    }
  }
  for (const full of await getCachedPayloads(legacy)) {
    try {
      out[full.id] = await backfillCachedHeader(full.id, await decryptPayloadOnly(full, dek), dek)
    } catch (err) {
      if (err instanceof ServerStrainError) throw err
      console.warn('[email] legacy header failed', full.id, err)
    }
  }
  return out
}

async function decryptPayloadOnly(
  row: CachedMessageRow,
  dek: Uint8Array,
): Promise<CachedMessagePayload> {
  return decryptJson<CachedMessagePayload>(row.encrypted_payload, row.iv_payload, dek)
}

export async function setPoppedAt(
  rowId: string,
  ts: Date = new Date(),
): Promise<void> {
  const { error } = await supabase
    .from('email_message_cache')
    .update({ popped_at: ts.toISOString() })
    .eq('id', rowId)
  if (error) console.warn('[email] setPoppedAt failed:', error)
}

export async function decryptCachedPayload(
  row: CachedMessageRow,
  dek: Uint8Array,
): Promise<DecryptedCachedMessage> {
  const payload = await decryptJson<CachedMessagePayload>(
    row.encrypted_payload,
    row.iv_payload,
    dek,
  )
  return {
    ...payload,
    id: row.id,
    account_id: row.account_id,
    gmail_message_id: row.gmail_message_id,
    thread_id: row.thread_id,
    received_at: row.received_at,
    sender: row.sender,
    is_2fa_candidate: row.is_2fa_candidate,
    popped_at: row.popped_at,
  }
}

/** Drop a cached row (used when the user trashes a message). */
export async function deleteCachedMessage(rowId: string): Promise<void> {
  const { error } = await supabase.from('email_message_cache').delete().eq('id', rowId)
  if (error) throw error
}

/** Set the AI classification result on a cached row. */
export async function setMessageImportance(
  rowId: string,
  important: boolean,
  reason: string,
): Promise<void> {
  const { error } = await supabase
    .from('email_message_cache')
    .update({
      is_important: important,
      classified_at: new Date().toISOString(),
      classification_reason: reason || null,
    })
    .eq('id', rowId)
  if (error) console.warn('[email] setMessageImportance failed:', error)
}

/** Rows that haven't been AI-classified yet (is_important IS NULL). Metadata only. */
export async function listUnclassifiedMessages(limit = 500): Promise<CachedMessageMeta[]> {
  const out: CachedMessageMeta[] = []
  while (out.length < limit) {
    const from = out.length
    const to = Math.min(from + PAGE, limit) - 1
    const { data, error } = await supabase
      .from('email_message_cache')
      .select(META_COLUMNS)
      .is('is_important', null)
      .order('received_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to)
    if (error) throw error
    const page = (data ?? []) as CachedMessageMeta[]
    out.push(...page)
    if (page.length < to - from + 1) break
  }
  return out
}

/** Important, non-2FA emails received after `sinceIso`, newest first. Metadata only. */
export async function listImportantSince(sinceIso: string, limit = 30): Promise<CachedMessageMeta[]> {
  const { data, error } = await supabase
    .from('email_message_cache')
    .select(META_COLUMNS)
    .eq('is_important', true)
    .eq('is_2fa_candidate', false)
    .gt('received_at', sinceIso)
    .order('received_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data ?? []) as CachedMessageMeta[]
}

/** How many rows still need classifying. A HEAD count: no rows cross the wire. */
export async function countUnclassifiedMessages(): Promise<number> {
  const { count, error } = await supabase
    .from('email_message_cache')
    .select('id', { count: 'exact', head: true })
    .is('is_important', null)
  if (error) throw error
  return count ?? 0
}

// ── Inbox prefs (Tauri plugin-store; local-only — doesn't sync to Supabase) ──
//
// These prefs are deliberately local-only: a spam list is a personal nuisance
// filter, not vault data, and putting it server-side would leak which senders
// the user dislikes to anyone who can read the encrypted row metadata. Same
// for the "last seen" timestamp — it's a UI cursor, no security value.

import { getStoreValue, setStoreValue } from './desktop'

const SPAM_KEY = 'inboxSpamSenders'
const AUTH_KEY = 'inboxAuthSenders'
const LAST_SEEN_KEY = 'inboxLastSeenAt'

/** Lowercased exact email addresses the user has marked as spam. */
export async function getSpamSenders(): Promise<string[]> {
  const raw = await getStoreValue<string[]>(SPAM_KEY)
  return Array.isArray(raw) ? raw : []
}

export async function addSpamSender(email: string): Promise<string[]> {
  const lower = email.trim().toLowerCase()
  if (!lower) return getSpamSenders()
  const current = await getSpamSenders()
  if (current.includes(lower)) return current
  const next = [...current, lower]
  await setStoreValue(SPAM_KEY, next)
  return next
}

export async function removeSpamSender(email: string): Promise<string[]> {
  const lower = email.trim().toLowerCase()
  const current = await getSpamSenders()
  const next = current.filter((e) => e !== lower)
  await setStoreValue(SPAM_KEY, next)
  return next
}

/** Lowercased exact email addresses the user has marked as "always auth". */
export async function getAuthSenders(): Promise<string[]> {
  const raw = await getStoreValue<string[]>(AUTH_KEY)
  return Array.isArray(raw) ? raw : []
}

export async function addAuthSender(email: string): Promise<string[]> {
  const lower = email.trim().toLowerCase()
  if (!lower) return getAuthSenders()
  const current = await getAuthSenders()
  if (current.includes(lower)) return current
  const next = [...current, lower]
  await setStoreValue(AUTH_KEY, next)
  return next
}

export async function removeAuthSender(email: string): Promise<string[]> {
  const lower = email.trim().toLowerCase()
  const current = await getAuthSenders()
  const next = current.filter((e) => e !== lower)
  await setStoreValue(AUTH_KEY, next)
  return next
}

/** ISO timestamp of when the user last visited the Inbox tab. */
export async function getLastInboxSeenAt(): Promise<string | null> {
  return (await getStoreValue<string>(LAST_SEEN_KEY)) ?? null
}

export async function markInboxSeen(ts: Date = new Date()): Promise<void> {
  await setStoreValue(LAST_SEEN_KEY, ts.toISOString())
}

/** Extract bare email address from a `Name <email@host>` style string. */
export function senderEmail(raw: string | null | undefined): string {
  if (!raw) return ''
  const m = /<([^>]+)>/.exec(raw)
  if (m) return m[1].trim().toLowerCase()
  return raw.trim().toLowerCase()
}

// ── AI classifier prefs (Anthropic API key + toggle) ────────────────────────

const AI_KEY_KEY = 'anthropicApiKey'
const AI_ENABLED_KEY = 'aiInboxEnabled'

export async function getAnthropicApiKey(): Promise<string> {
  return (await getStoreValue<string>(AI_KEY_KEY)) ?? ''
}
export async function saveAnthropicApiKey(key: string): Promise<void> {
  await setStoreValue(AI_KEY_KEY, key.trim())
}
export async function getAiInboxEnabled(): Promise<boolean> {
  return (await getStoreValue<boolean>(AI_ENABLED_KEY)) ?? false
}
export async function setAiInboxEnabled(v: boolean): Promise<void> {
  await setStoreValue(AI_ENABLED_KEY, v)
}
