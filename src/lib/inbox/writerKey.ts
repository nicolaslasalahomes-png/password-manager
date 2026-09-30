/**
 * VAULT-1: the public half of the key that signs every list Claude's writer puts in the
 * sealed inbox. Pinned in the app on purpose: an envelope that does not verify against THIS
 * key is thrown away, so someone who can write to the database (or who has the write secret)
 * still cannot plant an item in the brief. The private half lives only in a memory file on
 * Nicolas's Mac. Rotating it means a new Keyring release.
 */
export const WRITER_SIGNING_PUBLIC_JWK: JsonWebKey = {
  kty: 'EC',
  crv: 'P-256',
  x: 'oRMC9MxB_DJSRyc9aLybCl6aF7YOsCrzvhVZiZuGNJk',
  y: 'zg_BZz4olvTKUn_WQ7rIAF13IoU6u3oIN869G_ukVcs',
}
