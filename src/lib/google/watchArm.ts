/**
 * KEY-2FA-2: arm and wipe the Rust Gmail watch (src-tauri/src/gmail_watch.rs).
 *
 * Armed only while the vault is UNLOCKED (that is the only time the refresh
 * tokens can be decrypted). Re-armed when the account set or a refresh token
 * changes. Wiped on the stronger lock (signed out, email code owed).
 */

import { decryptJson } from '../encryption'
import { gmailWatchArm, gmailWatchWipe, type GmailWatchArmAccount } from '../desktop'
import { getEffectiveClientId, getEffectiveClientSecret } from './oauth'
import type { EmailAccountRow } from './tokens'

let lastSignature: string | null = null
let arming: Promise<void> | null = null
/** Bumped by every wipe, so an arm that started before a wipe never lands after it. */
let wipeEpoch = 0
let lastWipe: () => Promise<void> = gmailWatchWipe

function signatureOf(userId: string, accounts: EmailAccountRow[]): string {
  return [
    userId,
    ...accounts
      .filter((a) => a.status === 'ok')
      .map((a) => `${a.id}:${a.iv_refresh_token}:${a.encrypted_refresh_token.length}`)
      .sort(),
  ].join('|')
}

export interface ArmDeps {
  decrypt: (ciphertext: string, iv: string, dek: Uint8Array) => Promise<string>
  arm: typeof gmailWatchArm
  clientId: () => Promise<string>
  clientSecret: () => Promise<string>
}

const defaultDeps: ArmDeps = {
  decrypt: (c, iv, dek) => decryptJson<string>(c, iv, dek),
  arm: gmailWatchArm,
  clientId: getEffectiveClientId,
  clientSecret: getEffectiveClientSecret,
}

/** Hand Rust the refresh tokens of every healthy account (no-op if unchanged). */
export async function armLockedWatch(
  userId: string,
  accounts: EmailAccountRow[],
  dek: Uint8Array,
  deps: ArmDeps = defaultDeps,
): Promise<void> {
  const sig = signatureOf(userId, accounts)
  if (sig === lastSignature) return
  if (arming) return // the next tick retries if this one goes stale
  const epoch = wipeEpoch
  arming = (async () => {
    const list: GmailWatchArmAccount[] = []
    for (const a of accounts) {
      if (a.status !== 'ok') continue
      try {
        list.push({
          id: a.id,
          refresh_token: await deps.decrypt(a.encrypted_refresh_token, a.iv_refresh_token, dek),
        })
      } catch (err) {
        console.warn(`[watch-arm] ${a.email}: could not decrypt token`, err)
      }
    }
    const [clientId, clientSecret] = await Promise.all([deps.clientId(), deps.clientSecret()])
    if (!clientId || !clientSecret) return
    if (epoch !== wipeEpoch) return
    await deps.arm({ userId, clientId, clientSecret, accounts: list })
    if (epoch !== wipeEpoch) {
      await lastWipe() // a wipe raced this arm: undo it
      return
    }
    lastSignature = sig
  })()
  try {
    await arming
  } catch (err) {
    console.warn('[watch-arm] arm failed', err)
  } finally {
    arming = null
  }
}

/** The stronger lock: drop every Gmail token Rust holds. */
export async function wipeLockedWatch(wipe: () => Promise<void> = gmailWatchWipe): Promise<void> {
  wipeEpoch += 1
  lastSignature = null
  lastWipe = wipe
  await wipe()
}
