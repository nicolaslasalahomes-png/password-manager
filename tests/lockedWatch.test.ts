/**
 * KEY-2FA-2: "While the vault is locked yes, while its 2FA locked no".
 *
 * - polling continues after the idle lock (locked watch pops codes)
 * - the stronger lock (signed out / email code owed) stops it and wipes
 * - the popover payload while locked carries the code and nothing else
 * - nothing else is readable while locked: only three Gmail read paths,
 *   no Supabase writes, no DEK, a code popped while locked never pops twice
 *
 * Gmail is a fake; the real gmail.ts parser and the real 2FA detector run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/lib/supabase', () => ({ supabase: {} }))
vi.mock('../src/lib/ai/classifier', () => ({ classifyEmail: vi.fn() }))
vi.mock('../src/lib/google/oauth', () => ({
  GoogleOAuthError: class extends Error {},
  getEffectiveClientId: async () => 'client-id',
  getEffectiveClientSecret: async () => 'client-secret',
}))
vi.mock('../src/lib/encryption', () => ({
  decryptJson: async (c: string) => `refresh-for-${c}`,
}))

// Unlocked poller deps (used by the "no second pop after unlock" test).
const dbAccounts = new Map<string, { id: string; email: string; status: string; history_id: string | null }>()
const upserts: string[] = []
vi.mock('../src/lib/google/tokens', () => ({
  listAccounts: async () => [...dbAccounts.values()].map((a) => ({ ...a })),
  getAccessToken: async (a: { id: string }) => `tok-${a.id}`,
  updateHistoryCursor: async (id: string, h: string) => {
    dbAccounts.get(id)!.history_id = h
  },
}))
vi.mock('../src/lib/email', () => ({
  getAiInboxEnabled: async () => false,
  getAnthropicApiKey: async () => null,
  getAuthSenders: async () => [],
  setMessageImportance: async () => {},
  setPoppedAt: async () => {},
  upsertCachedMessage: async (_u: string, _a: string, parsed: { id: string }) => {
    const inserted = !upserts.includes(parsed.id)
    upserts.push(parsed.id)
    return { inserted, row: { id: `row-${parsed.id}`, popped_at: null } }
  },
}))

import {
  mustWipeGmailTokens,
  popoverPayloadFor,
  startLockedGmailWatch,
  watchModeFor,
  type LockedWatchDeps,
} from '../src/lib/google/lockedWatch'
import { armLockedWatch, wipeLockedWatch } from '../src/lib/google/watchArm'
import { resetPopLedger } from '../src/lib/google/popLedger'
import { startGmailPoller } from '../src/lib/google/poller'
import type { EmailAccountRow } from '../src/lib/google/tokens'

// ── A fake mailbox behind a fake Rust watch ────────────────────────────────

function b64url(s: string) {
  return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
}

interface Mail {
  id: string
  history: number
  subject: string
  body: string
  receivedMs: number
}

function fakeMailbox() {
  const mails: Mail[] = []
  let historyId = 100
  return {
    get historyId() {
      return historyId
    },
    deliver(id: string, subject: string, body: string, receivedMs = Date.now()) {
      historyId += 1
      mails.push({ id, history: historyId, subject, body, receivedMs })
    },
    respond(path: string): Response {
      if (path === '/profile') return Response.json({ historyId: String(historyId) })
      const h = /^\/history\?startHistoryId=(\d+)&historyTypes=messageAdded$/.exec(path)
      if (h) {
        const start = Number(h[1])
        const added = mails.filter((m) => m.history > start)
        return Response.json({
          historyId: String(historyId),
          history: added.map((m) => ({
            id: String(m.history),
            messagesAdded: [{ message: { id: m.id, threadId: m.id } }],
          })),
        })
      }
      const m = /^\/messages\/([A-Za-z0-9]+)\?format=full$/.exec(path)
      if (m) {
        const mail = mails.find((x) => x.id === m[1])
        if (!mail) return new Response('not found', { status: 404 })
        return Response.json({
          id: mail.id,
          threadId: mail.id,
          internalDate: String(mail.receivedMs),
          snippet: mail.body.slice(0, 80),
          labelIds: ['INBOX'],
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'Subject', value: mail.subject },
              { name: 'From', value: 'SevenRooms <no-reply@sevenrooms.com>' },
            ],
            body: { data: b64url(mail.body) },
          },
        })
      }
      return new Response('refused', { status: 400 })
    },
  }
}

/** Same rule as src-tauri/src/gmail_watch.rs checked_gmail_url. */
const RUST_ALLOWED = [
  /^\/profile$/,
  /^\/history\?startHistoryId=\d+&historyTypes=messageAdded$/,
  /^\/messages\/[A-Za-z0-9]{1,64}\?format=full$/,
]

