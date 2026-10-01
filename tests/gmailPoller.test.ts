/**
 * KEY-2FA-1 timing fixture: how long a 2FA email waits before the popover
 * fires while another account is bootstrapping its 200-message backfill.
 * Gmail is a fake `fetch` with 150 ms per call; the real gmail.ts client and
 * the real shared rate limiter are used. No network, no Supabase.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/lib/supabase', () => ({ supabase: {} }))
vi.mock('../src/lib/ai/classifier', () => ({ classifyEmail: vi.fn() }))
vi.mock('../src/lib/google/oauth', () => ({ GoogleOAuthError: class extends Error {} }))
vi.mock('../src/lib/google/twoFactor', () => ({
  AUTO_POP_THRESHOLD: 0.6,
  detectTwoFactor: (i: { subject: string }) =>
    i.subject.includes('verification code') ? { code: '482913', confidence: 1 } : null,
}))

interface Acct {
  id: string
  email: string
  status: string
  history_id: string | null
}
const accounts = new Map<string, Acct>()
const cached = new Set<string>()

vi.mock('../src/lib/google/tokens', () => ({
  listAccounts: async () => [...accounts.values()].map((a) => ({ ...a })),
  getAccessToken: async (a: Acct) => `tok-${a.id}`,
  updateHistoryCursor: async (id: string, h: string) => {
    accounts.get(id)!.history_id = h
  },
}))
vi.mock('../src/lib/email', () => ({
  getAiInboxEnabled: async () => false,
  getAnthropicApiKey: async () => null,
  getAuthSenders: async () => [],
  setMessageImportance: async () => {},
  setPoppedAt: async () => {},
  upsertCachedMessage: async (_u: string, _a: string, parsed: { id: string }) => {
    await new Promise((r) => setTimeout(r, 100)) // encrypt + Supabase upsert
    const inserted = !cached.has(parsed.id)
    cached.add(parsed.id)
    return { inserted, row: { id: `row-${parsed.id}`, popped_at: null } }
  },
}))

const GMAIL_LATENCY_MS = 150
const ARRIVAL_MS = 20_000 // both 2FA emails land 20 s after the poller starts

function b64url(s: string) {
  return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
}
function message(id: string, receivedMs: number, subject: string) {
  return {
    id,
    threadId: id,
    historyId: 'h-start',
    internalDate: String(receivedMs),
    snippet: subject,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: subject },
        { name: 'From', value: 'SevenRooms <noreply@auth.sevenrooms.com>' },
      ],
      body: { data: b64url(subject) },
    },
  }
}

function fakeGmail(t0: number) {
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    await new Promise((r) => setTimeout(r, GMAIL_LATENCY_MS))
    const url = new URL(String(input))
    const token = new Headers(init?.headers).get('Authorization')!.replace('Bearer tok-', '')
    const path = url.pathname.replace('/gmail/v1/users/me', '')
    const arrived = Date.now() - t0 >= ARRIVAL_MS
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
    if (path === '/profile') return json({ historyId: 'h-start' })
    if (path === '/messages' && url.searchParams.get('q') === 'in:inbox') {
      return json({ messages: Array.from({ length: 200 }, (_, i) => ({ id: `${token}-old${i}`, threadId: 't' })) })
    }
    if (path === '/history') {
      const start = url.searchParams.get('startHistoryId')
      if (arrived && start !== 'h-after') {
        return json({ historyId: 'h-after', history: [{ id: '1', messagesAdded: [{ message: { id: `${token}-2fa`, threadId: 't' } }] }] })
      }
      return json({ historyId: start })
    }
    const m = /^\/messages\/([^/]+)$/.exec(path)
    if (m) {
      const id = m[1]
      return id.endsWith('-2fa')
        ? json(message(id, t0 + ARRIVAL_MS, 'Your verification code'))
        : json(message(id, t0 - 86_400_000, 'Newsletter'))
    }
    return new Response('not found', { status: 404 })
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  ;(globalThis as unknown as { window: unknown }).window = globalThis
  accounts.clear()
  cached.clear()
  // A: just (re)connected, no cursor yet. B: steady state.
  accounts.set('A', { id: 'A', email: 'nicolassutcliffe@gmail.com', status: 'ok', history_id: null })
  accounts.set('B', { id: 'B', email: 'nicolaslasalahomes@gmail.com', status: 'ok', history_id: 'h-start' })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Gmail poller latency while another account bootstraps', () => {
  it('pops a 2FA email within one poll interval on both accounts', async () => {
    const t0 = Date.now()
    vi.stubGlobal('fetch', fakeGmail(t0))
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    const { startGmailPoller } = await import('../src/lib/google/poller')
    const popped = new Map<string, number>()
    const handle = startGmailPoller({
      dek: new Uint8Array(32),
      userId: 'u',
      callbacks: {
        on2faDetected: (account) => {
          if (!popped.has(account.id)) popped.set(account.id, Date.now() - t0 - ARRIVAL_MS)
        },
      },
    })
    // Step the clock until both pop, or 15 minutes pass.
    for (let i = 0; i < 900 && popped.size < 2; i++) await vi.advanceTimersByTimeAsync(1_000)
    handle.stop()
    console.info(
      `[KEY-2FA-1 fixture] 2FA wait: B (steady) ${popped.get('B') ?? 'never'} ms, ` +
        `A (bootstrapping) ${popped.get('A') ?? 'never'} ms`,
    )
    // 10 s poll interval + a few simulated calls.
    expect(popped.get('B')).toBeLessThan(12_000)
    expect(popped.get('A')).toBeLessThan(12_000)
  }, 60_000)
})
