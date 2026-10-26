/**
 * VAULT-1: read and open the Needs-you list for this vault. KEY-CAL-1: same for Claude's calendar feed.
 *
 * Never throws for a bad list: the brief and the panels keep working with his own tasks, and
 * the panel says why the list was refused (unsigned, tampered, rolled back, key mismatch).
 */
import { supabase } from '../supabase'
import { getStoreValue, isDesktop, setStoreValue } from '../desktop'
import { InboxError, openEnvelope, importWriterKey } from './envelope'
import { ensureInboxKey, InboxKeyMismatchError } from './keys'
import { NEEDS_YOU_SOURCE, isRollback, isStale, toSnapshot, type NeedsYouSnapshot } from './needsYou'
import { CALENDAR_SOURCE, toCalendarFeed, type CalendarFeed } from './calendarFeed'
import { WRITER_SIGNING_PUBLIC_JWK } from './writerKey'

export type NeedsYouLoad =
  | { status: 'none' }
  | { status: 'ok'; snapshot: NeedsYouSnapshot; stale: boolean }
  | { status: 'refused'; reason: string }

export type CalendarFeedLoad =
  | { status: 'none' }
  | { status: 'ok'; feed: CalendarFeed }
  | { status: 'refused'; reason: string }

/** Per source, the newest created_at this device has shown (rollback guard). */
const LAST_SEEN_KEY: Record<string, string> = {
  [NEEDS_YOU_SOURCE]: 'inboxNeedsYouLastCreatedAt',
  [CALENDAR_SOURCE]: 'inboxCalendarLastCreatedAt',
}

async function getLastSeen(source: string): Promise<string | null> {
  const key = LAST_SEEN_KEY[source]
  if (isDesktop()) return getStoreValue<string>(key)
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
async function setLastSeen(source: string, v: string): Promise<void> {
  const key = LAST_SEEN_KEY[source]
  if (isDesktop()) return setStoreValue(key, v)
  try {
    localStorage.setItem(key, v)
  } catch {
    /* private window: the rollback check just starts fresh */
  }
}

/**
 * Read one source's envelope, verify and open it, validate it with `parse`, and refuse it if it
 * is older than one this device already showed. null when there is no envelope yet.
 */
async function openSource<T extends { created_at: string }>(
  userId: string,
  dek: Uint8Array,
  source: string,
  parse: (json: unknown, header: { created_at: string; list_no: number }) => T,
): Promise<T | null> {
  // First, so the writer has a key to seal to even before the first envelope exists.
  const recipientPrivateKey = await ensureInboxKey(userId, dek)
  const { data, error } = await supabase
    .from('vault_inbox')
    .select('envelope')
    .eq('user_id', userId)
    .eq('source', source)
    .maybeSingle()
  if (error) throw error
  if (!data) return null

  const writerPublicKey = await importWriterKey(WRITER_SIGNING_PUBLIC_JWK)
  const { envelope, json } = await openEnvelope(
    (data as { envelope: string }).envelope,
    { recipientPrivateKey, writerPublicKey },
    source,
  )
  const opened = parse(json, envelope)
  const lastSeen = await getLastSeen(source)
  if (isRollback(opened.created_at, lastSeen)) throw new RollbackError()
  if (opened.created_at !== lastSeen) await setLastSeen(source, opened.created_at)
  return opened
}

class RollbackError extends Error {}

function refusal(err: unknown, what: string): { status: 'refused'; reason: string } {
  if (err instanceof RollbackError) {
    return { status: 'refused', reason: `An older ${what} replaced a newer one, so it was ignored.` }
  }
  if (err instanceof InboxError || err instanceof InboxKeyMismatchError) {
    console.warn('[inbox] refused', err)
    return { status: 'refused', reason: err.message }
  }
  console.warn('[inbox] load failed', err)
  return { status: 'refused', reason: `Could not load the ${what} right now.` }
}

export async function loadNeedsYou(userId: string, dek: Uint8Array): Promise<NeedsYouLoad> {
  try {
    const snapshot = await openSource(userId, dek, NEEDS_YOU_SOURCE, toSnapshot)
    if (!snapshot) return { status: 'none' }
    return { status: 'ok', snapshot, stale: isStale(snapshot.created_at) }
  } catch (err) {
    return refusal(err, 'list')
  }
}

export async function loadCalendarFeed(userId: string, dek: Uint8Array): Promise<CalendarFeedLoad> {
  try {
    const feed = await openSource(userId, dek, CALENDAR_SOURCE, toCalendarFeed)
    return feed ? { status: 'ok', feed } : { status: 'none' }
  } catch (err) {
    return refusal(err, 'calendar feed')
  }
}
