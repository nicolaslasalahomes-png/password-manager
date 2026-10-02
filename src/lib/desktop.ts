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

/** Synchronous label check for the 2FA popover (loaded with #2fa-popover). */
export function is2faPopoverSync(): boolean {
  return typeof window !== 'undefined' && window.location.hash === '#2fa-popover'
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

// ── 2FA popover window (separate borderless mini-window) ────────────────────
// Mirrors the quick-add window shape: dedicated WebviewWindow, loaded with
// `index.html#2fa-popover`, ~360x280, alwaysOnTop, bottom-right. The poller
// fires open2faPopover() the moment it detects a verification email. The
// payload is parked in Rust (`set_2fa_payload`) and also pushed via the
// `2fa://show` event; the popover subscribes, then pulls, so neither a cold
// window nor a reused one can miss it (KEY-2FA-1). Dedup is by message id.

const TWO_FA_POPOVER_LABEL = '2fa-popover'
const TWO_FA_POPOVER_WIDTH = 380
const TWO_FA_POPOVER_HEIGHT = 320
const TWO_FA_POPOVER_EDGE_PADDING = 24

export interface TwoFactorPayload {
  /** Stable id to dedup back-to-back fires of the same email. */
  gmailMessageId: string
  accountId: string
  accountEmail: string
  fromName: string
  subject: string
  code?: string
  magicLink?: string
  receivedAt: string
}

export async function open2faPopover(payload: TwoFactorPayload): Promise<void> {
  if (!isDesktop()) return
  try {
    const { WebviewWindow, getAllWebviewWindows } = await import('@tauri-apps/api/webviewWindow')
    const { primaryMonitor } = await import('@tauri-apps/api/window')
    const { emit } = await import('@tauri-apps/api/event')
    const { invoke } = await import('@tauri-apps/api/core')

    // KEY-2FA-1: park the payload in Rust BEFORE the window exists. A cold
    // popover pulls it after subscribing, so the event below can arrive
    // before the popover listens and nothing is lost. Local IPC only.
    await invoke('set_2fa_payload', { payload: JSON.stringify(payload) })

    const existing = (await getAllWebviewWindows()).find((w) => w.label === TWO_FA_POPOVER_LABEL)
    if (existing) {
      await existing.show()
      await existing.unminimize()
      // Don't setFocus() — same reasoning as the first-create branch below:
      // we want the popover visible without stealing the user's keyboard focus.
      // A mounted popover swaps to the new payload on this event.
      await emit('2fa://show', payload)
      return
    }

    // Bottom-right of primary monitor.
    const monitor = await primaryMonitor()
    const monW = monitor?.size.width ?? 1920
    const monH = monitor?.size.height ?? 1080
    const monX = monitor?.position.x ?? 0
    const monY = monitor?.position.y ?? 0
    const scaleFactor = monitor?.scaleFactor ?? 1
    const logicalW = monW / scaleFactor
    const logicalH = monH / scaleFactor

    const x = Math.round(
      monX / scaleFactor + logicalW - TWO_FA_POPOVER_WIDTH - TWO_FA_POPOVER_EDGE_PADDING,
    )
    const y = Math.round(
      monY / scaleFactor + logicalH - TWO_FA_POPOVER_HEIGHT - TWO_FA_POPOVER_EDGE_PADDING - 40,
    )

    const w = new WebviewWindow(TWO_FA_POPOVER_LABEL, {
      url: 'index.html#2fa-popover',
      title: '2FA',
      width: TWO_FA_POPOVER_WIDTH,
      height: TWO_FA_POPOVER_HEIGHT,
      x,
      y,
      resizable: false,
      decorations: false,
      transparent: false,
      shadow: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      // focus: false → appear visibly without stealing keyboard focus from
      // whatever the user is typing into in another app. Clicking the popover
      // (Copy button, Open link) gives it focus naturally.
      focus: false,
      visible: false,
    })

    w.once('tauri://created', async () => {
      await w.show()
      // No setFocus(), see focus:false note above. No event needed here:
      // the new popover pulls the parked payload once it is listening.
    })
    w.once('tauri://error', (e) => {
      console.warn('[desktop] 2fa popover error', e)
    })
  } catch (err) {
    console.warn('[desktop] open2faPopover failed', err)
  }
}

/** Popover side: the payload parked by open2faPopover, or null. */
export async function pull2faPayload(): Promise<TwoFactorPayload | null> {
  if (!isDesktop()) return null
  const { invoke } = await import('@tauri-apps/api/core')
  const raw = await invoke<string | null>('get_2fa_payload')
  return raw ? (JSON.parse(raw) as TwoFactorPayload) : null
}

export async function close2faPopover(): Promise<void> {
  if (!isDesktop()) return
  try {
    // Don't keep a code in memory longer than the popover shows it.
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('clear_2fa_payload').catch(() => {})
    const { getAllWebviewWindows } = await import('@tauri-apps/api/webviewWindow')
    const w = (await getAllWebviewWindows()).find((w) => w.label === TWO_FA_POPOVER_LABEL)
    if (w) await w.close()
  } catch (err) {
    console.warn('[desktop] close2faPopover failed', err)
  }
}

// ── Gmail watch while the vault is locked (KEY-2FA-2) ───────────────────────
// Rust holds the Gmail refresh tokens (process memory only) so 2FA codes keep
// popping while the vault is locked. The webview arms it while unlocked and
// afterwards only asks for read-only calls by account id + path; it never gets
// a token back. See src-tauri/src/gmail_watch.rs.

export interface GmailWatchArmAccount {
  id: string
  refresh_token: string
}

export async function gmailWatchArm(args: {
  userId: string
  clientId: string
  clientSecret: string
  accounts: GmailWatchArmAccount[]
}): Promise<void> {
  if (!isDesktop()) return
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('gmail_watch_arm', {
    userId: args.userId,
    clientId: args.clientId,
    clientSecret: args.clientSecret,
    accounts: args.accounts,
  })
}

/** Zero and drop every Gmail token Rust holds. Safe to call any time. */
export async function gmailWatchWipe(): Promise<void> {
  if (!isDesktop()) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('gmail_watch_wipe')
  } catch (err) {
    console.warn('[desktop] gmail_watch_wipe failed', err)
  }
}

