/**
 * VAULT-1: this vault's inbox keypair.
 *
 * Made once, on the first unlock after the update: an ECDH P-256 pair. The PUBLIC key is
 * stored in plaintext so Claude's writer can seal lists to it. The PRIVATE key is stored only
 * AES-GCM-encrypted under the vault's DEK (low tier), like every other secret here, so the
 * server can never open a list. The DEK is re-wrapped, not replaced, when the master password
 * changes, so this key survives that.
 *
 * On every load the private key is checked against the stored public key: if someone swapped
 * the public key in the database (to have lists sealed to them instead), the app says so.
 */
import { supabase } from '../supabase'
import { decryptJson, encryptJson } from '../encryption'

export interface InboxKeyRow {
  user_id: string
  public_key_jwk: JsonWebKey
  encrypted_private_key: string
  iv: string
}

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const

export class InboxKeyMismatchError extends Error {
  constructor() {
    super('The inbox public key on the server does not match this vault’s private key. Lists are not being opened.')
    this.name = 'InboxKeyMismatchError'
  }
}

/** Build a new row's contents. Pure apart from randomness; exported for tests. */
export async function makeInboxKeyMaterial(
  dek: Uint8Array,
): Promise<{ public_key_jwk: JsonWebKey; encrypted_private_key: string; iv: string }> {
  const kp = (await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair
  const pub = await crypto.subtle.exportKey('jwk', kp.publicKey)
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey))
  let s = ''
  for (let i = 0; i < pkcs8.length; i++) s += String.fromCharCode(pkcs8[i])
  const { ciphertext, iv } = await encryptJson(btoa(s), dek)
  return {
    public_key_jwk: { kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y },
    encrypted_private_key: ciphertext,
    iv,
  }
}

/** Unwrap the private key and check it belongs to the stored public key. */
export async function unwrapInboxKey(
  row: Pick<InboxKeyRow, 'public_key_jwk' | 'encrypted_private_key' | 'iv'>,
  dek: Uint8Array,
): Promise<CryptoKey> {
  const b64 = await decryptJson<string>(row.encrypted_private_key, row.iv, dek)
  const bin = atob(b64)
  const pkcs8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) pkcs8[i] = bin.charCodeAt(i)
  const extractable = await crypto.subtle.importKey('pkcs8', pkcs8 as unknown as BufferSource, ECDH, true, ['deriveBits'])
  const jwk = await crypto.subtle.exportKey('jwk', extractable)
  pkcs8.fill(0)
  if (jwk.x !== row.public_key_jwk.x || jwk.y !== row.public_key_jwk.y) throw new InboxKeyMismatchError()
  // Hand back a non-extractable copy.
  return crypto.subtle.importKey('jwk', jwk, ECDH, false, ['deriveBits'])
}

/** The inbox private key, creating the pair on first use. */
export async function ensureInboxKey(userId: string, dek: Uint8Array): Promise<CryptoKey> {
  const read = () =>
    supabase
      .from('vault_inbox_keys')
      .select('user_id, public_key_jwk, encrypted_private_key, iv')
      .eq('user_id', userId)
      .maybeSingle()
  let { data, error } = await read()
  if (error) throw error
  if (!data) {
    const material = await makeInboxKeyMaterial(dek)
    const ins = await supabase.from('vault_inbox_keys').insert({ user_id: userId, ...material })
    // 23505: another device made it first. Use theirs.
    if (ins.error && ins.error.code !== '23505') throw ins.error
    ;({ data, error } = await read())
    if (error) throw error
    if (!data) throw new Error('Could not create the inbox key')
  }
  return unwrapInboxKey(data as InboxKeyRow, dek)
}
