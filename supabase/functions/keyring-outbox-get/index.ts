/**
 * keyring-outbox-get (VAULT-2, 30 Sep 2026): the reader on Nicolas's Mac collects his sealed replies.
 *
 * Header x-outbox-secret (OUTBOX_READ_SECRET, separate from the inbox write secret).
 *   {action:"get", limit?}   -> up to 20 unfetched rows of the owner, oldest first:
 *                               id, user_id, created_at, list_no, item_id, envelope. Nothing is marked.
 *   {action:"ack", ids:[]}   -> marks those rows fetched (only the owner's, only unfetched ones).
 * Two steps on purpose: a row is marked only after the reader has written it down, so a crash
 * between the two loses nothing (the reader is idempotent by row id).
 * Never returns own_copy. The owner is fixed by INBOX_OWNER_USER_ID. A stranger gets 401.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const READ_SECRET = Deno.env.get('OUTBOX_READ_SECRET') ?? ''
const OWNER = Deno.env.get('INBOX_OWNER_USER_ID') ?? ''
const enc = new TextEncoder()

function dbKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}') as Record<string, string>
    const k = keys.default ?? Object.values(keys)[0]
    if (k) return k
  } catch {
    /* not set */
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

async function sameSecret(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))))
  const u = new Uint8Array(x)
  const v = new Uint8Array(y)
  let diff = 0
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i]
  return diff === 0
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

Deno.serve(async (req) => {
  if (!(await sameSecret(req.headers.get('x-outbox-secret') ?? '', READ_SECRET))) return json({ error: 'unauthorized' }, 401)
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  if (!OWNER) return json({ error: 'not_configured' }, 500)

  let body: { action?: string; limit?: number; ids?: unknown }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'bad_json' }, 400)
  }
  const db = createClient(SUPABASE_URL, dbKey(), { auth: { persistSession: false } })

  if (body.action === 'get') {
    const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 20)
    const { data, error } = await db
      .from('vault_outbox')
      .select('id, user_id, created_at, list_no, item_id, envelope')
      .eq('user_id', OWNER)
      .is('fetched_at', null)
      .order('created_at', { ascending: true })
      .limit(limit)
    if (error) return json({ error: 'db', detail: error.message }, 500)
    return json({ ok: true, rows: data ?? [] })
  }

  if (body.action === 'ack') {
    const ids = Array.isArray(body.ids) ? body.ids.filter((i): i is string => typeof i === 'string' && UUID.test(i)).slice(0, 20) : []
    if (!ids.length) return json({ error: 'no_ids' }, 400)
    const { data, error } = await db
      .from('vault_outbox')
      .update({ fetched_at: new Date().toISOString() })
      .eq('user_id', OWNER)
      .is('fetched_at', null)
      .in('id', ids)
      .select('id')
    if (error) return json({ error: 'db', detail: error.message }, 500)
    return json({ ok: true, acked: (data ?? []).length })
  }

  return json({ error: 'unknown_action' }, 400)
})
