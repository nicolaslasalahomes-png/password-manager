#!/usr/bin/env node
/**
 * VAULT-1 writer: seal Nicolas's Needs-you list and put it in Keyring's sealed inbox.
 *
 *   node scripts/keyring-push.mjs <needs-you.json> [--dry-run]
 *   node scripts/keyring-push.mjs <calendar.json> [--dry-run]     (KEY-CAL-1, file has "source":"calendar")
 *   node scripts/keyring-push.mjs <todos.json> [--dry-run]        (KEY-TODO-1, file has "source":"todos")
 *
 * Called by the needs-you-list skill after each list. The snapshot file is
 *   {"list_no": 7, "created_at": "<ISO>", "items": [{"id":"N20","section":"asap|instant|think|later",
 *    "title":"...", "action"?:"...", "link"?:"https://...", "due"?:"YYYY-MM-DD"}]}
 * The calendar feed file is
 *   {"source":"calendar", "list_no": 1, "events": [{"id":"g-abc", "title":"...", "start":"YYYY-MM-DD" | "<ISO time>",
 *    "end"?:..., "all_day":true|false, "where"?:"...", "note"?:"...", "link"?:"https://...",
 *    "origin":"google|email|whatsapp|needs_you|claude"}]}
 *   Each push replaces the whole feed (src/lib/inbox/calendarFeed.ts validates it again in the app).
 * The to-do file (message aggregation) is
 *   {"source":"todos", "list_no": 1, "todos": [{"id":"e-abc", "title":"...", "due":"YYYY-MM-DD" | "<ISO time>",
 *    "priority":"low|medium|high", "note"?:"...", "link"?:"https://...", "origin":"email|whatsapp|calendar|logs|claude",
 *    "done"?:true}]}
 *   Keyring turns each new id into a task (src/lib/inbox/todos.ts), ticks off done ones, never deletes.
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
    if (i.action) {
      out.action = String(i.action).trim()
      if (out.action.length > 1500) throw new Error(`${i.id}: action is ${out.action.length} chars; keep it under 1500`)
    }
    if (out.title.length > 300) throw new Error(`${i.id}: title is ${out.title.length} chars; keep it under 300`)
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

const ORIGINS = new Set(['google', 'email', 'whatsapp', 'needs_you', 'claude'])
const DAY = /^\d{4}-\d{2}-\d{2}$/

/** KEY-CAL-1: check a calendar feed before sealing. */
export function toCalendarPayload(snap) {
  if (!Number.isInteger(snap?.list_no) || !Array.isArray(snap?.events)) throw new Error('feed needs list_no and events')
  if (snap.events.length > 500) throw new Error(`${snap.events.length} events; the app shows at most 500`)
  const created_at = new Date(Math.max(Date.now(), Date.parse(snap.created_at) || 0)).toISOString()
  const seen = new Set()
  const events = snap.events.map((e, n) => {
    const id = String(e?.id ?? '')
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(id)) throw new Error(`event ${n}: bad id ${id}`)
    if (seen.has(id)) throw new Error(`event ${n}: ${id} appears twice`)
    seen.add(id)
    if (typeof e.title !== 'string' || !e.title.trim()) throw new Error(`${id}: title required`)
    if (e.title.trim().length > 200) throw new Error(`${id}: title over 200 chars`)
    if (/\u2014/.test(JSON.stringify(e))) throw new Error(`${id}: no em dashes`)
    if (!ORIGINS.has(e.origin)) throw new Error(`${id}: origin must be one of ${[...ORIGINS].join('|')}`)
    const allDay = e.all_day === true
    for (const k of ['start', 'end']) {
      if (e[k] === undefined && k === 'end') continue
      const v = String(e[k] ?? '')
      const ok = allDay ? DAY.test(v) : !DAY.test(v) && !Number.isNaN(Date.parse(v))
      if (!ok) throw new Error(`${id}: ${k} must be ${allDay ? 'YYYY-MM-DD' : 'an ISO time'} (got ${v})`)
    }
    const out = { id, title: e.title.trim(), start: e.start, all_day: allDay, origin: e.origin }
    if (e.end) out.end = e.end
    if (e.where) out.where = String(e.where).trim().slice(0, 200)
    if (e.note) {
      out.note = String(e.note).trim()
      if (out.note.length > 1000) throw new Error(`${id}: note is ${out.note.length} chars; keep it under 1000`)
    }
    if (e.link) {
      if (!/^https:\/\/\S+$/.test(e.link)) throw new Error(`${id}: link must be https`)
      out.link = e.link
    }
    return out
  })
  return { v: 1, source: 'calendar', list_no: snap.list_no, created_at, events }
}

