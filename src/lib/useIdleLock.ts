import { useEffect } from 'react'
import { isDesktop } from './desktop'

interface Options {
  /** Milliseconds of inactivity before onIdle fires. */
  timeoutMs?: number
  /**
   * If true, lock immediately when the document becomes hidden (tab switch,
   * window minimize). Defaults to true on web, false on desktop.
   *
   * Rationale: on desktop, the user expects to alt-tab away and come back
   * without re-entering the master password. The window may also be hidden
   * by us (e.g. after quick-add save) — those events shouldn't lock either.
   */
  lockOnHidden?: boolean
}

/** Locks the vault after `timeoutMs` of no user activity. */
export function useIdleLock(active: boolean, onIdle: () => void, options: Options = {}) {
  useEffect(() => {
    if (!active) return

    const desktop = isDesktop()
    const timeoutMs = options.timeoutMs ?? (desktop ? 30 * 60 * 1000 : 10 * 60 * 1000)
    const lockOnHidden = options.lockOnHidden ?? !desktop

    let timer: number | null = null
    const reset = () => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(onIdle, timeoutMs)
    }
    const events = ['mousedown', 'keydown', 'touchstart', 'visibilitychange']

    const handler = () => {
      if (lockOnHidden && document.visibilityState === 'hidden') {
        onIdle()
        return
      }
      // Don't reset the timer on visibilitychange-to-visible — that'd let
      // the user park the window indefinitely. Only real user input resets.
      if (document.visibilityState === 'visible') {
        // for visibility events themselves, do nothing; rely on actual input
        // events (mousedown/keydown/touchstart) to reset.
      }
      reset()
    }

    reset()
    for (const ev of events) window.addEventListener(ev, handler, { passive: true })
    return () => {
      if (timer) window.clearTimeout(timer)
      for (const ev of events) window.removeEventListener(ev, handler)
    }
  }, [active, onIdle, options.timeoutMs, options.lockOnHidden])
}
