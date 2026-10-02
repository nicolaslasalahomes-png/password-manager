/**
 * Linked-Gmail-account storage + access-token cache.
 *
 * Refresh tokens are AES-GCM encrypted with the user's DEK (same model as
 * vault_items). The Supabase service role can see the metadata (email,
 * scopes, history cursor) but not the token bytes.
 *
 * IMPORTANT INVARIANT: changing the master password re-wraps the DEK with a
 * new KEK but keeps the DEK *bytes* identical (see encryption.ts
 * changeMasterPassword). So encrypted refresh tokens remain decryptable
 * across password changes — no re-encrypt needed.
 */

import { supabase } from '../supabase'
import { decryptJson, encryptJson } from '../encryption'
import { GoogleOAuthError, refreshAccessToken } from './oauth'

export interface EmailAccountRow {
  id: string
  user_id: string
  email: string
  provider: string
  encrypted_refresh_token: string
  iv_refresh_token: string
  scopes: string
  history_id: string | null
  last_synced_at: string | null
  status: 'ok' | 'needs_reauth' | string
  created_at: string
}

const COLUMNS =
  'id, user_id, email, provider, encrypted_refresh_token, iv_refresh_token, scopes, history_id, last_synced_at, status, created_at'

/** In-memory access-token cache, per account so accounts poll concurrently.
 *  Cleared the moment the vault locks (App.tsx, KEY-2FA-2): while locked the
 *  webview holds no Gmail token at all; the locked watch goes through Rust. */
const accessTokenCache = new Map<string, { token: string; expiresAt: number }>()
/** Bumped by clearAccessTokenCache so a refresh already in flight when the
 *  vault locks cannot put a token back afterwards. */
let cacheGeneration = 0

export async function saveAccount(
  userId: string,
  email: string,
  refreshToken: string,
  scopes: string,
  dek: Uint8Array,
): Promise<EmailAccountRow> {
  const { ciphertext, iv } = await encryptJson(refreshToken, dek)
  // Upsert on (user_id, email) — re-linking an existing account replaces the
  // old refresh token and resets the sync cursor so we re-bootstrap.
  const { data, error } = await supabase
    .from('email_accounts')
    .upsert(
      {
        user_id: userId,
        email,
        provider: 'gmail',
        encrypted_refresh_token: ciphertext,
        iv_refresh_token: iv,
        scopes,
        history_id: null,
        status: 'ok',
      },
      { onConflict: 'user_id,email' },
    )
    .select(COLUMNS)
    .single()
  if (error) throw error
  // Invalidate any cached access token for this account row.
  accessTokenCache.delete((data as EmailAccountRow).id)
  return data as EmailAccountRow
}

export async function listAccounts(): Promise<EmailAccountRow[]> {
  const { data, error } = await supabase
    .from('email_accounts')
    .select(COLUMNS)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as EmailAccountRow[]
}

/**
 * KEY-2FA-2: what the locked watch needs from the DB. Deliberately leaves out
 * the encrypted refresh token columns: while the vault is locked the webview
 * has no use for them.
 */
export interface AccountCursorRow {
  id: string
  email: string
  history_id: string | null
  status: string
}

export async function listAccountCursors(): Promise<AccountCursorRow[]> {
  const { data, error } = await supabase
    .from('email_accounts')
    .select('id, email, history_id, status')
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as AccountCursorRow[]
}

export async function deleteAccount(id: string): Promise<void> {
  const { error } = await supabase.from('email_accounts').delete().eq('id', id)
  if (error) throw error
  accessTokenCache.delete(id)
}

export async function updateHistoryCursor(
  id: string,
  historyId: string,
  syncedAt: Date = new Date(),
): Promise<void> {
  const { error } = await supabase
    .from('email_accounts')
    .update({ history_id: historyId, last_synced_at: syncedAt.toISOString() })
    .eq('id', id)
  if (error) throw error
}

export async function markNeedsReauth(id: string): Promise<void> {
  const { error } = await supabase
    .from('email_accounts')
    .update({ status: 'needs_reauth' })
    .eq('id', id)
  if (error) console.warn('[tokens] markNeedsReauth failed:', error)
  accessTokenCache.delete(id)
}

/**
 * Return a non-expired access token for the account. Uses the cache; on miss
 * or near-expiry, decrypts the refresh token and trades it for a new access
 * token at Google. On `invalid_grant`, marks the account `needs_reauth` and
 * rethrows so the caller can skip it this tick.
 */
export async function getAccessToken(
  account: EmailAccountRow,
  dek: Uint8Array,
): Promise<string> {
  const cached = accessTokenCache.get(account.id)
  if (cached && cached.expiresAt > Date.now()) return cached.token
  const generation = cacheGeneration

  const refreshToken = await decryptJson<string>(
    account.encrypted_refresh_token,
    account.iv_refresh_token,
    dek,
  )

  try {
    const fresh = await refreshAccessToken(refreshToken)
    if (generation === cacheGeneration) {
      accessTokenCache.set(account.id, { token: fresh.accessToken, expiresAt: fresh.expiresAt })
    }
    return fresh.accessToken
  } catch (err) {
    if (err instanceof GoogleOAuthError && err.message === 'REAUTH_REQUIRED') {
      await markNeedsReauth(account.id)
    }
    throw err
  }
}

/** Force-evict (on lock, KEY-2FA-2). */
export function clearAccessTokenCache(): void {
  cacheGeneration += 1
  accessTokenCache.clear()
}

/** Test helper: how many access tokens the webview currently holds. */
export function accessTokenCacheSize(): number {
  return accessTokenCache.size
}
