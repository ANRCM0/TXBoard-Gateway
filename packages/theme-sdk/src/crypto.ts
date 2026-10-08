import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core'

export type KeyDiscovery = {
  protocol: 'HPKE-RFC9180'
  suite: 'DHKEM(P-256,HKDF-SHA256)+HKDF-SHA256+AES-256-GCM'
  kid: string
  publicKey: string
  scope: 'login-only'
}
const info = new TextEncoder().encode('TXBOARD-GW-V1-LOGIN-HPKE')
const aadPrefix = 'txboard-gateway:v1\nPOST\n/gateway/v1/secure/auth/login\n'
const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm(),
})
function fromB64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 500) throw new Error('Invalid published HPKE key')
  const input = value.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(input)
  return Uint8Array.from(raw, x => x.charCodeAt(0))
}
function toB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export async function encryptLoginPayload(key: KeyDiscovery, data: unknown) {
  if (key.protocol !== 'HPKE-RFC9180'
    || key.suite !== 'DHKEM(P-256,HKDF-SHA256)+HKDF-SHA256+AES-256-GCM'
    || key.scope !== 'login-only'
    || !/^[a-f0-9]{24}$/.test(key.kid)) {
    throw new Error('Unsupported Gateway encryption parameters')
  }
  const publicKey = await suite.kem.deserializePublicKey(fromB64(key.publicKey))
  const sender = await suite.createSenderContext({ recipientPublicKey: publicKey, info })
  const ts = Date.now()
  const nonce = toB64(crypto.getRandomValues(new Uint8Array(16)))
  const aad = new TextEncoder().encode(aadPrefix + key.kid + '\n' + ts + '\n' + nonce)
  const ciphertext = await sender.seal(new TextEncoder().encode(JSON.stringify(data)), aad)
  return { kid: key.kid, ts, nonce, enc: toB64(new Uint8Array(sender.enc)), ct: toB64(new Uint8Array(ciphertext)) }
}
