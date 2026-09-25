/**
 * Local Anthropic usage meter.
 *
 * Every callClaude() records its token usage here; we multiply by a price table
 * and accumulate a running total in the Tauri local store. This is the SECURE
 * way to show "how much has Keyring's AI cost me" without an org Admin API key
 * (the only thing that can read real Anthropic spend) ever touching this app.
 *
 * Caveats, surfaced in the UI:
 *   - Counts ONLY calls made by Keyring (classifier + briefing), not other apps
 *     sharing the same API key.
 *   - Cost is an ESTIMATE from the hardcoded price table below; the authoritative
 *     number is at console.anthropic.com. Update PRICES if Anthropic changes them.
 */

import { getStoreValue, setStoreValue } from '../desktop'

const KEY = 'anthropicUsage'

/** USD per 1M tokens. Estimates — adjust if pricing changes. */
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
}
const DEFAULT_PRICE = { input: 1.0, output: 5.0 }

export interface UsageStore {
  totalInput: number
  totalOutput: number
  totalCalls: number
  totalCostUsd: number
  /** 'YYYY-M' of the current accounting month. */
  monthKey: string
  monthCostUsd: number
  monthCalls: number
  since: string
}

function monthKeyNow(): string {
  const d = new Date()
  return `${d.getFullYear()}-${d.getMonth()}`
}

function empty(): UsageStore {
  return {
    totalInput: 0,
    totalOutput: 0,
    totalCalls: 0,
    totalCostUsd: 0,
    monthKey: monthKeyNow(),
    monthCostUsd: 0,
    monthCalls: 0,
    since: new Date().toISOString(),
  }
}

export async function recordUsage(
  model: string,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  const price = PRICES[model] ?? DEFAULT_PRICE
  const cost = (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output
  const cur = (await getStoreValue<UsageStore>(KEY)) ?? empty()
  const mk = monthKeyNow()
  if (cur.monthKey !== mk) {
    cur.monthKey = mk
    cur.monthCostUsd = 0
    cur.monthCalls = 0
  }
  cur.totalInput += inputTokens
  cur.totalOutput += outputTokens
  cur.totalCalls += 1
  cur.totalCostUsd += cost
  cur.monthCostUsd += cost
  cur.monthCalls += 1
  await setStoreValue(KEY, cur)
}

export async function getUsage(): Promise<UsageStore | null> {
  return (await getStoreValue<UsageStore>(KEY)) ?? null
}

export async function resetUsage(): Promise<void> {
  await setStoreValue(KEY, empty())
}
