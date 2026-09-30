/**
 * VAULT-2: the public half of the key Nicolas's replies are sealed to. Only the reader on his Mac
 * (scripts/keyring-pull.mjs, private key in ~/.config/keyring-inbox/, never synced) can open a
 * reply. Pinned here so the server cannot swap in its own key. Rotating it means a new release.
 */
export const READER_PUBLIC_JWK: JsonWebKey = {
  kty: 'EC',
  crv: 'P-256',
  x: 'a9rSAPgH2JHnMouOamKaYcm-WhEXTLBasJwmuFrfxck',
  y: 'uLTQ5a3vE9fpNfrMSmbF31kybC_4tAfyZ312bxOH4wM',
}
