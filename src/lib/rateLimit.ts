/**
 * Sliding-window rate limiter with two priority lanes.
 *
 * `createRateLimiter(240)` returns an async `acquire(priority)` that resolves
 * as soon as fewer than 240 calls have happened in the trailing 60s, otherwise
 * waits until the oldest call ages out of the window. Shared across all
 * callers (e.g. every Gmail account's poller) so the cap is global.
 *
 * Priority (KEY-2FA-1): a waiting 'high' caller (a new-mail poll, a message
 * that just arrived, something the user clicked) is always granted before
 * any waiting 'low' caller (bootstrap backfill of old inbox mail). Before
 * this, one FIFO queue meant a 2FA email could sit behind hundreds of
 * backfill fetches for minutes.
 *
 * Grants happen in a single pump, so concurrent callers can't all read stale
 * window state and overshoot the cap.
 */
export type RatePriority = 'high' | 'low'

export interface RateLimiter {
  (priority?: RatePriority): Promise<void>
  /** Waiting callers per lane (for tests and diagnostics). */
  pending(): { high: number; low: number }
}

export function createRateLimiter(maxPerWindow: number, windowMs = 60_000): RateLimiter {
  let timestamps: number[] = []
  const high: Array<() => void> = []
  const low: Array<() => void> = []
  let timer: ReturnType<typeof setTimeout> | null = null

  function pump() {
    timer = null
    const now = Date.now()
    timestamps = timestamps.filter((t) => now - t < windowMs)
    while (timestamps.length < maxPerWindow && (high.length || low.length)) {
      const next = (high.length ? high : low).shift()!
      timestamps.push(now)
      next()
    }
    if ((high.length || low.length) && timer === null) {
      const waitMs = Math.max(0, windowMs - (now - timestamps[0])) + 50
      timer = setTimeout(pump, waitMs)
    }
  }

  const acquire = ((priority: RatePriority = 'high') =>
    new Promise<void>((resolve) => {
      ;(priority === 'low' ? low : high).push(resolve)
      if (timer === null) pump()
    })) as RateLimiter
  acquire.pending = () => ({ high: high.length, low: low.length })
  return acquire
}
