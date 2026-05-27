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