function fakeRust(box: ReturnType<typeof fakeMailbox>) {
  let armed: string[] = ['acc1']
  const calls: Array<{ accountId: string; path: string }> = []
  const deps: LockedWatchDeps = {
    armedAccountIds: async () => [...armed],
    listAccountCursors: async () => [
      { id: 'acc1', email: 'nicolassutcliffe@gmail.com', history_id: String(box.historyId), status: 'ok' },
    ],
    fetcherFor: (accountId) => async (path) => {
      calls.push({ accountId, path })
      if (!armed.includes(accountId)) throw new Error('Account is not armed')
      if (!RUST_ALLOWED.some((r) => r.test(path))) throw new Error(`Path not allowed: ${path}`)
      return box.respond(path)
    },
    getAuthSenders: async () => [],
  }
  return {
    deps,
    calls,
    wipe: async () => {
      armed = []
    },
  }
}

const CODE_MAIL = 'Your SevenRooms verification code is 482913. It expires in 10 minutes.'

beforeEach(() => {
  resetPopLedger()
  dbAccounts.clear()
  upserts.length = 0
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('lock state mapping', () => {
  const base = { desktop: true, signedIn: true, mfaPending: false }
  it('ordinary vault lock (idle or Lock) keeps the watch on', () => {
    expect(watchModeFor({ ...base, vault: 'locked' })).toBe('locked')
    expect(watchModeFor({ ...base, vault: 'unlocked' })).toBe('unlocked')
    expect(mustWipeGmailTokens({ authLoading: false, signedIn: true, mfaPending: false })).toBe(false)
  })
  it('the 2FA lock and sign-out turn it off and wipe the tokens', () => {
    expect(watchModeFor({ ...base, mfaPending: true, vault: 'locked' })).toBe('off')
    expect(watchModeFor({ ...base, mfaPending: true, vault: 'unlocked' })).toBe('off')
    expect(watchModeFor({ ...base, signedIn: false, vault: 'locked' })).toBe('off')
    expect(mustWipeGmailTokens({ authLoading: false, signedIn: true, mfaPending: true })).toBe(true)
    expect(mustWipeGmailTokens({ authLoading: false, signedIn: false, mfaPending: false })).toBe(true)
    // Still loading the session: decide nothing yet.
    expect(mustWipeGmailTokens({ authLoading: true, signedIn: false, mfaPending: false })).toBe(false)
  })
  it('web build never watches', () => {
    expect(watchModeFor({ ...base, desktop: false, vault: 'locked' })).toBe('off')
  })
})

describe('locked watch', () => {
  it('keeps popping fresh codes after the idle lock', async () => {
    const box = fakeMailbox()
    const rust = fakeRust(box)
    const popped: Array<ReturnType<typeof popoverPayloadFor>> = []
    const watch = startLockedGmailWatch({
      deps: rust.deps,
      autoStart: false,
      callbacks: { on2faDetected: (a, p, m) => popped.push(popoverPayloadFor(a, p, m)) },
    })
    await watch.tickNow() // picks up the stored cursor, nothing new
    expect(popped).toHaveLength(0)

    box.deliver('m1', 'Your verification code', CODE_MAIL)
    box.deliver('m2', 'Weekly newsletter', 'Nothing to see here, just news.')
    await watch.tickNow()
    expect(popped).toHaveLength(1)
    expect(popped[0].code).toBe('482913')
    expect(popped[0].accountEmail).toBe('nicolassutcliffe@gmail.com')

    // The next code also pops; the first one never pops again.
    box.deliver('m3', 'Your verification code', CODE_MAIL.replace('482913', '771204'))
    await watch.tickNow()
    await watch.tickNow()
    expect(popped.map((p) => p.code)).toEqual(['482913', '771204'])
    watch.stop()
  })

  it('popover payload carries the code and sender only, nothing from the vault', async () => {
    const box = fakeMailbox()
    const rust = fakeRust(box)
    const popped: Array<ReturnType<typeof popoverPayloadFor>> = []
    const watch = startLockedGmailWatch({
      deps: rust.deps,
      autoStart: false,
      callbacks: { on2faDetected: (a, p, m) => popped.push(popoverPayloadFor(a, p, m)) },
    })
    await watch.tickNow()
    box.deliver('m1', 'Your verification code', CODE_MAIL)
    await watch.tickNow()
    expect(Object.keys(popped[0]).sort()).toEqual(
      ['accountEmail', 'accountId', 'code', 'fromName', 'gmailMessageId', 'magicLink', 'receivedAt', 'subject'].sort(),
    )
    watch.stop()
  })

  it('does not pop old mail', async () => {
    const box = fakeMailbox()
    const rust = fakeRust(box)
    const popped: string[] = []
    const watch = startLockedGmailWatch({
      deps: rust.deps,
      autoStart: false,
      callbacks: { on2faDetected: (_a, p) => popped.push(p.id) },
    })
    await watch.tickNow()
    box.deliver('old', 'Your verification code', CODE_MAIL, Date.now() - 60 * 60 * 1000)
    await watch.tickNow()
    expect(popped).toEqual([])
    watch.stop()
  })

  it('reads Gmail only through the three allowed read paths, never writes', async () => {
    const box = fakeMailbox()
    const rust = fakeRust(box)
    const watch = startLockedGmailWatch({
      deps: rust.deps,
      autoStart: false,
      callbacks: { on2faDetected: () => {} },
    })
    await watch.tickNow()
    box.deliver('m1', 'Your verification code', CODE_MAIL)
    await watch.tickNow()
    expect(rust.calls.length).toBeGreaterThan(0)
    for (const c of rust.calls) expect(RUST_ALLOWED.some((r) => r.test(c.path))).toBe(true)
    // No inbox cache writes while locked: the unlocked poller fills it later.
    expect(upserts).toEqual([])
    watch.stop()
  })

  it('stops polling once the stronger lock wipes Rust', async () => {
    const box = fakeMailbox()
    const rust = fakeRust(box)
    const popped: string[] = []
    const watch = startLockedGmailWatch({
      deps: rust.deps,
      autoStart: false,
      callbacks: { on2faDetected: (_a, p) => popped.push(p.id) },
    })
    await watch.tickNow()
    await wipeLockedWatch(rust.wipe)
    const before = rust.calls.length
    box.deliver('m1', 'Your verification code', CODE_MAIL)
    await watch.tickNow()
    expect(popped).toEqual([])
    expect(rust.calls.length).toBe(before) // no Gmail call at all
    watch.stop()
  })

  it('a code popped while locked does not pop again when the unlocked poller catches up', async () => {
    const box = fakeMailbox()
    const rust = fakeRust(box)
    const popped: string[] = []
    dbAccounts.set('acc1', {
      id: 'acc1',
      email: 'nicolassutcliffe@gmail.com',
      status: 'ok',
      history_id: String(box.historyId),
    })
    const watch = startLockedGmailWatch({
      deps: rust.deps,
      autoStart: false,
      callbacks: { on2faDetected: (_a, p) => popped.push(`locked:${p.id}`) },
    })
    await watch.tickNow()
    box.deliver('m1', 'Your verification code', CODE_MAIL)
    await watch.tickNow()
    watch.stop()
    expect(popped).toEqual(['locked:m1'])

    // Unlock: the full poller starts from the stored (older) cursor.
    vi.stubGlobal('fetch', async (url: string) =>
      box.respond(url.replace('https://gmail.googleapis.com/gmail/v1/users/me', '')),
    )
    const poller = startGmailPoller({
      dek: new Uint8Array(32),
      userId: 'u1',
      intervalMs: 60_000,
      callbacks: { on2faDetected: (_a, p) => popped.push(`unlocked:${p.id}`) },
    })
    await vi.waitFor(() => expect(upserts).toContain('m1'), { timeout: 3000 })
    await new Promise((r) => setTimeout(r, 50))
    poller.stop()
    expect(upserts).toContain('m1') // the inbox still gets the message
    expect(popped).toEqual(['locked:m1']) // but no second popover
  })
})

describe('arming Rust', () => {
  const acct = (id: string, status = 'ok'): EmailAccountRow => ({
    id,
    user_id: 'u1',
    email: `${id}@x.com`,
    provider: 'gmail',
    encrypted_refresh_token: `ct-${id}`,
    iv_refresh_token: `iv-${id}`,
    scopes: '',
    history_id: '1',
    last_synced_at: null,
    status,
    created_at: '',
  })

  function deps() {
    const arms: Array<{ ids: string[] }> = []
    return {
      arms,
      d: {
        decrypt: async (c: string) => `rt-${c}`,
        arm: async (a: { accounts: Array<{ id: string }> }) => {
          arms.push({ ids: a.accounts.map((x) => x.id) })
        },
        clientId: async () => 'cid',
        clientSecret: async () => 'sec',
      },
    }
  }

  it('arms healthy accounts only, and only when something changed', async () => {
    await wipeLockedWatch(async () => {})
    const { arms, d } = deps()
    const dek = new Uint8Array(32)
    await armLockedWatch('u1', [acct('a'), acct('b', 'needs_reauth')], dek, d)
    await armLockedWatch('u1', [acct('a'), acct('b', 'needs_reauth')], dek, d)
    expect(arms).toEqual([{ ids: ['a'] }])
    await armLockedWatch('u1', [acct('a'), acct('c')], dek, d)
    expect(arms).toEqual([{ ids: ['a'] }, { ids: ['a', 'c'] }])
  })

  it('a wipe resets it, and an arm racing a wipe is undone', async () => {
    const { arms, d } = deps()
    const dek = new Uint8Array(32)
    let wipes = 0
    const wipe = async () => {
      wipes += 1
    }
    await wipeLockedWatch(wipe)
    await armLockedWatch('u1', [acct('a')], dek, d)
    await wipeLockedWatch(wipe)
    await armLockedWatch('u1', [acct('a')], dek, d) // same set, re-armed after wipe
    expect(arms).toHaveLength(2)

    // Sign-out lands while the decrypt is still running.
    await wipeLockedWatch(wipe)
    let release!: () => void
    const slow = { ...d, decrypt: () => new Promise<string>((r) => (release = () => r('rt'))) }
    const pending = armLockedWatch('u1', [acct('z')], dek, slow)
    await wipeLockedWatch(wipe)
    const wipesBefore = wipes
    release()
    await pending
    expect(arms).toHaveLength(2) // never armed after the wipe
    expect(wipes).toBe(wipesBefore)
  })
})