const TODO_ORIGINS = new Set(['email', 'whatsapp', 'calendar', 'logs', 'claude'])

/** KEY-TODO-1: check a to-do list before sealing. */
export function toTodosPayload(snap) {
  if (!Number.isInteger(snap?.list_no) || !Array.isArray(snap?.todos)) throw new Error('to-do list needs list_no and todos')
  if (snap.todos.length > 300) throw new Error(`${snap.todos.length} to-dos; the app reads at most 300`)
  const created_at = new Date(Math.max(Date.now(), Date.parse(snap.created_at) || 0)).toISOString()
  const seen = new Set()
  const todos = snap.todos.map((t, n) => {
    const id = String(t?.id ?? '')
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(id)) throw new Error(`to-do ${n}: bad id ${id}`)
    if (seen.has(id)) throw new Error(`to-do ${n}: ${id} appears twice`)
    seen.add(id)
    if (typeof t.title !== 'string' || !t.title.trim() || t.title.trim().length > 200) throw new Error(`${id}: title required, under 200 chars`)
    if (/\u2014/.test(JSON.stringify(t))) throw new Error(`${id}: no em dashes`)
    if (!TODO_ORIGINS.has(t.origin)) throw new Error(`${id}: origin must be one of ${[...TODO_ORIGINS].join('|')}`)
    if (!['low', 'medium', 'high'].includes(t.priority)) throw new Error(`${id}: priority must be low|medium|high`)
    const due = String(t.due ?? '')
    if (!DAY.test(due) && Number.isNaN(Date.parse(due))) throw new Error(`${id}: due must be YYYY-MM-DD or an ISO time (got ${due})`)
    const out = { id, title: t.title.trim(), due, priority: t.priority, origin: t.origin }
    if (t.note) {
      out.note = String(t.note).trim()
      if (out.note.length > 2000) throw new Error(`${id}: note is ${out.note.length} chars; keep it under 2000`)
    }
    if (t.link) {
      if (!/^https:\/\/\S+$/.test(t.link)) throw new Error(`${id}: link must be https`)
      out.link = t.link
    }
    if (t.done === true) out.done = true
    return out
  })
  return { v: 1, source: 'todos', list_no: snap.list_no, created_at, todos }
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
  if (!file) throw new Error('usage: keyring-push.mjs <needs-you.json | calendar.json> [--dry-run]')
  const dry = flags.includes('--dry-run')
  const snap = JSON.parse(readFileSync(file, 'utf8'))
  const payload = snap.source === 'calendar' ? toCalendarPayload(snap) : snap.source === 'todos' ? toTodosPayload(snap) : toPayload(snap)
  const count =
    payload.source === 'calendar' ? `${payload.events.length} events` : payload.source === 'todos' ? `${payload.todos.length} to-dos` : `${payload.items.length} items`
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
    console.log(`dry run: ${payload.source} ${payload.list_no}, ${count}, envelope ${size} chars, nothing sent`)
    return
  }
  const r = await call({ action: 'put', source: payload.source, envelope: JSON.stringify(envelope) }, writeSecret)
  console.log(`put ${payload.source} ${payload.list_no} (${count}, ${size} chars) at ${r.updated_at}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(`keyring-push: ${e.message}`)
    process.exit(1)
  })
}
