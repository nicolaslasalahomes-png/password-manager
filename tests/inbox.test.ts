/**
 * VAULT-1 sealed inbox: the writer (scripts/keyring-push.mjs, Node) and the app
 * (src/lib/inbox, WebCrypto) must agree, and the app must refuse anything unsigned, tampered,
 * signed by another key, meant for another vault, or older than a list it already showed.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'

vi.mock('../src/lib/supabase', () => ({ supabase: {} }))

import { seal, toPayload, PAD_BUCKET } from '../scripts/keyring-push.mjs'
import { openEnvelope, importWriterKey, InboxError, unb64 } from '../src/lib/inbox/envelope'
import { toSnapshot, isRollback } from '../src/lib/inbox/needsYou'
import { makeInboxKeyMaterial, unwrapInboxKey, InboxKeyMismatchError } from '../src/lib/inbox/keys'
import { WRITER_SIGNING_PUBLIC_JWK } from '../src/lib/inbox/writerKey'

const { subtle } = globalThis.crypto
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const

let recipient: CryptoKeyPair
let recipientPublicJwk: JsonWebKey
let writer: CryptoKeyPair
let writerPrivateJwk: JsonWebKey
let writerPublic: CryptoKey

const snapshot = {
  list_no: 7,
  created_at: '2026-09-30T13:30:00.000Z',
  items: [
    { id: 'N20', section: 'asap', title: 'Natalia: press Enable (push)', link: 'https://agents.lasalahomes.com/' },
    { id: 'N23', section: 'instant', title: 'Exclude internship applicants from Sal buyer sweeps?', action: 'Recommend yes' },
    { id: 'N9', section: 'think', title: 'Real login for Microsite Creator and Marketing Report' },
  ],
}

beforeAll(async () => {
  recipient = (await subtle.generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair
  recipientPublicJwk = await subtle.exportKey('jwk', recipient.publicKey)
  writer = (await subtle.generateKey(ECDSA, true, ['sign', 'verify'])) as CryptoKeyPair
  writerPrivateJwk = await subtle.exportKey('jwk', writer.privateKey)
  writerPublic = writer.publicKey
})

const sealIt = async (payload = toPayload(snapshot), writerJwk = writerPrivateJwk) =>
  JSON.stringify(await seal(payload, { recipientPublicJwk, writerPrivateJwk: writerJwk }))
const open = (raw: string, writerKey = writerPublic, priv = recipient.privateKey) =>
  openEnvelope(raw, { recipientPrivateKey: priv, writerPublicKey: writerKey }, 'needs_you')

describe('writer and app agree', () => {
  it('a sealed list opens to exactly what was sealed', async () => {
    const { envelope, json } = await open(await sealIt())
    const snap = toSnapshot(json, envelope)
    expect(snap.list_no).toBe(7)
    expect(snap.items.map((i) => i.id)).toEqual(['N20', 'N23', 'N9'])
    expect(snap.items[1].action).toBe('Recommend yes')
  })

  it('pads to 4 KB buckets, so the size does not give away the item count', async () => {
    const small = JSON.parse(await sealIt())
    const bigger = JSON.parse(
      await sealIt(toPayload({ ...snapshot, items: [...snapshot.items, { id: 'N30', section: 'later', title: 'x'.repeat(200) }] })),
    )
    expect(unb64(small.ct).length).toBe(PAD_BUCKET + 16)
    expect(unb64(bigger.ct).length).toBe(unb64(small.ct).length)
  })

  it('the pinned writer key is a valid P-256 verify key', async () => {
    await expect(importWriterKey(WRITER_SIGNING_PUBLIC_JWK)).resolves.toBeTruthy()
  })
})

describe('the app refuses', () => {
  it('a tampered ciphertext', async () => {
    const e = JSON.parse(await sealIt())
    const ct = unb64(e.ct)
    ct[10] ^= 1
    e.ct = Buffer.from(ct).toString('base64')
    await expect(open(JSON.stringify(e))).rejects.toMatchObject({ kind: 'bad_signature' })
  })

  it('a changed header (list number), even though the ciphertext is untouched', async () => {
    const e = JSON.parse(await sealIt())
    e.list_no = 99
    await expect(open(JSON.stringify(e))).rejects.toMatchObject({ kind: 'bad_signature' })
  })

  it('an unsigned envelope', async () => {
    const e = JSON.parse(await sealIt())
    delete e.sig
    await expect(open(JSON.stringify(e))).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('an envelope signed by any other key (a leaked write secret is not enough)', async () => {
    const other = (await subtle.generateKey(ECDSA, true, ['sign', 'verify'])) as CryptoKeyPair
    const raw = await sealIt(toPayload(snapshot), await subtle.exportKey('jwk', other.privateKey))
    await expect(open(raw)).rejects.toMatchObject({ kind: 'bad_signature' })
  })

  it('an envelope sealed for another vault', async () => {
    const otherVault = (await subtle.generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair
    await expect(open(await sealIt(), writerPublic, otherVault.privateKey)).rejects.toMatchObject({ kind: 'decrypt_failed' })
  })

  it('an envelope for another source', async () => {
    await expect(
      openEnvelope(await sealIt(), { recipientPrivateKey: recipient.privateKey, writerPublicKey: writerPublic }, 'other'),
    ).rejects.toBeInstanceOf(InboxError)
  })

  it('a list older than one already shown (rollback)', () => {
    expect(isRollback('2026-09-29T10:00:00Z', '2026-09-30T13:30:00Z')).toBe(true)
    expect(isRollback('2026-09-30T13:30:00Z', '2026-09-30T13:30:00Z')).toBe(false)
    expect(isRollback('2026-09-30T14:00:00Z', null)).toBe(false)
  })

  it('drops malformed items and non-https links instead of trusting them', () => {
    const snap = toSnapshot(
      {
        v: 1,
        source: 'needs_you',
        list_no: 1,
        created_at: '2026-09-30T10:00:00Z',
        items: [
          { id: 'N1', section: 'asap', title: 'ok', link: 'javascript:alert(1)' },
          { id: 'X1', section: 'asap', title: 'bad id' },
          { id: 'N2', section: 'nope', title: 'bad section' },
        ],
      },
      { created_at: '2026-09-30T10:00:00Z', list_no: 1 },
    )
    expect(snap.items).toEqual([{ id: 'N1', section: 'asap', title: 'ok', action: undefined, link: undefined, due: undefined }])
  })
})

describe('the vault inbox key', () => {
  const dek = new Uint8Array(32).fill(7)

  it('the private key is stored only encrypted under the DEK, and unwraps to the stored public key', async () => {
    const m = await makeInboxKeyMaterial(dek)
    expect(m.encrypted_private_key).not.toContain('MIG') // no plaintext PKCS8
    const priv = await unwrapInboxKey(m, dek)
    const raw = await sealIt(toPayload(snapshot))
    // Seal to this key instead and open with the unwrapped private key.
    const e = await seal(toPayload(snapshot), { recipientPublicJwk: m.public_key_jwk, writerPrivateJwk })
    await expect(openEnvelope(JSON.stringify(e), { recipientPrivateKey: priv, writerPublicKey: writerPublic }, 'needs_you')).resolves.toBeTruthy()
    expect(raw).toBeTruthy()
  })

  it('refuses a swapped public key on the server', async () => {
    const m = await makeInboxKeyMaterial(dek)
    const other = await makeInboxKeyMaterial(dek)
    await expect(unwrapInboxKey({ ...m, public_key_jwk: other.public_key_jwk }, dek)).rejects.toBeInstanceOf(InboxKeyMismatchError)
  })
})

describe('writer checks the snapshot before sealing', () => {
  it('rejects duplicate IDs, bad sections, http links and em dashes', () => {
    const base = { list_no: 1, items: [] as unknown[] }
    expect(() => toPayload({ ...base, items: [{ id: 'N1', section: 'asap', title: 'a' }, { id: 'N1', section: 'asap', title: 'b' }] })).toThrow(/twice/)
    expect(() => toPayload({ ...base, items: [{ id: 'N1', section: 'soon', title: 'a' }] })).toThrow(/section/)
    expect(() => toPayload({ ...base, items: [{ id: 'N1', section: 'asap', title: 'a', link: 'http://x.com' }] })).toThrow(/https/)
    expect(() => toPayload({ ...base, items: [{ id: 'N1', section: 'asap', title: 'a \u2014 b' }] })).toThrow(/em dash/)
  })
})
