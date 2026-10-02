/**
 * KEY-2FA-2: once the vault locks, the webview holds no Gmail token, and the
 * locked watch reads no secret column from the DB.
 */
import { describe, it, expect, vi } from 'vitest'

const selects: string[] = []
vi.mock('../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: (cols: string) => {
        selects.push(cols)
        return { order: async () => ({ data: [], error: null }) }
      },
    }),
  },
}))
vi.mock('../src/lib/encryption', () => ({
  decryptJson: async () => 'refresh-token',
  encryptJson: async () => ({ ciphertext: '', iv: '' }),
}))
vi.mock('../src/lib/google/oauth', () => ({
  GoogleOAuthError: class extends Error {},
  refreshAccessToken: async () => ({ accessToken: 'ya29.secret', expiresAt: Date.now() + 3_600_000 }),
}))

import {
  accessTokenCacheSize,
  clearAccessTokenCache,
  getAccessToken,
  listAccountCursors,
  type EmailAccountRow,
} from '../src/lib/google/tokens'

const row = { id: 'a1', encrypted_refresh_token: 'ct', iv_refresh_token: 'iv' } as EmailAccountRow

describe('webview tokens on lock', () => {
  it('clearing on lock leaves no access token in the webview', async () => {
    await getAccessToken(row, new Uint8Array(32))
    expect(accessTokenCacheSize()).toBe(1)
    clearAccessTokenCache() // what App.tsx does the moment the vault locks
    expect(accessTokenCacheSize()).toBe(0)
  })

  it('a refresh in flight when the vault locks does not refill the cache', async () => {
    clearAccessTokenCache()
    const pending = getAccessToken({ ...row, id: 'a2' }, new Uint8Array(32))
    clearAccessTokenCache() // lock lands mid-refresh
    await pending
    expect(accessTokenCacheSize()).toBe(0)
  })

  it('the locked watch account query leaves out the encrypted token columns', async () => {
    await listAccountCursors()
    expect(selects.at(-1)).toBe('id, email, history_id, status')
    expect(selects.at(-1)).not.toMatch(/refresh/)
  })
})
