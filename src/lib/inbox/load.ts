/**
 * VAULT-1: read and open the Needs-you list for this vault.
 *
 * Never throws for a bad list: the brief and the panels keep working with his own tasks, and
 * the panel says why the list was refused (unsigned, tampered, rolled back, key mismatch).
 */
import { supabase } from '../supabase'
import { getStoreValue, isDesktop, setStoreValue } from '../desktop'
import { InboxError, openEnvelope, importWriterKey } from './envelope'
import { ensureInboxKey, InboxKeyMismatchError } from './keys'
import { NEEDS_YOU_SOURCE, isRollback, isStale, toSnapshot, type NeedsYouSnapshot } from './needsYou'
import { WRITER_SIGNING_PUBLIC_JWK } from './writerKey'

export type NeedsYouLoad =
  | { status: 'none' }
  | { status: 'ok'; snapshot: NeedsYouSnapshot; stale: boolean }
  | { status: 'refused'; reason: string }

const LAST_SEEN_KEY = 'inboxNeedsYouLastCreatedAt'

async function getLastSeen(): Promise<string | null> {
  if (isDesktop()) return getStoreValue<string>(LAST_SEEN_KEY)
  try {
    return localStorage.getItem(LAST_SEEN_KEY)
  } catch {
    return null
  }
}
async function setLastSeen(v: string): Promise<void> {
  if (isDesktop()) return setStoreValue(LAST_SEEN_KEY, v)
  try {
    localStorage.setItem(LAST_SEEN_KEY, v)
  } catch {
    /* private window: the rollback check just starts fresh */
  }
}

export async function loadNeedsYou(userId: string, dek: Uint8Array): Promise<NeedsYouLoad> {
  try {
    // First, so the writer has a key to seal to even before the first list exists.
    const recipientPrivateKey = await ensureInboxKey(userId, dek)
    const { data, error } = await supabase
      .from('vault_inbox')
      .select('envelope')
      .eq('user_id', userId)
      .eq('source', NEEDS_YOU_SOURCE)
      .maybeSingle()
    if (error) throw error
    if (!data) return { status: 'none' }

    const writerPublicKey = await importWriterKey(WRITER_SIGNING_PUBLIC_JWK)
    const { envelope, json } = await openEnvelope(
      (data as { envelope: string }).envelope,
      { recipientPrivateKey, writerPublicKey },
      NEEDS_YOU_SOURCE,
    )
    const snapshot = toSnapshot(json, envelope)
    const lastSeen = await getLastSeen()
    if (isRollback(snapshot.created_at, lastSeen)) {
      return { status: 'refused', reason: `An older list (List ${snapshot.list_no}) replaced a newer one, so it was ignored.` }
    }
    if (snapshot.created_at !== lastSeen) await setLastSeen(snapshot.created_at)
    return { status: 'ok', snapshot, stale: isStale(snapshot.created_at) }
  } catch (err) {
    if (err instanceof InboxError || err instanceof InboxKeyMismatchError) {
      console.warn('[inbox] refused', err)
      return { status: 'refused', reason: err.message }
    }
    console.warn('[inbox] load failed', err)
    return { status: 'refused', reason: 'Could not load the list right now.' }
  }
}
