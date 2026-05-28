/**
 * Platform shim — Tauri APIs that no-op gracefully on the web build.
 *
 * Tauri injects `window.__TAURI_INTERNALS__` at runtime. The web bundle
 * never imports any `@tauri-apps/*` package directly — all imports are
 * lazy + guarded, so Vite can tree-shake them out of the browser bundle.
 */

import { useEffect, useState } from 'react'

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
  }
}

export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export function useIsDesktop(): boolean {
  const [v, setV] = useState<boolean>(() => isDesktop())
  useEffect(() => {
    // Re-check on mount in case __TAURI_INTERNALS__ landed after first render.
    setV(isDesktop())
  }, [])
  return v
}

// ── Global hotkey ───────────────────────────────────────────────────────────

type HotkeyHandler = () => void

const hotkeyHandlers = new Map<string, HotkeyHandler>()

/**
 * Register a global shortcut. Returns true on success, false if the combo
 * was rejected (already in use, invalid syntax, or not on desktop).
 */
export async function registerHotkey(combo: string, handler: HotkeyHandler): Promise<boolean> {
  if (!isDesktop()) return false
  if (!combo.trim()) return false
  try {
    const { register, unregister, isRegistered } = await import(
      '@tauri-apps/plugin-global-shortcut'
    )
    if (await isRegistered(combo)) {
      await unregister(combo)
    }
    await register(combo, (event) => {
      // Only fire on key down to avoid double-trigger
      if (event.state === 'Pressed') handler()
    })
    hotkeyHandlers.set(combo, handler)
    return true
  } catch (err) {
    console.warn('[desktop] registerHotkey failed', combo, err)
    return false
  }
}

export async function unregisterHotkey(combo: string): Promise<void> {
  if (!isDesktop() || !combo.trim()) return
  try {
    const { unregister, isRegistered } = await import('@tauri-apps/plugin-global-shortcut')
    if (await isRegistered(combo)) await unregister(combo)
    hotkeyHandlers.delete(combo)
  } catch (err) {
    console.warn('[desktop] unregisterHotkey failed', combo, err)
  }
}

export async function unregisterAllHotkeys(): Promise<void> {
  if (!isDesktop()) return
  try {
    const { unregisterAll } = await import('@tauri-apps/plugin-global-shortcut')
    await unregisterAll()
    hotkeyHandlers.clear()
  } catch (err) {
    console.warn('[desktop] unregisterAllHotkeys failed', err)
  }
}

// ── Window control ──────────────────────────────────────────────────────────

export async function showWindow(): Promise<void> {
  if (!isDesktop()) return
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const w = getCurrentWindow()
    await w.show()
    await w.unminimize()
    await w.setFocus()
  } catch (err) {
    console.warn('[desktop] showWindow failed', err)
  }
}

export async function hideWindow(): Promise<void> {
  if (!isDesktop()) return
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().hide()
  } catch (err) {
    console.warn('[desktop] hideWindow failed', err)
  }
}

// ── Separate quick-add window ───────────────────────────────────────────────
// A dedicated borderless mini-window for the hotkey. Shares the unlocked DEK
// with the main window via a Rust-owned session state (set_session_dek /
// get_session_dek commands), so the popover can encrypt + insert items
// without re-prompting for the master password.

const QUICK_ADD_LABEL = 'quick-add'
const QUICK_ADD_WIDTH = 480
const QUICK_ADD_HEIGHT = 560
const QUICK_ADD_EDGE_PADDING = 24

/** Get the current label of the window we're running in (e.g. "main" or "quick-add"). */
export async function getWindowLabel(): Promise<string | null> {
  if (!isDesktop()) return null
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    return getCurrentWindow().label
  } catch {
    return null
  }
}

/** Synchronous label check via the URL hash — used at render time before async
 *  Tauri APIs are available. The quick-add window is loaded with #quick-add. */
export function isQuickAddWindowSync(): boolean {
  return typeof window !== 'undefined' && window.location.hash === '#quick-add'
}

/** Show the quick-add window. Creates it on first call; shows + focuses on subsequent. */
export async function openQuickAddWindow(): Promise<void> {
  if (!isDesktop()) return
  try {
    const { WebviewWindow, getAllWebviewWindows } = await import('@tauri-apps/api/webviewWindow')
    const { primaryMonitor } = await import('@tauri-apps/api/window')
    const { invoke } = await import('@tauri-apps/api/core')

    // Snapshot whether main is visible. The popover-close handler reads this
    // to decide whether to deactivate the app on dismiss.
    await invoke('record_main_visibility')

    const existing = (await getAllWebviewWindows()).find((w) => w.label === QUICK_ADD_LABEL)
    if (existing) {
      await existing.show()
      await existing.unminimize()
      await existing.setFocus()
      return
    }

    // Position top-right of primary monitor
    const monitor = await primaryMonitor()
    const monW = monitor?.size.width ?? 1920
    const monX = monitor?.position.x ?? 0
    const monY = monitor?.position.y ?? 0
    const scaleFactor = monitor?.scaleFactor ?? 1
    const logicalW = monW / scaleFactor

    const x = Math.round(monX / scaleFactor + logicalW - QUICK_ADD_WIDTH - QUICK_ADD_EDGE_PADDING)
    const y = Math.round(monY / scaleFactor + QUICK_ADD_EDGE_PADDING)

    const w = new WebviewWindow(QUICK_ADD_LABEL, {
      url: 'index.html#quick-add',
      title: 'Quick Add',
      width: QUICK_ADD_WIDTH,
      height: QUICK_ADD_HEIGHT,
      x,
      y,
      resizable: false,
      decorations: false,
      transparent: false,
      shadow: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focus: true,
      visible: false, // we'll show after content loads to avoid flash
    })

    w.once('tauri://created', () => {
      void w.show()
      void w.setFocus()
    })
    w.once('tauri://error', (e) => {
      console.warn('[desktop] quick-add window error', e)
    })
  } catch (err) {
    console.warn('[desktop] openQuickAddWindow failed', err)
  }
}

