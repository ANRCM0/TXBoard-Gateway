import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core'
import { GatewayFailure } from './upstream.js'

const info = new TextEncoder().encode('TXBOARD-GW-V1-LOGIN-HPKE')
const aadPrefix = 'txboard-gateway:v1\nPOST\n/gateway/v1/secure/auth/login\n'
const replayWindowMs = 60_000
const maxReplayEntries = 10_000

const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm(),
})

export type SealedRequest = {
  kid: string
  ts: number
  nonce: string
  enc: string
  ct: string
}

function fromB64(value: string, max: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > max) throw new Error('Invalid base64url')
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.toString('base64url') !== value) throw new Error('Invalid base64url encoding')
  return bytes
}
function aad(request: SealedRequest) {
  return new TextEncoder().encode(aadPrefix + request.kid + '\n' + request.ts + '\n' + request.nonce)
}

export class CryptoService {
  private readonly seen = new Map<string, number>()

  private constructor(
    private readonly privateKey: CryptoKey,
    private readonly published: { protocol: 'HPKE-RFC9180'; suite: string; kid: string; publicKey: string; scope: 'login-only' },
  ) {}

  static async create(jwk: JsonWebKey): Promise<CryptoService> {
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) {
      throw new Error('Gateway HPKE key must be a P-256 private JWK')
    }
    const secret = await suite.kem.importKey('jwk', jwk, false)
    const publicKey = await suite.kem.importKey('jwk',
      { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, true)
    const serialized = new Uint8Array(await suite.kem.serializePublicKey(publicKey))
    const kid = createHash('sha256').update(serialized).digest('hex').slice(0, 24)
    return new CryptoService(secret, {
      protocol: 'HPKE-RFC9180',
      suite: 'DHKEM(P-256,HKDF-SHA256)+HKDF-SHA256+AES-256-GCM',
      kid,
      publicKey: Buffer.from(serialized).toString('base64url'),
      scope: 'login-only',
    })
  }
  publicKey() { return { ...this.published } }

  async open(request: SealedRequest): Promise<unknown> {
    if (request.kid !== this.published.kid) {
      throw new GatewayFailure('VALIDATION_ERROR', 400, 'Unknown encryption key')
    }
    if (!Number.isSafeInteger(request.ts) || Math.abs(Date.now() - request.ts) > replayWindowMs) {
      throw new GatewayFailure('VALIDATION_ERROR', 400, 'Expired encrypted request')
    }
    let plaintext: ArrayBuffer
    try {
      const recipient = await suite.createRecipientContext({
        recipientKey: this.privateKey,
        enc: fromB64(request.enc, 500),
        info,
      })
      plaintext = await recipient.open(fromB64(request.ct, 20000), aad(request))
    } catch {
      throw new GatewayFailure('VALIDATION_ERROR', 400, 'Invalid encrypted request')
    }
    // Process-local anti-replay is deliberately limited to one Docker instance.
    // Distributed deployments must use Redis SET NX before enabling this operation.
    const now = Date.now()
    for (const [k, expires] of this.seen) {
      if (expires <= now) this.seen.delete(k)
    }
    const replayKey = request.kid + ':' + request.nonce
    if (this.seen.has(replayKey)) {
      throw new GatewayFailure('VALIDATION_ERROR', 409, 'Replayed encrypted request')
    }
    if (this.seen.size >= maxReplayEntries) {
      throw new GatewayFailure('UPSTREAM_UNAVAILABLE', 503, 'Encrypted request capacity exceeded')
    }
    this.seen.set(replayKey, now + replayWindowMs)
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))
    } catch {
      throw new GatewayFailure('VALIDATION_ERROR', 400, 'Invalid decrypted JSON')
    }
  }
}

export async function loadCryptoService(env: NodeJS.ProcessEnv): Promise<CryptoService | undefined> {
  const mode = env.GATEWAY_HPKE_MODE || 'disabled'
  if (!['disabled', 'optional'].includes(mode)) throw new Error('Unsupported GATEWAY_HPKE_MODE')
  if (mode === 'disabled') return undefined
  const keyFile = env.GATEWAY_HPKE_KEY_FILE
  if (!keyFile || !keyFile.startsWith('/')) {
    throw new Error('GATEWAY_HPKE_KEY_FILE must be an absolute Docker secret path')
  }
  // No generated/ephemeral key on each restart: fail hard without persisted key.
  const content = await readFile(keyFile, { encoding: 'utf8' })
  let jwk: JsonWebKey
  try { jwk = JSON.parse(content) } catch { throw new Error('Gateway HPKE key file is not valid JSON') }
  return CryptoService.create(jwk)
}
