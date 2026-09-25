/**
 * Google OAuth 2.0 PKCE flow — JS half.
 *
 * The Rust side (`start_google_oauth` command) handles the loopback HTTP
 * server + browser-opening + state validation, and returns
 * { code, code_verifier, redirect_uri } to us. We then POST to Google's
 * token endpoint ourselves so the refresh token never leaves JS — it goes
 * straight into the encrypted Supabase row.
 */

import { getStoreValue, isDesktop, setStoreValue } from '../desktop'

const ENV_CLIENT_ID = (import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID ?? '') as string
const ENV_CLIENT_SECRET = (import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_SECRET ?? '') as string
const STORE_KEY_ID = 'googleOauthClientId'
const STORE_KEY_SECRET = 'googleOauthClientSecret'

/**
 * Returns the user's Google OAuth Client ID. Prefers the value they pasted
 * into Inbox Settings (stored via tauri-plugin-store); falls back to the
 * VITE_GOOGLE_OAUTH_CLIENT_ID env var baked in at build time.
 */
export async function getEffectiveClientId(): Promise<string> {
  const stored = await getStoreValue<string>(STORE_KEY_ID)
  if (stored && stored.trim().length > 0) return stored.trim()
  return ENV_CLIENT_ID.trim()
}

/**
 * Returns the user's Google OAuth Client Secret. Stored alongside the Client
 * ID. Per Google's own docs, this is "not actually confidential" for installed
 * (Desktop) apps — Google doesn't enforce its secrecy because it's expected to
 * ship inside the binary. Local plaintext storage in the Tauri store is fine.
 *
 * Required because Google's token endpoint validates the secret even for
 * Desktop clients using PKCE, despite RFC 8252's "public client" model.
 */
export async function getEffectiveClientSecret(): Promise<string> {
  const stored = await getStoreValue<string>(STORE_KEY_SECRET)
  if (stored && stored.trim().length > 0) return stored.trim()
  return ENV_CLIENT_SECRET.trim()
}

export async function saveClientId(clientId: string): Promise<void> {
  await setStoreValue(STORE_KEY_ID, clientId.trim())
}

export async function saveClientSecret(secret: string): Promise<void> {
  await setStoreValue(STORE_KEY_SECRET, secret.trim())
}

export async function clearStoredCredentials(): Promise<void> {
  await setStoreValue(STORE_KEY_ID, '')
  await setStoreValue(STORE_KEY_SECRET, '')
}

/**
 * `gmail.modify` covers read + archive (remove INBOX label) + trash.
 * Compose / send would need `gmail.send`; not in v1.
 *
 * `openid email` lets us decode the user's email from the returned id_token
 * so we don't have to make a separate `userinfo` API call to label the row.
 */
export const SCOPES = 'https://www.googleapis.com/auth/gmail.modify openid email'

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke'

export class GoogleOAuthError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'GoogleOAuthError'
  }
}

interface OAuthLoopbackResult {
  code: string
  code_verifier: string
  redirect_uri: string
}

interface TokenResponse {
  access_token: string
  expires_in: number
  refresh_token?: string
  id_token?: string
  token_type: string
  scope: string
}

/** Async — both Client ID and Client Secret must be set. */
export async function isGoogleOAuthConfigured(): Promise<boolean> {
  const [id, secret] = await Promise.all([getEffectiveClientId(), getEffectiveClientSecret()])
  return id.length > 0 && secret.length > 0
}

/**
 * Drive the PKCE loopback flow end-to-end. Resolves with the user's Gmail
 * address (decoded from the id_token) and a fresh refresh_token that the
 * caller MUST encrypt and store immediately.
 *
 * Throws GoogleOAuthError on any failure (no Client ID, user cancelled,
 * network error, missing refresh_token, etc).
 */
