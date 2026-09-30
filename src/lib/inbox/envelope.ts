/**
 * VAULT-1 sealed inbox: opening what Claude's writer sealed for this vault.
 *
 * The writer (scripts/keyring-push.mjs, on Nicolas's Mac) seals a whole list at once:
 *   - ECDH P-256 between a fresh ephemeral key and this vault's inbox public key,
 *   - HKDF-SHA256 over the shared secret (random salt, info bound to the source),
 *   - AES-256-GCM over the JSON list, padded with spaces to a 4 KB bucket, with the
 *     envelope header as additional data,
 *   - then an ECDSA P-256 signature over header + ciphertext with the writer's key, whose
 *     public half is pinned in the app (writerKey.ts).
 *
 * The server stores the envelope and never sees the list. The app checks the signature
 * FIRST and refuses anything unsigned, tampered or signed by another key, before any
 * decryption. Only WebCrypto, no library: the same primitives run in WKWebView, Chrome and Node.
 */

export const INBOX_VERSION = 1
export const PAD_BUCKET = 4096
const LABEL = 'keyring-inbox-v1'

export interface InboxEnvelope {
  v: number
  source: string
  created_at: string
  list_no: number
  epk: { kty: string; crv: string; x: string; y: string }
  salt: string
  iv: string
  ct: string
  sig: string
}

export class InboxError extends Error {
  constructor(
    public kind: 'malformed' | 'bad_signature' | 'decrypt_failed' | 'bad_payload',
    message: string,
  ) {
    super(message)
    this.name = 'InboxError'
  }
}

const enc = new TextEncoder()
const dec = new TextDecoder()
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource

export function b64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}
export function unb64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** The part of the envelope that is both the AES-GCM additional data and the start of what is signed. */
export function envelopeHeader(e: Pick<InboxEnvelope, 'source' | 'created_at' | 'list_no' | 'epk' | 'salt' | 'iv'>): string {
  return [LABEL, e.source, e.created_at, String(e.list_no), e.epk.x, e.epk.y, e.salt, e.iv].join('\n')
}

export function hkdfInfo(source: string): Uint8Array {
  return enc.encode(`${LABEL} aes-gcm ${source}`)
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0

export function parseEnvelope(raw: string): InboxEnvelope {
  let e: InboxEnvelope
  try {
    e = JSON.parse(raw)
  } catch {
    throw new InboxError('malformed', 'Inbox envelope is not JSON')
  }
  const ok =
    e &&
    e.v === INBOX_VERSION &&
    isStr(e.source) &&
    isStr(e.created_at) &&
    !Number.isNaN(Date.parse(e.created_at)) &&
    Number.isInteger(e.list_no) &&
    e.epk &&
    e.epk.kty === 'EC' &&
    e.epk.crv === 'P-256' &&
    isStr(e.epk.x) &&
    isStr(e.epk.y) &&
    isStr(e.salt) &&
    isStr(e.iv) &&
    isStr(e.ct) &&
    isStr(e.sig)
  if (!ok) throw new InboxError('malformed', 'Inbox envelope is missing a field (unsigned or truncated)')
  return e
}

export async function importWriterKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
}

/**
 * Verify, then decrypt. Returns the padded-away JSON text. Throws InboxError.
 * `expectSource` binds the envelope to the row it was read from.
 */
export async function openEnvelope(
  raw: string,
  keys: { recipientPrivateKey: CryptoKey; writerPublicKey: CryptoKey },
  expectSource: string,
): Promise<{ envelope: InboxEnvelope; json: unknown }> {
  const e = parseEnvelope(raw)
  if (e.source !== expectSource) throw new InboxError('malformed', `Envelope is for "${e.source}", not "${expectSource}"`)

  const header = envelopeHeader(e)
  let sigOk = false
  try {
    sigOk = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      keys.writerPublicKey,
      bs(unb64(e.sig)),
      bs(enc.encode(`${header}\n${e.ct}`)),
    )
  } catch {
    sigOk = false
  }
  if (!sigOk) throw new InboxError('bad_signature', 'Signature check failed: this list was not written by Claude’s writer, or was changed')

  let plain: Uint8Array
  try {
    const epk = await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: e.epk.x, y: e.epk.y },
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    )
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: epk }, keys.recipientPrivateKey, 256)
    const hk = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
    const aes = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: bs(unb64(e.salt)), info: bs(hkdfInfo(e.source)) },
      hk,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    )
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bs(unb64(e.iv)), additionalData: bs(enc.encode(header)) },
        aes,
        bs(unb64(e.ct)),
      ),
    )
  } catch {
    throw new InboxError('decrypt_failed', 'Could not open this list with this vault’s inbox key')
  }

  let json: unknown
  try {
    json = JSON.parse(dec.decode(plain).trimEnd())
  } catch {
    throw new InboxError('bad_payload', 'The list inside is not valid JSON')
  }
  return { envelope: e, json }
}
