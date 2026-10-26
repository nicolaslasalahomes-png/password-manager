/**
 * KEY-CAL-1: Claude's calendar feed goes through the same sealed inbox as the Needs-you list.
 * The writer and the app must agree, the app must drop malformed events, and a feed must not
 * open as a Needs-you list (or the other way round).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'

vi.mock('../src/lib/supabase', () => ({ supabase: {} }))

import { seal, toCalendarPayload, toPayload } from '../scripts/keyring-push.mjs'
import { openEnvelope, InboxError } from '../src/lib/inbox/envelope'
import { toCalendarFeed, eventDays } from '../src/lib/inbox/calendarFeed'

const { subtle } = globalThis.crypto
let recipient: CryptoKeyPair
let recipientPublicJwk: JsonWebKey
let writer: CryptoKeyPair
let writerPrivateJwk: JsonWebKey

const feed = {
  source: 'calendar',
  list_no: 1,
  events: [
    { id: 'g-briefing-1102', title: 'TEAM BRIEFING', start: '2026-11-02T09:30:00+01:00', end: '2026-11-02T10:30:00+01:00', all_day: false, origin: 'google', link: 'https://meet.google.com/dqk-oueb-vcg' },
    { id: 'e-ai-training', title: 'AI training deadline', start: '2026-11-30', all_day: true, origin: 'email', note: 'Certihub, 4 hours online' },
  ],
}

beforeAll(async () => {
  recipient = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
  recipientPublicJwk = await subtle.exportKey('jwk', recipient.publicKey)
  writer = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  writerPrivateJwk = await subtle.exportKey('jwk', writer.privateKey)
})

const sealIt = async (payload: unknown) => JSON.stringify(await seal(payload, { recipientPublicJwk, writerPrivateJwk }))
const open = (raw: string, source: string) =>
  openEnvelope(raw, { recipientPrivateKey: recipient.privateKey, writerPublicKey: writer.publicKey }, source)

describe('calendar feed', () => {
  it('a sealed feed opens to exactly what was sealed', async () => {
    const { envelope, json } = await open(await sealIt(toCalendarPayload(feed)), 'calendar')
    const f = toCalendarFeed(json, envelope)
    expect(f.events.map((e) => e.id)).toEqual(['g-briefing-1102', 'e-ai-training'])
    expect(f.events[0].link).toBe('https://meet.google.com/dqk-oueb-vcg')
    expect(f.events[1].all_day).toBe(true)
  })

  it('a feed is refused where a Needs-you list is expected, and the other way round', async () => {
    await expect(open(await sealIt(toCalendarPayload(feed)), 'needs_you')).rejects.toBeInstanceOf(InboxError)
    const list = toPayload({ list_no: 1, created_at: '2026-10-26T10:00:00Z', items: [{ id: 'N1', section: 'asap', title: 'x' }] })
    await expect(open(await sealIt(list), 'calendar')).rejects.toBeInstanceOf(InboxError)
  })

  it('the writer refuses bad events', () => {
    const bad = (e: object) => () => toCalendarPayload({ list_no: 1, events: [{ ...feed.events[0], ...e }] })
    expect(bad({ link: 'http://insecure.example' })).toThrow(/https/)
    expect(bad({ origin: 'telepathy' })).toThrow(/origin/)
    expect(bad({ start: '2026-11-02' })).toThrow(/ISO time/)
    expect(bad({ title: 'a — b' })).toThrow(/em dash/)
    expect(() => toCalendarPayload({ list_no: 1, events: [feed.events[1], feed.events[1]] })).toThrow(/twice/)
  })

  it('the app drops malformed events instead of trusting them', () => {
    const header = { created_at: '2026-10-26T10:00:00.000Z', list_no: 3 }
    const f = toCalendarFeed(
      {
        v: 1,
        source: 'calendar',
        ...header,
        events: [
          feed.events[0],
          { ...feed.events[1], link: 'javascript:alert(1)' },
          { id: 'no-title', start: '2026-11-01', all_day: true, origin: 'claude' },
          { id: 'bad-day', title: 'x', start: 'tomorrow', all_day: true, origin: 'claude' },
          { id: 'bad-origin', title: 'x', start: '2026-11-01', all_day: true, origin: 'nope' },
          feed.events[0],
        ],
      },
      header,
    )
    expect(f.events.map((e) => e.id)).toEqual(['g-briefing-1102', 'e-ai-training'])
    expect(f.events[1].link).toBeUndefined()
    expect(() => toCalendarFeed({ v: 1, source: 'calendar', ...header, list_no: 4, events: [] }, header)).toThrow(/match/)
  })

  it('an all-day event covers its days with an exclusive end', () => {
    expect(eventDays({ id: 'a', title: 'x', start: '2026-11-21', end: '2026-11-22', all_day: true, origin: 'google' })).toEqual(['2026-11-21'])
    expect(eventDays({ id: 'b', title: 'x', start: '2026-12-30', end: '2027-01-02', all_day: true, origin: 'google' })).toEqual([
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
    ])
  })
})
