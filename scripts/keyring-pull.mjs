#!/usr/bin/env node
/**
 * VAULT-2 reader: collect Nicolas's sealed replies from the Needs-you card and write them down.
 *
 *   node scripts/keyring-pull.mjs            (a launchd job runs this every 2 minutes)
 *
 * For each unfetched row from keyring-outbox-get: check it is the owner's, open it with the reader's
 * private key (~/.config/keyring-inbox/reader-private.jwk, Mac only), check the sealed list_no and
 * item_id match the row, and append one JSON line to ~/.claude/issues/lasalahomes/keyring-replies.jsonl
 * (600). Idempotent by row id: a row already in the file is not written again. Rows are acked
 * (marked fetched) only after they are written. On a 5xx it backs off (10, 20, 40 ... max 60 min)
 * so a struggling nano database is not hammered.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, statSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { subtle } = globalThis.crypto
export const OWNER = 'd9ecc97f-8eb3-4ae3-bf6a-3d74fa547dea'
const LABEL = 'keyring-outbox-v1'
const FUNCTION_URL = 'https://wwylhsetxpopxmtupfhn.supabase.co/functions/v1/keyring-outbox-get'
const DIR = path.join(homedir(), '.config/keyring-inbox')
const BACKOFF_FILE = path.join(DIR, 'pull-backoff.json')
export const REPLIES_FILE = path.join(homedir(), '.claude/issues/lasalahomes/keyring-replies.jsonl')
const enc = new TextEncoder()
const dec = new TextDecoder()
const unb64 = (s) => Uint8Array.from(Buffer.from(s, 'base64'))

export function replyHeader(e) {
  return [LABEL, String(e.list_no), e.item_id, e.epk.x, e.epk.y, e.salt, e.iv].join('\n')
}

/** Open one row. Throws on anything that does not check out. */
export async function openReply(row, readerPrivateJwk, owner = OWNER) {
  if (row.user_id !== owner) throw new Error(`row ${row.id}: not the owner's`)
  const e = JSON.parse(row.envelope)
  if (e.v !== 1 || e.list_no !== row.list_no || e.item_id !== row.item_id) throw new Error(`row ${row.id}: envelope does not match its row`)
  const priv = await subtle.importKey('jwk', readerPrivateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const epk = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: e.epk.x, y: e.epk.y }, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = await subtle.deriveBits({ name: 'ECDH', public: epk }, priv, 256)
  const hk = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  const aes = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: unb64(e.salt), info: enc.encode(`${LABEL} aes-gcm`) },
    hk,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  )
  let plain
  try {
    plain = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(e.iv), additionalData: enc.encode(replyHeader(e)) }, aes, unb64(e.ct))
  } catch {
    throw new Error(`row ${row.id}: could not be opened (tampered, or not sealed to this reader)`)
  }
  const p = JSON.parse(dec.decode(plain).trimEnd())
  if (p.v !== 1 || p.list_no !== row.list_no || p.item_id !== row.item_id || typeof p.text !== 'string') {
    throw new Error(`row ${row.id}: sealed reply does not match its row`)
  }
  return {
    row_id: row.id,
    list_no: p.list_no,
    item_id: p.item_id,
    title: String(p.title ?? '').slice(0, 300),
    text: p.text.slice(0, 2000),
    sent_at: p.sent_at,
    stored_at: row.created_at,
  }
}

/** Row ids already written, so a re-run never duplicates a reply. */
export function seenIds(fileText) {
  const ids = new Set()
  for (const line of fileText.split('\n')) {
    if (!line.trim()) continue
    try {
      ids.add(JSON.parse(line).row_id)
    } catch {
      /* a torn line: ignore */
    }
  }
  return ids
}

function secretFile(name) {
  const p = path.join(DIR, name)
  const mode = statSync(p).mode & 0o777
  if (mode & 0o077) throw new Error(`${p} is readable by others (mode ${mode.toString(8)}): chmod 600 it`)
  return readFileSync(p, 'utf8').trim()
}

async function call(body, secret) {
  const res = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-outbox-secret': secret },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  if (res.status >= 500) {
    const err = new Error(`keyring-outbox-get ${res.status}: ${text.slice(0, 120)}`)
    err.retryable = true
    throw err
  }
  const j = JSON.parse(text)
  if (!res.ok || !j.ok) throw new Error(`keyring-outbox-get ${res.status}: ${text.slice(0, 200)}`)
  return j
}

function backoff() {
  try {
    return JSON.parse(readFileSync(BACKOFF_FILE, 'utf8'))
  } catch {
    return { until: 0, minutes: 0 }
  }
}

async function main() {
  const b = backoff()
  if (Date.now() < b.until) return
  const secret = secretFile('outbox-read-secret')
  const readerPrivateJwk = JSON.parse(secretFile('reader-private.jwk'))
  try {
    const { rows } = await call({ action: 'get', limit: 20 }, secret)
    if (b.minutes) writeFileSync(BACKOFF_FILE, JSON.stringify({ until: 0, minutes: 0 }), { mode: 0o600 })
    if (!rows.length) return
    const seen = seenIds(existsSync(REPLIES_FILE) ? readFileSync(REPLIES_FILE, 'utf8') : '')
    const done = []
    for (const row of rows) {
      if (seen.has(row.id)) {
        done.push(row.id)
        continue
      }
      try {
        const r = await openReply(row, readerPrivateJwk)
        appendFileSync(REPLIES_FILE, JSON.stringify({ ...r, received_at: new Date().toISOString() }) + '\n', { mode: 0o600 })
        done.push(row.id)
        console.log(`reply ${r.item_id} (List ${r.list_no}): ${r.text.slice(0, 60)}`)
      } catch (e) {
        // Not acked: it stays unfetched and visible, and is reported every run until someone looks.
        console.error(`keyring-pull: ${e.message}`)
      }
    }
    if (existsSync(REPLIES_FILE)) chmodSync(REPLIES_FILE, 0o600)
    if (done.length) await call({ action: 'ack', ids: done }, secret)
  } catch (e) {
    if (e.retryable || e.name === 'TimeoutError' || e.name === 'TypeError') {
      const minutes = Math.min(60, b.minutes ? b.minutes * 2 : 10)
      writeFileSync(BACKOFF_FILE, JSON.stringify({ until: Date.now() + minutes * 60_000, minutes }), { mode: 0o600 })
      console.error(`keyring-pull: ${e.message}; backing off ${minutes} min`)
      return
    }
    throw e
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(`keyring-pull: ${e.message}`)
    process.exit(1)
  })
}
