/**
 * VAULT-2: his replies are sealed in the app and opened only by the reader on his Mac. The reader
 * refuses tampered replies, replies sealed to another key, rows that are not his, and envelopes
 * whose sealed item does not match the row they came in.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'

vi.mock('../src/lib/supabase', () => ({ supabase: {} }))

import { sealReply, quickAnswers, REPLY_PAD, MAX_REPLY_CHARS, type ReplyPayload } from '../src/lib/inbox/reply'
import { READER_PUBLIC_JWK } from '../src/lib/inbox/readerKey'
import { openReply, seenIds, OWNER } from '../scripts/keyring-pull.mjs'

const { subtle } = globalThis.crypto
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const
let readerPub: JsonWebKey
let readerPriv: JsonWebKey

const payload: ReplyPayload = {
  v: 1,
  list_no: 17,
  item_id: 'N23',
  title: 'Exclude internship applicants from Sal buyer sweeps?',
  text: 'Go, and tell Justin',
  sent_at: '2026-09-30T15:42:00.000Z',
}
const rowFor = async (p = payload, pub = readerPub, over: Record<string, unknown> = {}) => ({
  id: '0192f0aa-0000-7000-8000-000000000001',
  user_id: OWNER,
  created_at: '2026-09-30T15:42:01Z',
  list_no: p.list_no,
  item_id: p.item_id,
  envelope: JSON.stringify(await sealReply(p, pub)),
  ...over,
})

beforeAll(async () => {
  const kp = (await subtle.generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair
  readerPub = await subtle.exportKey('jwk', kp.publicKey)
  readerPriv = await subtle.exportKey('jwk', kp.privateKey)
})

describe('a reply goes from the card to the reader', () => {
  it('opens to exactly what he typed, with the item title he saw', async () => {
    const r = await openReply(await rowFor(), readerPriv)
    expect(r).toMatchObject({ list_no: 17, item_id: 'N23', text: 'Go, and tell Justin', title: payload.title })
  })

  it('pads to 1 KB buckets so the length of a reply does not show', async () => {
    const short = JSON.parse((await rowFor()).envelope)
    const longer = JSON.parse((await rowFor({ ...payload, text: 'x'.repeat(300) })).envelope)
    expect(Buffer.from(short.ct, 'base64').length).toBe(REPLY_PAD + 16)
    expect(Buffer.from(longer.ct, 'base64').length).toBe(REPLY_PAD + 16)
  })

  it('the pinned reader key is a public P-256 key and nothing more', async () => {
    expect(READER_PUBLIC_JWK).not.toHaveProperty('d')
    await expect(subtle.importKey('jwk', READER_PUBLIC_JWK, ECDH, false, [])).resolves.toBeTruthy()
  })

  it('refuses empty and over-long replies before sealing', async () => {
    await expect(sealReply({ ...payload, text: '  ' }, readerPub)).rejects.toThrow(/Empty/)
    await expect(sealReply({ ...payload, text: 'x'.repeat(MAX_REPLY_CHARS + 1) }, readerPub)).rejects.toThrow(/limited/)
  })
})

describe('the reader refuses', () => {
  it('a tampered ciphertext', async () => {
    const row = await rowFor()
    const e = JSON.parse(row.envelope)
    const ct = Buffer.from(e.ct, 'base64')
    ct[5] ^= 1
    e.ct = ct.toString('base64')
    await expect(openReply({ ...row, envelope: JSON.stringify(e) }, readerPriv)).rejects.toThrow(/could not be opened/)
  })

  it('a reply moved to another item (row and envelope disagree)', async () => {
    await expect(openReply(await rowFor(payload, readerPub, { item_id: 'N20' }), readerPriv)).rejects.toThrow(/does not match/)
  })

  it('an envelope whose header was rewritten to another item', async () => {
    const row = await rowFor()
    const e = JSON.parse(row.envelope)
    e.item_id = 'N20'
    await expect(openReply({ ...row, item_id: 'N20', envelope: JSON.stringify(e) }, readerPriv)).rejects.toThrow(/could not be opened/)
  })

  it('a row that is not the owner’s', async () => {
    await expect(openReply(await rowFor(payload, readerPub, { user_id: 'f1bd05f3-8524-4edc-921e-8e622a2a1200' }), readerPriv)).rejects.toThrow(/owner/)
  })

  it('a reply sealed to any other key', async () => {
    const other = (await subtle.generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair
    const row = await rowFor(payload, await subtle.exportKey('jwk', other.publicKey))
    await expect(openReply(row, readerPriv)).rejects.toThrow(/could not be opened/)
  })
})

describe('small pieces', () => {
  it('one-tap answers follow the recommendation line', () => {
    const labels = (a: string | undefined) => quickAnswers(a).map((q) => (q.recommended ? `*${q.label}` : q.label))
    expect(labels('Recommend go')).toEqual(['*Go', 'No'])
    expect(labels('What is going on.\nRecommend: go')).toEqual(['*Go', 'No'])
    expect(labels('Recommend: yes, it only affects interns')).toEqual(['*Yes', 'No'])
    expect(labels('Recommend: no')).toEqual(['Yes', '*No'])
    expect(labels('Two ways.\n(a) keep her logo wall shot\n(b) ask for a new one\n(c) leave it\nRecommend: (b)')).toEqual(['(a)', '*(b)', '(c)'])
    expect(labels(undefined)).toEqual(['Yes', 'No'])
  })

  it('the reader never writes a row twice', () => {
    const ids = seenIds('{"row_id":"a"}\n{"row_id":"b"}\nnot json\n')
    expect([...ids]).toEqual(['a', 'b'])
  })
})
