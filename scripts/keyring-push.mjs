#!/usr/bin/env node
/**
 * VAULT-1 writer: seal Nicolas's Needs-you list and put it in Keyring's sealed inbox.
 *
 *   node scripts/keyring-push.mjs <needs-you.json> [--dry-run]
 *
 * Called by the needs-you-list skill after each list. The snapshot file is
 *   {"list_no": 7, "created_at": "<ISO>", "items": [{"id":"N20","section":"asap|instant|think|later",
 *    "title":"...", "action"?:"...", "link"?:"https://...", "due"?:"YYYY-MM-DD"}]}
 *
 * How it seals (must match src/lib/inbox/envelope.ts, which the tests check):
 *   ECDH P-256 (fresh ephemeral key x the vault's inbox public key) -> HKDF-SHA256 -> AES-256-GCM
 *   over the JSON padded with spaces to a 4 KB bucket, header as additional data; then ECDSA
 *   P-256 over header + ciphertext with the writer's signing key, which the app has pinned.
 *
 * Secrets live ONLY in ~/.config/keyring-inbox/ on the Mac (dir 700, files 600): `write-secret` and
 * `writer-signing-private.jwk`. Never in the repo, and never in the Claude memory folder, which is
 * synced to a server. The vault's inbox public key is fetched from the function and PINNED on first
 * use (its SHA-256 goes in the memory file reference_keyring_inbox_writer.md, which holds no secrets);
 * if it ever changes, this refuses to seal. A swapped key would otherwise send the list to whoever
 * swapped it.
 */
import { readFileSync, appendFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { subtle } = globalThis.crypto
export const PAD_BUCKET = 4096
const LABEL = 'keyring-inbox-v1'
const FUNCTION_URL = 'https://wwylhsetxpopxmtupfhn.supabase.co/functions/v1/keyring-inbox-put'
const MEMORY_FILE = path.join(homedir(), '.claude/projects/-Users-nicolassutcliffe/memory/reference_keyring_inbox_writer.md')
const SECRETS_DIR = path.join(homedir(), '.config/keyring-inbox')
const enc = new TextEncoder()
const b64 = (u) => Buffer.from(u).toString('base64')

export function envelopeHeader(e) {
  return [LABEL, e.source, e.created_at, String(e.list_no), e.epk.x, e.epk.y, e.salt, e.iv].join('\n')
}

/** Pad to a whole number of buckets with spaces (JSON.parse ignores trailing whitespace). */
export function pad(json) {
  const bytes = enc.encode(json)
  const size = Math.ceil((bytes.length + 1) / PAD_BUCKET) * PAD_BUCKET
  const out = new Uint8Array(size).fill(0x20)
  out.set(bytes)
  return out
}

/** Seal `payload` (an object with source, created_at, list_no) for `recipientPublicJwk`. */
export async function seal(payload, { recipientPublicJwk, writerPrivateJwk }) {
  const { source, created_at, list_no } = payload
  const recipient = await subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: recipientPublicJwk.x, y: recipientPublicJwk.y },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const epkJwk = await subtle.exportKey('jwk', eph.publicKey)
  const shared = await subtle.deriveBits({ name: 'ECDH', public: recipient }, eph.privateKey, 256)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const hk = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  const aes = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(`${LABEL} aes-gcm ${source}`) },
    hk,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  )
  const head = {
    source,
    created_at,
    list_no,
    epk: { kty: 'EC', crv: 'P-256', x: epkJwk.x, y: epkJwk.y },
    salt: b64(salt),
    iv: b64(iv),
  }
  const header = envelopeHeader(head)
  const ct = b64(
    new Uint8Array(
      await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(header) }, aes, pad(JSON.stringify(payload))),
    ),
  )
  const signer = await subtle.importKey('jwk', writerPrivateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const sig = b64(
    new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer, enc.encode(`${header}\n${ct}`))),
  )
  return { v: 1, ...head, ct, sig }
}

const SECTIONS = new Set(['asap', 'instant', 'think', 'later'])

