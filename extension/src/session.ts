/**
 * Session storage for the extension. Uses chrome.storage.session which lives
 * in memory only (cleared on browser restart). Holds the unlocked DEK + meta
 * across popup open/close so the user doesn't re-unlock every time.
 */

import { fromBase64, toBase64 } from '@vault/lib/encryption'
import type { VaultMeta } from '@vault/state/VaultContext'

const KEY_DEK = 'dek_b64'
const KEY_META = 'meta'
const KEY_LAST_USED = 'last_used'

const IDLE_TIMEOUT_MS = 10 * 60 * 1000

interface PersistedSession {
  dek: Uint8Array
  meta: VaultMeta
  lastUsed: number
}

export async function readSession(): Promise<PersistedSession | null> {
  const data = await chrome.storage.session.get([KEY_DEK, KEY_META, KEY_LAST_USED])
  const dekB64 = data[KEY_DEK] as string | undefined
  const meta = data[KEY_META] as VaultMeta | undefined
  const lastUsed = data[KEY_LAST_USED] as number | undefined
  if (!dekB64 || !meta || !lastUsed) return null
  if (Date.now() - lastUsed > IDLE_TIMEOUT_MS) {
    await clearSession()
    return null
  }
  return { dek: fromBase64(dekB64), meta, lastUsed }
}

export async function writeSession(dek: Uint8Array, meta: VaultMeta): Promise<void> {
  await chrome.storage.session.set({
    [KEY_DEK]: toBase64(dek),
    [KEY_META]: meta,
    [KEY_LAST_USED]: Date.now(),
  })
}

export async function touchSession(): Promise<void> {
  await chrome.storage.session.set({ [KEY_LAST_USED]: Date.now() })
}

export async function clearSession(): Promise<void> {
  await chrome.storage.session.remove([KEY_DEK, KEY_META, KEY_LAST_USED])
}
