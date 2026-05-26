/**
 * Zero-knowledge encryption layer.
 *
 * Master password (never sent to server) → PBKDF2 → KEK
 * KEK encrypts a randomly generated DEK (stored on server as ciphertext)
 * DEK encrypts every vault item (per-item random IV, AES-GCM-256)
 *
 * Server-side compromise reveals only ciphertext + KDF salt + verifier.
 * Without the master password, nothing decrypts.
 */

const KDF_ITERATIONS = 600_000 // OWASP 2023 recommendation for PBKDF2-SHA256
const KDF_HASH = 'SHA-256' as const
const SALT_BYTES = 16
const IV_BYTES = 12
const DEK_BYTES = 32 // AES-256

const VERIFIER_PLAINTEXT = 'keyring-verifier-v1'

export interface KdfParams {
  algo: 'PBKDF2'
  iterations: number
  hash: 'SHA-256'
}

export const DEFAULT_KDF_PARAMS: KdfParams = {
  algo: 'PBKDF2',
  iterations: KDF_ITERATIONS,
  hash: KDF_HASH,
}

// ── Base64 helpers ──────────────────────────────────────────────────────────

export function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

export function randomBytes(n: number): Uint8Array {
  const a = new Uint8Array(n)
  crypto.getRandomValues(a)
  return a
}

// ── Low-level primitives ────────────────────────────────────────────────────

// Cast helper: TS 5.7+ tightened Uint8Array typing — WebCrypto wants
// ArrayBuffer-backed views, not the new generic Uint8Array<ArrayBufferLike>.
// All our Uint8Arrays are ArrayBuffer-backed; the cast is sound.
const buf = (u: Uint8Array): BufferSource => u as unknown as BufferSource

async function deriveKek(
  masterPassword: string,
  salt: Uint8Array,
  params: KdfParams,
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    buf(new TextEncoder().encode(masterPassword)),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: params.algo,
      salt: buf(salt),
      iterations: params.iterations,
      hash: params.hash,
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function aesGcmEncrypt(
  key: CryptoKey,
  iv: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv) }, key, buf(data))
  return new Uint8Array(ct)
}

async function aesGcmDecrypt(
  key: CryptoKey,
  iv: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(iv) }, key, buf(data))
  return new Uint8Array(pt)
}

// ── Vault setup (first-run, when user picks their master password) ──────────

export interface VaultSetupMaterial {
  encryptedDek: string
  ivDek: string
  kdfSalt: string
  kdfParams: KdfParams
  verifierCiphertext: string
  verifierIv: string
  /** Returned in-memory so the user is immediately unlocked after setup. */
  dek: Uint8Array
}

export async function setupVault(masterPassword: string): Promise<VaultSetupMaterial> {
  if (masterPassword.length < 8) {
    throw new Error('Master password must be at least 8 characters')
  }
  const kdfSalt = randomBytes(SALT_BYTES)
  const kek = await deriveKek(masterPassword, kdfSalt, DEFAULT_KDF_PARAMS)

  const dek = randomBytes(DEK_BYTES)
  const ivDek = randomBytes(IV_BYTES)
  const encryptedDek = await aesGcmEncrypt(kek, ivDek, dek)

  const verifierIv = randomBytes(IV_BYTES)
  const verifierCiphertext = await aesGcmEncrypt(
    kek,
    verifierIv,
    new TextEncoder().encode(VERIFIER_PLAINTEXT),
  )

  return {
    encryptedDek: toBase64(encryptedDek),
    ivDek: toBase64(ivDek),
    kdfSalt: toBase64(kdfSalt),
    kdfParams: DEFAULT_KDF_PARAMS,
    verifierCiphertext: toBase64(verifierCiphertext),
    verifierIv: toBase64(verifierIv),
    dek,
  }
}

// ── Vault unlock (every subsequent session) ─────────────────────────────────

export interface VaultUnlockArgs {
  masterPassword: string
  kdfSalt: string
  kdfParams: KdfParams
  verifierCiphertext: string
  verifierIv: string
  encryptedDek: string
  ivDek: string
}

export async function unlockVault(args: VaultUnlockArgs): Promise<{ dek: Uint8Array }> {
  const salt = fromBase64(args.kdfSalt)
  const kek = await deriveKek(args.masterPassword, salt, args.kdfParams)

  // Verifier check — fails fast on wrong password without touching the DEK
  try {
    const verifierPt = await aesGcmDecrypt(
      kek,
      fromBase64(args.verifierIv),
      fromBase64(args.verifierCiphertext),
    )
    if (new TextDecoder().decode(verifierPt) !== VERIFIER_PLAINTEXT) {
      throw new Error('Verifier mismatch')
    }
  } catch {
    throw new Error('Incorrect master password')
  }

  const dek = await aesGcmDecrypt(kek, fromBase64(args.ivDek), fromBase64(args.encryptedDek))
  return { dek }
}

/**
 * Re-derive the KEK and check the verifier only (no DEK decryption).
 * Used for re-prompting high-tier items.
 */
export async function verifyMasterPassword(args: {
  masterPassword: string
  kdfSalt: string
  kdfParams: KdfParams
  verifierCiphertext: string
  verifierIv: string
}): Promise<boolean> {
  try {
    const salt = fromBase64(args.kdfSalt)
    const kek = await deriveKek(args.masterPassword, salt, args.kdfParams)
    const pt = await aesGcmDecrypt(
      kek,
      fromBase64(args.verifierIv),
      fromBase64(args.verifierCiphertext),
    )
    return new TextDecoder().decode(pt) === VERIFIER_PLAINTEXT
  } catch {
    return false
  }
}

// ── Per-item encryption ─────────────────────────────────────────────────────

async function importDek(dek: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', buf(dek), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function encryptJson(
  payload: unknown,
  dek: Uint8Array,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await importDek(dek)
  const iv = randomBytes(IV_BYTES)
  const data = new TextEncoder().encode(JSON.stringify(payload))
  const ct = await aesGcmEncrypt(key, iv, data)
  return { ciphertext: toBase64(ct), iv: toBase64(iv) }
}

export async function decryptJson<T = unknown>(
  ciphertext: string,
  iv: string,
  dek: Uint8Array,
): Promise<T> {
  const key = await importDek(dek)
  const pt = await aesGcmDecrypt(key, fromBase64(iv), fromBase64(ciphertext))
  return JSON.parse(new TextDecoder().decode(pt)) as T
}

/** Overwrite sensitive bytes in memory. Best-effort — V8 may keep copies. */
export function zero(buf: Uint8Array): void {
  buf.fill(0)
}