/** Check the snapshot before sealing; the app validates again after opening. */
export function toPayload(snap) {
  if (!Number.isInteger(snap?.list_no) || !Array.isArray(snap?.items)) throw new Error('snapshot needs list_no and items')
  // Stamped here, at sealing, never taken from the file: the app refuses a list older than one it
  // has shown (rollback guard), so a snapshot re-written with a stale created_at must not look older.
  const created_at = new Date(Math.max(Date.now(), Date.parse(snap.created_at) || 0)).toISOString()
  const seen = new Set()
  const items = snap.items.map((i, n) => {
    if (!/^N\d{1,4}[a-z]?$/.test(i?.id ?? '')) throw new Error(`item ${n}: bad id ${i?.id}`)
    if (seen.has(i.id)) throw new Error(`item ${n}: ${i.id} appears twice`)
    seen.add(i.id)
    if (!SECTIONS.has(i.section)) throw new Error(`${i.id}: section must be asap|instant|think|later`)
    if (typeof i.title !== 'string' || !i.title.trim()) throw new Error(`${i.id}: title required`)
    if (/\u2014/.test(JSON.stringify(i))) throw new Error(`${i.id}: no em dashes`)
    const out = { id: i.id, section: i.section, title: i.title.trim() }
    if (i.action) out.action = String(i.action).trim()
    if (i.link) {
      if (!/^https:\/\/\S+$/.test(i.link)) throw new Error(`${i.id}: link must be https`)
      out.link = i.link
    }
    if (i.due) {
      if (Number.isNaN(Date.parse(i.due))) throw new Error(`${i.id}: bad due ${i.due}`)
      out.due = i.due
    }
    return out
  })
  return { v: 1, source: 'needs_you', list_no: snap.list_no, created_at, items }
}

function secret(file) {
  const p = path.join(SECRETS_DIR, file)
  const mode = statSync(p).mode & 0o777
  if (mode & 0o077) throw new Error(`${p} is readable by others (mode ${mode.toString(8)}): chmod 600 it`)
  return readFileSync(p, 'utf8').trim()
}

async function call(body, writeSecret) {
  const res = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-inbox-secret': writeSecret },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let j = null
  try {
    j = JSON.parse(text)
  } catch {
    /* not JSON */
  }
  if (!res.ok || !j?.ok) throw new Error(`keyring-inbox-put ${res.status}: ${text.slice(0, 200)}`)
  return j
}

async function fingerprint(jwk) {
  const d = await subtle.digest('SHA-256', enc.encode(`${jwk.x}.${jwk.y}`))
  return Buffer.from(d).toString('hex')
}

async function main() {
  const [file, ...flags] = process.argv.slice(2)
  if (!file) throw new Error('usage: keyring-push.mjs <needs-you.json> [--dry-run]')
  const dry = flags.includes('--dry-run')
  const payload = toPayload(JSON.parse(readFileSync(file, 'utf8')))
  const writeSecret = secret('write-secret')
  const writerPrivateJwk = JSON.parse(secret('writer-signing-private.jwk'))

  const { public_key_jwk: recipientPublicJwk } = await call({ action: 'pubkey' }, writeSecret)
  if (!recipientPublicJwk) throw new Error('Keyring has no inbox key yet: open Keyring and unlock it once')
  const fp = await fingerprint(recipientPublicJwk)
  const pinned = readFileSync(MEMORY_FILE, 'utf8').match(/^INBOX_RECIPIENT_KEY_SHA256=([0-9a-f]{64})$/m)?.[1]
  if (!pinned) {
    appendFileSync(MEMORY_FILE, `INBOX_RECIPIENT_KEY_SHA256=${fp}\n`)
    console.log(`pinned the vault's inbox key ${fp.slice(0, 16)}...`)
  } else if (pinned !== fp) {
    throw new Error(`REFUSING: the vault's inbox key changed (pinned ${pinned.slice(0, 16)}..., now ${fp.slice(0, 16)}...). Check before re-pinning.`)
  }

  const envelope = await seal(payload, { recipientPublicJwk, writerPrivateJwk })
  const size = JSON.stringify(envelope).length
  if (dry) {
    console.log(`dry run: List ${payload.list_no}, ${payload.items.length} items, envelope ${size} chars, nothing sent`)
    return
  }
  const r = await call({ action: 'put', source: 'needs_you', envelope: JSON.stringify(envelope) }, writeSecret)
  console.log(`put List ${payload.list_no} (${payload.items.length} items, ${size} chars) at ${r.updated_at}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(`keyring-push: ${e.message}`)
    process.exit(1)
  })
}
