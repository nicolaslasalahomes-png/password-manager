/**
 * keyring-inbox-put (VAULT-1, 30 Sep 2026): the ONLY way into Keyring's sealed inbox.
 *
 * Caller: scripts/keyring-push.mjs on Nicolas's Mac, with the header x-inbox-secret.
 *   {action:"pubkey"}                        -> the vault's inbox PUBLIC key (to seal to)
 *   {action:"put", source, envelope}         -> replace that source's envelope
 *
 * It never reads an envelope back and never returns anything secret. The owner is fixed by
 * the INBOX_OWNER_USER_ID secret, never taken from the request. Besides the write secret, the
 * envelope's ECDSA signature is checked here against INBOX_WRITER_PUBLIC_JWK (the app checks
 * it again with its own pinned copy), so a leaked write secret alone cannot plant a list.
 * verify_jwt is off; this function's own check is the gate (a stranger gets 401).
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const WRITE_SECRET = Deno.env.get('INBOX_WRITE_SECRET') ?? ''
const OWNER = Deno.env.get('INBOX_OWNER_USER_ID') ?? ''
const WRITER_JWK = Deno.env.get('INBOX_WRITER_PUBLIC_JWK') ?? ''
const LABEL = 'keyring-inbox-v1'
const enc = new TextEncoder()

function dbKey(): string {
  // Prefer the new secret key; fall back to the legacy service role.
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

/** Constant-time compare of two strings via their SHA-256. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))))
  const u = new Uint8Array(x)
  const v = new Uint8Array(y)
  let diff = 0
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i]
  return diff === 0
}

const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0

async function signatureOk(raw: string, source: string): Promise<boolean> {
  try {
    const e = JSON.parse(raw)
    if (e?.v !== 1 || e.source !== source || !Number.isInteger(e.list_no)) return false
    if (![e.created_at, e.salt, e.iv, e.ct, e.sig, e.epk?.x, e.epk?.y].every(isStr)) return false
    const header = [LABEL, e.source, e.created_at, String(e.list_no), e.epk.x, e.epk.y, e.salt, e.iv].join('\n')
    const key = await crypto.subtle.importKey('jwk', JSON.parse(WRITER_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64(e.sig), enc.encode(`${header}\n${e.ct}`))
  } catch {
    return false
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  if (!(await sameSecret(req.headers.get('x-inbox-secret') ?? '', WRITE_SECRET))) return json({ error: 'unauthorized' }, 401)
  if (!OWNER || !WRITER_JWK) return json({ error: 'not_configured' }, 500)

  let body: { action?: string; source?: string; envelope?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'bad_json' }, 400)
  }
  const db = createClient(SUPABASE_URL, dbKey(), { auth: { persistSession: false } })

  if (body.action === 'pubkey') {
    const { data, error } = await db.from('vault_inbox_keys').select('public_key_jwk').eq('user_id', OWNER).maybeSingle()
    if (error) return json({ error: 'db', detail: error.message }, 500)
    return json({ ok: true, public_key_jwk: data?.public_key_jwk ?? null })
  }

  if (body.action === 'put') {
    const source = String(body.source ?? '')
    const envelope = String(body.envelope ?? '')
    if (!/^[a-z_]{1,32}$/.test(source)) return json({ error: 'bad_source' }, 400)
    if (!envelope || envelope.length > 200_000) return json({ error: 'bad_envelope' }, 400)
    if (!(await signatureOk(envelope, source))) return json({ error: 'bad_signature' }, 400)
    const updated_at = new Date().toISOString()
    const { error } = await db
      .from('vault_inbox')
      .upsert({ user_id: OWNER, source, envelope, updated_at }, { onConflict: 'user_id,source' })
    if (error) return json({ error: 'db', detail: error.message }, 500)
    return json({ ok: true, updated_at })
  }

  return json({ error: 'unknown_action' }, 400)
})
