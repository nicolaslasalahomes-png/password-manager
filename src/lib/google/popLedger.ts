/**
 * Which Gmail messages already popped the 2FA popover in this app run.
 * Shared by the unlocked poller and the locked watch (KEY-2FA-2) so a code
 * popped while the vault was locked does not pop a second time when the
 * unlocked poller catches up after unlock. Message ids only, memory only.
 */

const MAX_IDS = 500
const popped = new Set<string>()

export function wasPopped(messageId: string): boolean {
  return popped.has(messageId)
}

export function markPopped(messageId: string): void {
  popped.delete(messageId)
  popped.add(messageId)
  if (popped.size > MAX_IDS) {
    const oldest = popped.values().next().value
    if (oldest !== undefined) popped.delete(oldest)
  }
}

/** Test helper. */
export function resetPopLedger(): void {
  popped.clear()
}
