/**
 * KEY-PERF-1: the inbox list must never pull email bodies. Selecting 1,000
 * encrypted payloads (44 MB) on every inbox open timed out and took the nano
 * database down on 2026-09-30. These tests pin the query shapes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Call = { table: string; select?: string; range?: [number, number]; in?: string[]; update?: Record<string, unknown> }
const calls: Call[] = []
let tableRows: Array<Record<string, unknown>> = []

function builder(table: string) {
  const call: Call = { table }
  calls.push(call)
  let result: () => { data: unknown; error: null } = () => ({ data: tableRows, error: null })
  const b: Record<string, unknown> = {
    select(cols: string) {
      call.select = cols
      return b
    },
    order: () => b,
    eq: () => b,
    is: () => b,
    gt: () => b,
    limit: () => b,
    range(from: number, to: number) {
      call.range = [from, to]
      result = () => ({ data: tableRows.slice(from, to + 1), error: null })
      return b
    },
    in(_col: string, ids: string[]) {
      call.in = ids
      result = () => ({ data: tableRows.filter((r) => ids.includes(r.id as string)), error: null })
      return b
    },
    update(values: Record<string, unknown>) {
      call.update = values
      result = () => ({ data: null, error: null })
      return b
    },
    then(resolve: (v: unknown) => void) {
      resolve(result())
    },
  }
  return b
}

vi.mock('../src/lib/supabase', () => ({ supabase: { from: (t: string) => builder(t) } }))
vi.mock('../src/lib/desktop', () => ({ getStoreValue: async () => null, setStoreValue: async () => {} }))

import { encryptJson } from '../src/lib/encryption'
import { getCachedPayloads, listCachedMessages, resolveHeaders } from '../src/lib/email'

const dek = new Uint8Array(32).fill(7)

beforeEach(() => {
  calls.length = 0
  tableRows = []
})

describe('inbox list query', () => {
  it('never selects encrypted_payload and pages past the 1,000-row cap', async () => {
    tableRows = Array.from({ length: 1191 }, (_, i) => ({ id: `r${i}` }))
    const seenPages: number[] = []
    const rows = await listCachedMessages({ limit: 5000, onPage: (so) => seenPages.push(so.length) })

    expect(rows).toHaveLength(1191)
    expect(seenPages).toEqual([500, 1000, 1191])
    for (const c of calls) expect(c.select).not.toMatch(/encrypted_payload/)
    expect(calls.map((c) => c.range)).toEqual([
      [0, 499],
      [500, 999],
      [1000, 1499],
    ])
  })

  it('fetches bodies at most 10 per request', async () => {
    tableRows = Array.from({ length: 25 }, (_, i) => ({ id: `r${i}` }))
    await getCachedPayloads(tableRows.map((r) => r.id as string))
    expect(calls.map((c) => c.in?.length)).toEqual([10, 10, 5])
  })
})

describe('resolveHeaders', () => {
  it('decrypts stored headers without fetching bodies, and backfills legacy rows', async () => {
    const header = { subject: 'Security alert', snippet: 'You allowed Keyring', fromName: 'Google', labelIds: ['INBOX'] }
    const h = await encryptJson(header, dek)
    const payload = { ...header, subject: 'Old one', bodyText: 'long body', bodyHtml: '<p>long</p>' }
    const p = await encryptJson(payload, dek)

    const withHeader = { id: 'a', encrypted_header: h.ciphertext, iv_header: h.iv }
    const legacy = { id: 'b', encrypted_header: null, iv_header: null }
    tableRows = [{ ...legacy, encrypted_payload: p.ciphertext, iv_payload: p.iv }]

    const out = await resolveHeaders([withHeader, legacy] as never, dek)

    expect(out.a).toEqual(header)
    expect(out.b.subject).toBe('Old one')
    // Only the legacy row's body was fetched, and only header columns were written.
    const bodyFetches = calls.filter((c) => c.select?.includes('encrypted_payload'))
    expect(bodyFetches.map((c) => c.in)).toEqual([['b']])
    const writes = calls.filter((c) => c.update)
    expect(writes).toHaveLength(1)
    expect(Object.keys(writes[0].update!).sort()).toEqual(['encrypted_header', 'iv_header'])
  })
})

describe('backfill safety', () => {
  it('stops with ServerStrainError when the database returns a 5xx', async () => {
    const { ServerStrainError } = await import('../src/lib/email')
    const { supabase } = await import('../src/lib/supabase')
    const from = supabase.from
    ;(supabase as { from: unknown }).from = () => {
      const b: Record<string, unknown> = {
        select: () => b,
        in: () => b,
        then: (resolve: (v: unknown) => void) =>
          resolve({ data: null, error: { message: 'timeout' }, status: 503 }),
      }
      return b
    }
    try {
      await expect(getCachedPayloads(['x'])).rejects.toBeInstanceOf(ServerStrainError)
    } finally {
      ;(supabase as { from: unknown }).from = from
    }
  })
})
