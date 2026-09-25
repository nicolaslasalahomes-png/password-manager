/**
 * Sliding-window rate limiter.
 *
 * `createRateLimiter(40)` returns an async `acquire()` that resolves as soon
 * as fewer than 40 calls have happened in the trailing 60s, otherwise waits
 * until the oldest call ages out of the window. Shared across all callers
 * (e.g. every Gmail account's poller) so the cap is global, not per-account.
 *
 * Acquisition is serialized through a promise chain so concurrent callers
 * can't all read stale window state and overshoot the cap. The serialized
 * section is trivial (array filter + push) when under the limit, so this adds
 * negligible latency in the common case and only blocks when genuinely capped.
 */
export function createRateLimiter(maxPerWindow: number, windowMs = 60_000) {
  let timestamps: number[] = []
  let chain: Promise<void> = Promise.resolve()

  return async function acquire(): Promise<void> {
    const prev = chain
    let release!: () => void
    chain = new Promise<void>((r) => {
      release = r
    })
    await prev
    try {
      // eslint-disable-next-line no-constant-condition
      for (;;) {
        const now = Date.now()
        timestamps = timestamps.filter((t) => now - t < windowMs)
        if (timestamps.length < maxPerWindow) {
          timestamps.push(now)
          return
        }
        const waitMs = windowMs - (now - timestamps[0]) + 50
        await new Promise((r) => setTimeout(r, waitMs))
      }
    } finally {
      release()
    }
  }
}
