/** KEY-2FA-1: the shared Gmail limiter keeps its cap and lets new mail jump the backfill. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRateLimiter } from '../src/lib/rateLimit'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createRateLimiter', () => {
  it('never grants more than the cap inside one window', async () => {
    const acquire = createRateLimiter(5, 1_000)
    let granted = 0
    for (let i = 0; i < 12; i++) void acquire().then(() => granted++)
    await vi.advanceTimersByTimeAsync(0)
    expect(granted).toBe(5)
    await vi.advanceTimersByTimeAsync(999)
    expect(granted).toBe(5)
    await vi.advanceTimersByTimeAsync(100)
    expect(granted).toBe(10)
    await vi.advanceTimersByTimeAsync(1_100)
    expect(granted).toBe(12)
  })

  it('grants a waiting high-priority call before every queued low-priority call', async () => {
    const acquire = createRateLimiter(2, 1_000)
    const order: string[] = []
    for (let i = 0; i < 6; i++) void acquire('low').then(() => order.push(`low${i}`))
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual(['low0', 'low1'])
    expect(acquire.pending()).toEqual({ high: 0, low: 4 })
    // A 2FA email arrives while 4 backfill fetches are queued.
    void acquire('high').then(() => order.push('high'))
    await vi.advanceTimersByTimeAsync(1_100)
    expect(order.slice(2)).toEqual(['high', 'low2'])
  })

  it('defaults to high priority', async () => {
    const acquire = createRateLimiter(1, 1_000)
    const order: string[] = []
    void acquire('low').then(() => order.push('first'))
    void acquire('low').then(() => order.push('low'))
    void acquire().then(() => order.push('default'))
    await vi.advanceTimersByTimeAsync(1_100)
    expect(order).toEqual(['first', 'default'])
  })
})