export async function connectGoogleAccount(): Promise<{
  email: string
  refreshToken: string
  scopes: string
}> {
  if (!isDesktop()) {
    throw new GoogleOAuthError('Gmail accounts can only be linked from the desktop app.')
  }
  const [clientId, clientSecret] = await Promise.all([
    getEffectiveClientId(),
    getEffectiveClientSecret(),
  ])
  if (!clientId || !clientSecret) {
    throw new GoogleOAuthError(
      'Google OAuth is not configured. Paste your Client ID AND Client Secret into Inbox Settings.',
    )
  }

  // 1. Rust opens the browser, waits on a loopback redirect, returns the code.
  const loopback = await runOAuthLoopback(clientId)

  // 2. Exchange the code for tokens ourselves.
  const tokens = await exchangeCodeForTokens(loopback, clientId, clientSecret)

  if (!tokens.refresh_token) {
    throw new GoogleOAuthError(
      "Google didn't return a refresh token. Make sure the OAuth consent screen forces consent (`prompt=consent`) and the account hasn't already authorized this client.",
    )
  }

  // 3. Decode the email from the id_token so we know which account we just linked.
  const email = decodeEmailFromIdToken(tokens.id_token)
  if (!email) {
    throw new GoogleOAuthError('Could not read account email from id_token.')
  }

  return { email, refreshToken: tokens.refresh_token, scopes: tokens.scope ?? SCOPES }
}

/**
 * Exchange an existing refresh token for a fresh access token. Returns the
 * access token plus its absolute expiry timestamp (ms since epoch). Called
 * by the access-token cache in tokens.ts on cache miss / expiry.
 *
 * Throws if Google returns `invalid_grant` (the user revoked the token or
 * changed their password) — the caller should mark the account as needs_reauth.
 */
export async function refreshAccessToken(
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: number }> {
  const [clientId, clientSecret] = await Promise.all([
    getEffectiveClientId(),
    getEffectiveClientSecret(),
  ])
  if (!clientId || !clientSecret) throw new GoogleOAuthError('Google OAuth credentials missing')
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  })
  const resp = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    if (resp.status === 400 && text.includes('invalid_grant')) {
      throw new GoogleOAuthError('REAUTH_REQUIRED')
    }
    throw new GoogleOAuthError(`Token refresh failed (${resp.status}): ${text}`)
  }
  const json = (await resp.json()) as TokenResponse
  return {
    accessToken: json.access_token,
    expiresAt: Date.now() + Math.max(0, (json.expires_in - 30) * 1000), // 30s safety margin
  }
}

/**
 * Tell Google to invalidate this refresh token. Best-effort — even if it
 * fails (network down, token already revoked) we still delete our local
 * copy. Used by Inbox Settings → Disconnect.
 */
export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  try {
    await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(refreshToken)}`, {
      method: 'POST',
    })
  } catch (err) {
    console.warn('[google-oauth] revoke failed (non-fatal):', err)
  }
}

// ── Internals ──────────────────────────────────────────────────────────────

async function runOAuthLoopback(clientId: string): Promise<OAuthLoopbackResult> {
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    return (await invoke('start_google_oauth', {
      clientId,
      scopes: SCOPES,
    })) as OAuthLoopbackResult
  } catch (err) {
    throw new GoogleOAuthError(
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'OAuth flow failed',
      err,
    )
  }
}

async function exchangeCodeForTokens(
  loopback: OAuthLoopbackResult,
  clientId: string,
  clientSecret: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: loopback.code,
    code_verifier: loopback.code_verifier,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: loopback.redirect_uri,
  })
  const resp = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new GoogleOAuthError(`Token exchange failed (${resp.status}): ${text}`)
  }
  return (await resp.json()) as TokenResponse
}

/**
 * id_token is a JWT; we only need the email claim from the payload (no
 * signature verification needed — we just received it directly from Google
 * over TLS over our own loopback).
 */
function decodeEmailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null
  const parts = idToken.split('.')
  if (parts.length < 2) return null
  try {
    const payload = JSON.parse(b64urlDecode(parts[1])) as { email?: string }
    return typeof payload.email === 'string' ? payload.email : null
  } catch {
    return null
  }
}

function b64urlDecode(s: string): string {
  // base64url → base64 → atob (handles UTF-8 safely for the email field)
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(b64)
  // Decode possibly-UTF-8 bytes
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}
