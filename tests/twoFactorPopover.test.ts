/**
 * KEY-2FA-1: the 2FA popover must get its payload however late it starts
 * listening, and must never sit on "Waiting…" forever.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  AUTO_CLOSE_MS,
  WAIT_MS,
  createPopoverController,
  type PopoverView,
} from '../src/lib/twoFactorPopoverController'
import type { TwoFactorPayload } from '../src/lib/desktop'

const payload = (id = 'm1', code = '482913'): TwoFactorPayload => ({
  gmailMessageId: id,
  accountId: 'acc',
  accountEmail: 'nicolaslasalahomes@gmail.com',
  fromName: 'SevenRooms',
  subject: 'Your verification code',
  code,
  receivedAt: '2026-10-01T15:37:02.000Z',
})

/**
 * A fake of the Tauri side: `emit` reaches only listeners that are live at
 * that moment (like Tauri events), `park` is the Rust-held payload.
 */
function fakeChannel(listenDelayMs: number) {
  let parked: TwoFactorPayload | null = null
  const listeners = new Set<(p: TwoFactorPayload) => void>()
  return {
    park(p: TwoFactorPayload | null) {
      parked = p
    },
    emit(p: TwoFactorPayload) {
      for (const l of listeners) l(p)
    },
    listen: vi.fn(
      (h: (p: TwoFactorPayload) => void) =>
        new Promise<() => void>((resolve) =>
          setTimeout(() => {
            listeners.add(h)
            resolve(() => listeners.delete(h))
          }, listenDelayMs),
        ),
    ),
    pull: vi.fn(async () => parked),
    listenerCount: () => listeners.size,
  }
}

function harness(listenDelayMs: number) {
  const ch = fakeChannel(listenDelayMs)
  const views: PopoverView[] = []
  const close = vi.fn()
  const controller = createPopoverController({
    listen: ch.listen,
    pull: ch.pull,
    close,
    onView: (v) => views.push(v),
  })
  const last = () => views[views.length - 1]
  return { ch, views, close, controller, last }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('2FA popover handshake', () => {
  it('shows the code even when the event fires before the popover listens (the old 80 ms race)', async () => {
    // Opener: park, create the window, emit at 80 ms. Popover listens at 400 ms.
    const h = harness(400)
    h.ch.park(payload())
    const started = h.controller.start()
    await vi.advanceTimersByTimeAsync(80)
    h.ch.emit(payload()) // nobody listening yet: lost, exactly as before
    expect(h.last()).toEqual({ kind: 'waiting' })
    await vi.advanceTimersByTimeAsync(320)
    await started
    expect(h.last()).toEqual({ kind: 'code', payload: payload() })
  })

  it('takes a pushed payload once listening (popover already open, newer email)', async () => {
    const h = harness(10)
    h.ch.park(payload('m1'))
    const p = h.controller.start()
    await vi.advanceTimersByTimeAsync(10)
    await p
    expect(h.last()).toEqual({ kind: 'code', payload: payload('m1') })
    h.ch.emit(payload('m2', '111222'))
    expect(h.last()).toEqual({ kind: 'code', payload: payload('m2', '111222') })
  })

  it('ignores a duplicate of the payload it is already showing', async () => {
    const h = harness(0)
    h.ch.park(payload('m1'))
    const p = h.controller.start()
    await vi.advanceTimersByTimeAsync(0)
    await p
    const before = h.views.length
    h.ch.emit(payload('m1'))
    expect(h.views.length).toBe(before)
  })

  it('still pulls the parked payload when subscribing fails', async () => {
    const views: PopoverView[] = []
    const c = createPopoverController({
      listen: () => Promise.reject(new Error('no event plugin')),
      pull: async () => payload(),
      close: vi.fn(),
      onView: (v) => views.push(v),
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await c.start()
    expect(views[views.length - 1]).toEqual({ kind: 'code', payload: payload() })
  })

  it('unsubscribes when disposed before the subscription resolves (StrictMode remount)', async () => {
    const h = harness(50)
    const p = h.controller.start()
    h.controller.dispose()
    await vi.advanceTimersByTimeAsync(50)
    await p
    expect(h.ch.listenerCount()).toBe(0)
  })
})

describe('2FA popover never waits forever', () => {
  it('says "No code found yet" after WAIT_MS and closes itself at AUTO_CLOSE_MS', async () => {
    const h = harness(5)
    const p = h.controller.start()
    await vi.advanceTimersByTimeAsync(5)
    await p
    expect(h.last()).toEqual({ kind: 'waiting' })
    await vi.advanceTimersByTimeAsync(WAIT_MS)
    expect(h.last()).toEqual({ kind: 'empty' })
    expect(h.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(AUTO_CLOSE_MS - WAIT_MS)
    expect(h.close).toHaveBeenCalledTimes(1)
  })

  it('closes even when listen() never resolves at all', async () => {
    const close = vi.fn()
    const c = createPopoverController({
      listen: () => new Promise(() => {}),
      pull: async () => null,
      close,
      onView: () => {},
    })
    void c.start()
    await vi.advanceTimersByTimeAsync(AUTO_CLOSE_MS)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('Retry picks up a payload that was parked after the timeout', async () => {
    const h = harness(0)
    const p = h.controller.start()
    await vi.advanceTimersByTimeAsync(WAIT_MS)
    await p
    expect(h.last()).toEqual({ kind: 'empty' })
    h.ch.park(payload())
    await h.controller.retry()
    expect(h.last()).toEqual({ kind: 'code', payload: payload() })
  })

  it('Retry with still nothing goes back to "No code found yet" and restarts the close countdown', async () => {
    const h = harness(0)
    const p = h.controller.start()
    await vi.advanceTimersByTimeAsync(20_000)
    await p
    await h.controller.retry()
    expect(h.last()).toEqual({ kind: 'empty' })
    await vi.advanceTimersByTimeAsync(AUTO_CLOSE_MS - 1)
    expect(h.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(h.close).toHaveBeenCalledTimes(1)
  })

  it('a delivered code gets a fresh 30 s before closing', async () => {
    const h = harness(0)
    const p = h.controller.start()
    await vi.advanceTimersByTimeAsync(10_000)
    await p
    h.ch.emit(payload())
    await vi.advanceTimersByTimeAsync(AUTO_CLOSE_MS - 1)
    expect(h.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(h.close).toHaveBeenCalledTimes(1)
  })
})