/** Dismiss the quick-add popover. The Rust side handles the focus dance —
 *  if main was up before the popover, focus returns to main; if main was
 *  hidden, the app deactivates and focus returns to whatever app was active
 *  before the popover came forward (Lovable, browser, etc.). */
export async function closeQuickAddWindow(): Promise<void> {
  if (!isDesktop()) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('handle_popover_close')
  } catch (err) {
    console.warn('[desktop] closeQuickAddWindow failed', err)
  }
}

// ── Session DEK shared via Rust state ───────────────────────────────────────

/** Push the unlocked DEK into Rust process memory so other windows can grab it. */
export async function setSessionDek(dek: Uint8Array): Promise<void> {
  if (!isDesktop()) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('set_session_dek', { dek: Array.from(dek) })
  } catch (err) {
    console.warn('[desktop] setSessionDek failed', err)
  }
}

/** Read the session DEK from Rust. Returns null if vault is locked or not on desktop. */
export async function getSessionDek(): Promise<Uint8Array | null> {
  if (!isDesktop()) return null
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const result = (await invoke('get_session_dek')) as number[] | null
    return result ? new Uint8Array(result) : null
  } catch (err) {
    console.warn('[desktop] getSessionDek failed', err)
    return null
  }
}

/** Clear the session DEK (called on lock or sign-out). */
export async function clearSessionDek(): Promise<void> {
  if (!isDesktop()) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('clear_session_dek')
  } catch (err) {
    console.warn('[desktop] clearSessionDek failed', err)
  }
}

// ── Persistent key/value store (for hotkey + Touch ID prefs) ────────────────

let storePromise: Promise<unknown> | null = null

async function getStore() {
  if (!isDesktop()) throw new Error('Store unavailable on web')
  if (!storePromise) {
    storePromise = import('@tauri-apps/plugin-store').then(async ({ load }) => {
      // `.keyring.json` lives in the app data directory
      return load('.keyring.json', { autoSave: true, defaults: {} })
    })
  }
  return storePromise
}

export async function getStoreValue<T>(key: string): Promise<T | null> {
  if (!isDesktop()) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store: any = await getStore()
    const v = await store.get(key)
    return (v as T) ?? null
  } catch (err) {
    console.warn('[desktop] getStoreValue failed', key, err)
    return null
  }
}

export async function setStoreValue<T>(key: string, value: T): Promise<void> {
  if (!isDesktop()) return
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store: any = await getStore()
    await store.set(key, value)
  } catch (err) {
    console.warn('[desktop] setStoreValue failed', key, err)
  }
}

// ── Auto-update ─────────────────────────────────────────────────────────────

export interface UpdateInfo {
  available: boolean
  version?: string
  currentVersion?: string
  body?: string
}

/** Check for a new version. Returns metadata; does not download/install. */
export async function checkForUpdate(): Promise<UpdateInfo> {
  if (!isDesktop()) return { available: false }
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const { getVersion } = await import('@tauri-apps/api/app')
    const currentVersion = await getVersion()
    const update = await check()
    if (!update) return { available: false, currentVersion }
    return {
      available: true,
      version: update.version,
      currentVersion,
      body: update.body,
    }
  } catch (err) {
    console.warn('[desktop] checkForUpdate failed', err)
    return { available: false }
  }
}

/** Download + install the latest update, then ask the OS to relaunch the app. */
export async function downloadAndInstallUpdate(
  onProgress?: (downloaded: number, total: number | null) => void,
): Promise<void> {
  if (!isDesktop()) return
  const { check } = await import('@tauri-apps/plugin-updater')
  const { relaunch } = await import('@tauri-apps/plugin-process')
  const update = await check()
  if (!update) return
  let downloaded = 0
  let total: number | null = null
  await update.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      total = (event.data?.contentLength as number | undefined) ?? null
    } else if (event.event === 'Progress') {
      downloaded += event.data.chunkLength
      onProgress?.(downloaded, total)
    }
  })
  await relaunch()
}

// ── Tray menu events ────────────────────────────────────────────────────────

/**
 * Subscribe to a tray-menu event emitted from the Rust side. Returns an
 * unsubscribe function.
 */
export async function onTrayEvent(
  name: 'lock' | 'settings',
  handler: () => void,
): Promise<() => void> {
  if (!isDesktop()) return () => {}
  try {
    const { listen } = await import('@tauri-apps/api/event')
    const unlisten = await listen(`tray://${name}`, () => handler())
    return unlisten
  } catch (err) {
    console.warn('[desktop] onTrayEvent failed', name, err)
    return () => {}
  }
}
