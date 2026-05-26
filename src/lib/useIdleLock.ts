import { useEffect } from 'react'

/** Locks the vault after `timeoutMs` of no user activity. */
export function useIdleLock(active: boolean, onIdle: () => void, timeoutMs = 10 * 60 * 1000) {
  useEffect(() => {
    if (!active) return

    let timer: number | null = null
    const reset = () => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(onIdle, timeoutMs)
    }
    const events = ['mousedown', 'keydown', 'touchstart', 'visibilitychange']

    const handler = () => {
      if (document.visibilityState === 'hidden') {
        // Lock immediately on tab hide
        onIdle()
        return
      }
      reset()
    }

    reset()
    for (const ev of events) window.addEventListener(ev, handler, { passive: true })
    return () => {
      if (timer) window.clearTimeout(timer)
      for (const ev of events) window.removeEventListener(ev, handler)
    }
  }, [active, onIdle, timeoutMs])
}
