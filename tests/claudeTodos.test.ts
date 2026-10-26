/**
 * KEY-TODO-1: message aggregation to-dos. The writer and the app agree; the app creates each to-do
 * once, ticks off done ones, updates Claude's changes only when Nicolas has not edited the task,
 * and never deletes anything.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'

vi.mock('../src/lib/supabase', () => ({ supabase: {} }))

import { seal, toTodosPayload } from '../scripts/keyring-push.mjs'
import { openEnvelope } from '../src/lib/inbox/envelope'
import { toTodoFeed, planTodoSync, revision, taskSig, dueAt, type TodoFeed } from '../src/lib/inbox/todos'
import type { VaultItemRow } from '../src/lib/items'

const { subtle } = globalThis.crypto
let recipient: CryptoKeyPair
let recipientPublicJwk: JsonWebKey
let writer: CryptoKeyPair
let writerPrivateJwk: JsonWebKey

beforeAll(async () => {
  recipient = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
  recipientPublicJwk = await subtle.exportKey('jwk', recipient.publicKey)
  writer = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  writerPrivateJwk = await subtle.exportKey('jwk', writer.privateKey)
})

const list = {
  source: 'todos',
  list_no: 1,
  todos: [
    { id: 'e-token', title: 'New Supabase token for Justin', due: '2026-10-26', priority: 'high', origin: 'email', note: 'Mac + Hetzner' },
    { id: 'w-filter', title: 'Fix mobile area filter', due: '2026-10-28', priority: 'medium', origin: 'whatsapp' },
    { id: 'e-es', title: 'lasalahomes.es redirect', due: '2026-10-27', priority: 'low', origin: 'email', done: true },
  ],
}

const row = (id: string, claudeId: string, over: Partial<VaultItemRow> = {}): VaultItemRow => ({
  id,
  user_id: 'u',
  type: 'task',
  title: 'x',
  folder: 'Claude',
  tags: [`claude:${claudeId}`],
  visibility_tier: 'medium',
  encrypted_data: '',
  iv: '',
  url: null,
  username_hint: null,
  created_at: '2026-10-26T10:00:00Z',
  updated_at: '2026-10-26T10:00:00Z',
  last_accessed_at: null,
  due_at: '2026-10-26T08:00:00Z',
  priority: 'high',
  completed_at: null,
  ...over,
})

describe('claude to-dos', () => {
  it('a sealed list opens to what was sealed', async () => {
    const raw = JSON.stringify(await seal(toTodosPayload(list), { recipientPublicJwk, writerPrivateJwk }))
    const { envelope, json } = await openEnvelope(raw, { recipientPrivateKey: recipient.privateKey, writerPublicKey: writer.publicKey }, 'todos')
    const feed = toTodoFeed(json, envelope)
    expect(feed.todos.map((t) => [t.id, t.priority, !!t.done])).toEqual([
      ['e-token', 'high', false],
      ['w-filter', 'medium', false],
      ['e-es', 'low', true],
    ])
  })

  it('the writer refuses a to-do without a usable deadline or priority', () => {
    const bad = (o: object) => () => toTodosPayload({ list_no: 1, todos: [{ ...list.todos[0], ...o }] })
    expect(bad({ due: 'soon' })).toThrow(/due/)
    expect(bad({ priority: 'urgent' })).toThrow(/priority/)
    expect(bad({ link: 'http://x.example' })).toThrow(/https/)
  })

  it('creates new ones once, skips done ones it never had, ticks off done ones it has', () => {
    const feed = toTodoFeed({ v: 1, ...toTodosPayload(list) }, { ...toTodosPayload(list) }) as TodoFeed
    const fresh = planTodoSync(feed, [], {}, {})
    expect(fresh.create.map((t) => t.id)).toEqual(['e-token', 'w-filter'])

    const rows = [row('r1', 'e-token'), row('r2', 'w-filter'), row('r3', 'e-es')]
    const applied = Object.fromEntries(feed.todos.map((t) => [t.id, { rev: revision(t), sig: 'S' }]))
    const sigs = { r1: 'S', r2: 'S', r3: 'S' }
    const again = planTodoSync(feed, rows, applied, sigs)
    expect(again.create).toEqual([])
    expect(again.update).toEqual([])
    expect(again.complete.map((c) => c.row.id)).toEqual(['r3'])
    // already ticked off (by him or before): left alone
    expect(planTodoSync(feed, [row('r3', 'e-es', { completed_at: '2026-10-26T11:00:00Z' })], applied, sigs).complete).toEqual([])
  })

  it("updates Claude's changes only while he has not edited the task", () => {
    const feed = toTodoFeed({ v: 1, ...toTodosPayload(list) }, { ...toTodosPayload(list) }) as TodoFeed
    const old = { rev: 'older', sig: 'S' }
    const rows = [row('r1', 'e-token')]
    expect(planTodoSync(feed, rows, { 'e-token': old }, { r1: 'S' }).update.map((u) => u.row.id)).toEqual(['r1'])
    expect(planTodoSync(feed, rows, { 'e-token': old }, { r1: 'HE-EDITED' }).update).toEqual([])
    expect(planTodoSync(feed, rows, {}, { r1: 'S' }).update).toEqual([], 'unknown history: treat as his')
  })

  it('a date-only deadline is 09:00 local, and the fingerprint follows the content', async () => {
    expect(new Date(dueAt('2026-10-28')).getHours()).toBe(9)
    const a = await taskSig('t', '2026-10-28T08:00:00.000Z', 'high', 'note')
    expect(await taskSig('t', '2026-10-28T08:00:00Z', 'high', 'note')).toBe(a)
    expect(await taskSig('t', '2026-10-28T08:00:00Z', 'high', 'note!')).not.toBe(a)
  })
})
