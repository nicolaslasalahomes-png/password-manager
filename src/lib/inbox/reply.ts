/**
 * VAULT-2 (Nicolas, 30 Sep 2026): "make it so that I can type in a response for each of these and
 * they reach you". A reply is sealed on his device to the reader's pinned key, the mirror image of
 * VAULT-1: ECDH P-256 (fresh ephemeral key) + HKDF-SHA256 + AES-256-GCM, padded to 1 KB buckets,
 * header as additional data. The header carries list_no and item_id, which are also plaintext
 * columns (not secret, needed for the "Sent" state); the reader checks all three agree.
 *
 * Authenticity comes from the table: only his signed-in account can insert (RLS), and the reader
 * checks every row belongs to him.
 */
import { b64 } from './envelope'

export const REPLY_LABEL = 'keyring-outbox-v1'
export const REPLY_PAD = 1024
export const MAX_REPLY_CHARS = 2000

export interface ReplyPayload {
  v: 1
  list_no: number
  item_id: string
  /** The item's title as he saw it, so the reader knows what he meant even if the list moved on. */
  title: string
  text: string
  sent_at: string
}

export interface ReplyEnvelope {
  v: 1
  list_no: number
  item_id: string
  epk: { kty: 'EC'; crv: 'P-256'; x: string; y: string }
  salt: string
  iv: string
  ct: string
}

const enc = new TextEncoder()
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource

export function replyHeader(e: Pick<ReplyEnvelope, 'list_no' | 'item_id' | 'epk' | 'salt' | 'iv'>): string {
  return [REPLY_LABEL, String(e.list_no), e.item_id, e.epk.x, e.epk.y, e.salt, e.iv].join('\n')
}

function pad(json: string): Uint8Array {
  const bytes = enc.encode(json)
  const out = new Uint8Array(Math.ceil((bytes.length + 1) / REPLY_PAD) * REPLY_PAD).fill(0x20)
  out.set(bytes)
  return out
}

export async function sealReply(p: ReplyPayload, readerPublicJwk: JsonWebKey): Promise<ReplyEnvelope> {
  if (!p.text.trim()) throw new Error('Empty reply')
  if (p.text.length > MAX_REPLY_CHARS) throw new Error(`Replies are limited to ${MAX_REPLY_CHARS} characters`)
  const reader = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: readerPublicJwk.x, y: readerPublicJwk.y },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const eph = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
  const epk = await crypto.subtle.exportKey('jwk', eph.publicKey)
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: reader }, eph.privateKey, 256)
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const hk = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  const aes = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: bs(salt), info: bs(enc.encode(`${REPLY_LABEL} aes-gcm`)) },
    hk,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  )
  const head = {
    list_no: p.list_no,
    item_id: p.item_id,
    epk: { kty: 'EC' as const, crv: 'P-256' as const, x: epk.x as string, y: epk.y as string },
    salt: b64(salt),
    iv: b64(iv),
  }
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: bs(iv), additionalData: bs(enc.encode(replyHeader(head))) },
      aes,
      bs(pad(JSON.stringify(p))),
    ),
  )
  return { v: 1, ...head, ct: b64(ct) }
}

/** The one-tap answers for an Instant item: its recommendation ("Go" or "Yes") and "No". */
export function quickAnswers(action: string | undefined): string[] {
  const m = /recommend(?:ed|s)?[:\s]+(go|yes)\b/i.exec(action ?? '')
  const yes = m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : 'Yes'
  return [yes, 'No']
}
