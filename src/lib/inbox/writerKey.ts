/**
 * VAULT-1: the public half of the key that signs every list Claude's writer puts in the
 * sealed inbox. Pinned in the app on purpose: an envelope that does not verify against THIS
 * key is thrown away, so someone who can write to the database (or who has the write secret)
 * still cannot plant an item in the brief. The private half lives only in ~/.config/keyring-inbox/
 * on Nicolas's Mac, outside every synced folder. Rotating it means a new Keyring release.
 */
export const WRITER_SIGNING_PUBLIC_JWK: JsonWebKey = {
  kty: 'EC',
  crv: 'P-256',
  x: '9s2nQvyQP81ew873Ej51w7e1nSH8zqWHwi3-Lk1aNeU',
  y: 'iV8-ov5VyrYjBLpo2R4-ITtP4CrytN6XA4UPOJQBo50',
}