/** Ids of the accounts Rust can poll (no secrets). */
export async function gmailWatchAccounts(): Promise<string[]> {
  if (!isDesktop()) return []
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<string[]>('gmail_watch_accounts')
}

/** One read-only Gmail GET through Rust, as a fetch Response. */
export async function gmailWatchGet(accountId: string, path: string): Promise<Response> {
  const { invoke } = await import('@tauri-apps/api/core')
  const reply = await invoke<{ status: number; body: string }>('gmail_watch_get', {
    accountId,
    path,
  })
  return new Response(reply.body, { status: reply.status })
}

/** Open an external URL in the user's default browser (Rust shells out via tauri-plugin-shell). */
export async function openExternalUrl(url: string): Promise<void> {
  if (!isDesktop()) {
    window.open(url, '_blank', 'noopener')
    return
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('open_url', { url })
  } catch (err) {
    console.warn('[desktop] openExternalUrl failed', err)
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

// ── Biometric unlock (macOS Touch ID via Secure Enclave Keychain) ───────────
// The DEK (never the master password, never the highDek) is stored in a
// biometric-gated Keychain item keyed by the Supabase user id. Retrieval
// triggers a fresh Touch ID prompt every time. `biometryCurrentSet` access
// control invalidates the item if the enrolled fingerprints change.

/** True only on a Mac with Touch ID hardware the app can evaluate. */
export async function biometricAvailable(): Promise<boolean> {
  if (!isDesktop()) return false
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return (await invoke('biometric_available')) as boolean
  } catch (err) {
    console.warn('[desktop] biometricAvailable failed', err)
    return false
  }
}

/** Whether a biometric DEK item exists for this account. Does NOT prompt. */
export async function biometricExists(account: string): Promise<boolean> {
  if (!isDesktop()) return false
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return (await invoke('biometric_exists', { account })) as boolean
  } catch (err) {
    console.warn('[desktop] biometricExists failed', err)
    return false
  }
}

/** Tauri rejects `Result<_, String>` commands with a bare string, not an Error.
 *  Normalise so call sites can rely on `instanceof Error` + `.message`. */
function toError(err: unknown, fallback: string): Error {
  if (err instanceof Error) return err
  if (typeof err === 'string') return new Error(err)
  return new Error(fallback)
}

/**
 * Store the DEK in the biometric-gated Keychain (delete-then-add to overwrite).
 * Throws on failure — the caller must surface enrollment errors to the user.
 */
export async function biometricStore(account: string, secret: Uint8Array): Promise<void> {
  if (!isDesktop()) throw new Error('Touch ID is only available in the desktop app')
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    await invoke('biometric_store', { account, secret: Array.from(secret) })
  } catch (err) {
    throw toError(err, 'Could not store Touch ID credential')
  }
}

/**
 * Retrieve the DEK from the Keychain. Triggers the Touch ID prompt. Throws if
 * the user cancels, the fingerprint fails, or the item was invalidated.
 */
export async function biometricRetrieve(account: string): Promise<Uint8Array> {
  if (!isDesktop()) throw new Error('Touch ID is only available in the desktop app')
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    const result = (await invoke('biometric_retrieve', { account })) as number[]
    return new Uint8Array(result)
  } catch (err) {
    throw toError(err, 'Touch ID retrieve failed')
  }
}

/** Remove the biometric DEK item (disable Touch ID). Throws on failure. */
export async function biometricDelete(account: string): Promise<void> {
  if (!isDesktop()) return
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    await invoke('biometric_delete', { account })
  } catch (err) {
    throw toError(err, 'Could not remove Touch ID credential')
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
