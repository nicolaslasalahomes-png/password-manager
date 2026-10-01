/**
 * Delivery + timing logic for the 2FA popover window (KEY-2FA-1), kept free
 * of React and Tauri so it can be tested in Node.
 *
 * The bug it fixes: the opener used to create the popover window and fire
 * `2fa://show` 80 ms later. The popover only subscribes after React mounts and
 * the Tauri event module loads, which is often slower than 80 ms, so the event
 * was lost, the window sat on "Waiting…" and, because the 30 s auto-close was
 * only scheduled when a payload arrived, it never closed.
 *
 * Now:
 *  1. The opener parks the payload in Rust state BEFORE creating or showing
 *     the window, then emits the event.
 *  2. The popover subscribes first, then pulls the parked payload. Whichever
 *     order things happen in, one of the two paths delivers it.
 *  3. Timers start at mount, not at delivery: after WAIT_MS with nothing to
 *     show it says "No code found yet" with Retry, and it always auto-closes.
 *     It never waits forever.
 */

import type { TwoFactorPayload } from './desktop'

export const WAIT_MS = 5_000
export const AUTO_CLOSE_MS = 30_000

export type PopoverView =
  | { kind: 'waiting' }
  | { kind: 'empty' }
  | { kind: 'code'; payload: TwoFactorPayload }

export interface PopoverControllerDeps {
  /** Subscribe to pushed payloads; resolves once the subscription is live. */
  listen: (onPayload: (p: TwoFactorPayload) => void) => Promise<() => void>
  /** Read the payload parked by the opener (null when there is none). */
  pull: () => Promise<TwoFactorPayload | null>
  close: () => void
  onView: (view: PopoverView) => void
  waitMs?: number
  autoCloseMs?: number
}

export interface PopoverController {
  start: () => Promise<void>
  retry: () => Promise<void>
  /** Restart the auto-close countdown (user is interacting). */
  bumpAutoClose: () => void
  dispose: () => void
}

export function createPopoverController(deps: PopoverControllerDeps): PopoverController {
  const waitMs = deps.waitMs ?? WAIT_MS
  const autoCloseMs = deps.autoCloseMs ?? AUTO_CLOSE_MS
  let current: TwoFactorPayload | null = null
  let disposed = false
  let unlisten: (() => void) | null = null
  let waitTimer: ReturnType<typeof setTimeout> | null = null
  let closeTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleClose() {
    if (disposed) return
    if (closeTimer !== null) clearTimeout(closeTimer)
    closeTimer = setTimeout(() => {
      closeTimer = null
      if (!disposed) deps.close()
    }, autoCloseMs)
  }

  function scheduleEmpty() {
    if (waitTimer !== null) clearTimeout(waitTimer)
    waitTimer = setTimeout(() => {
      waitTimer = null
      if (!disposed && !current) deps.onView({ kind: 'empty' })
    }, waitMs)
  }

  function deliver(p: TwoFactorPayload | null) {
    if (disposed || !p) return
    if (current && current.gmailMessageId === p.gmailMessageId) return
    current = p
    if (waitTimer !== null) {
      clearTimeout(waitTimer)
      waitTimer = null
    }
    deps.onView({ kind: 'code', payload: p })
    scheduleClose()
  }

  async function pullSafely(): Promise<void> {
    try {
      deliver(await deps.pull())
    } catch (err) {
      console.warn('[2fa-popover] pull failed', err)
    }
  }

  return {
    async start() {
      deps.onView({ kind: 'waiting' })
      scheduleEmpty()
      scheduleClose()
      try {
        const off = await deps.listen(deliver)
        if (disposed) off()
        else unlisten = off
      } catch (err) {
        // The parked payload still reaches us through pull().
        console.warn('[2fa-popover] failed to subscribe', err)
      }
      // Subscribe THEN pull: an event sent before we listened is still parked.
      await pullSafely()
    },
    async retry() {
      if (disposed) return
      if (!current) deps.onView({ kind: 'waiting' })
      scheduleClose()
      await pullSafely()
      if (!disposed && !current) deps.onView({ kind: 'empty' })
    },
    bumpAutoClose() {
      if (closeTimer !== null) scheduleClose()
    },
    dispose() {
      disposed = true
      unlisten?.()
      unlisten = null
      if (waitTimer !== null) clearTimeout(waitTimer)
      if (closeTimer !== null) clearTimeout(closeTimer)
      waitTimer = closeTimer = null
    },
  }
}
