import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core'
import { GatewayFailure } from '../services/upstream.js'

const info = new TextEncoder().encode('TXBOARD-GW-V1-LOGIN-HPKE')
const aadPrefix = 'txboard-gateway:v1\nPOST\n/gateway/v1/secure/auth/'
const replayWindowMs = 60_000
export type CryptoOperation = 'login' | 'register' | 'email-code'
export interface ReplayStore {
  reserve(kid: string, nonce: string, ttlMs: number): Promise<boolean>
}

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
function aad(request: SealedRequest, operation: CryptoOperation) {
  return new TextEncoder().encode(aadPrefix + operation + '\n' +
    request.kid + '\n' + request.ts + '\n' + request.nonce)
}

export class CryptoService {
  private constructor(
    private readonly privateKey: CryptoKey,
    private readonly replay: ReplayStore,
    private readonly published: { protocol: 'HPKE-RFC9180'; suite: string; kid: string; publicKey: string; scope: 'login-only' | 'account-workflows' },
  ) {}

  static async create(jwk: JsonWebKey, replay: ReplayStore, accountWorkflows = false): Promise<CryptoService> {
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) {
      throw new Error('Gateway HPKE key must be a P-256 private JWK')
    }
    const secret = await suite.kem.importKey('jwk', jwk, false)
    const publicKey = await suite.kem.importKey('jwk',
      { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, true)
    const serialized = new Uint8Array(await suite.kem.serializePublicKey(publicKey))
    const kid = createHash('sha256').update(serialized).digest('hex').slice(0, 24)
    if (!replay) throw new Error('Redis replay store required for encrypted Gateway')
    return new CryptoService(secret, replay, {
      protocol: 'HPKE-RFC9180',
      suite: 'DHKEM(P-256,HKDF-SHA256)+HKDF-SHA256+AES-256-GCM',
      kid,
      publicKey: Buffer.from(serialized).toString('base64url'),
      scope: accountWorkflows ? 'account-workflows' : 'login-only',
    } as const)
  }
  publicKey() { return { ...this.published } }

  async open(request: SealedRequest, operation: CryptoOperation = 'login'): Promise<unknown> {
    if (operation !== 'login' && this.published.scope !== 'account-workflows') {
      throw new GatewayFailure('VALIDATION_ERROR', 404, 'Encrypted operation is disabled')
    }
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
      plaintext = await recipient.open(fromB64(request.ct, 20000), aad(request, operation))
    } catch {
      throw new GatewayFailure('VALIDATION_ERROR', 400, 'Invalid encrypted request')
    }
    // The atomic Redis SET NX PX happens before any Laravel effect. If Redis
    // is down, fail closed; there is no process-local replay fallback.
    let first: boolean
    try {
      first = await this.replay.reserve(request.kid, request.nonce, replayWindowMs * 2 + 1000)
    } catch {
      throw new GatewayFailure('UPSTREAM_UNAVAILABLE', 503, 'Replay protection unavailable')
    }
    if (!first) throw new GatewayFailure('VALIDATION_ERROR', 409, 'Replayed encrypted request')
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext))
    } catch {
      throw new GatewayFailure('VALIDATION_ERROR', 400, 'Invalid decrypted JSON')
    }
  }
}

export async function loadCryptoService(
  env: NodeJS.ProcessEnv, replay?: ReplayStore,
): Promise<CryptoService | undefined> {
  const mode = env.GATEWAY_HPKE_MODE || 'disabled'
  if (!['disabled', 'optional'].includes(mode)) throw new Error('Unsupported GATEWAY_HPKE_MODE')
  if (mode === 'disabled') return undefined
  if (!replay) throw new Error('Redis replay protection is required for HPKE mode')
  const accountEnabled = env.GATEWAY_ACCOUNT_WORKFLOWS_ENABLED === 'true'
  const keyFile = env.GATEWAY_HPKE_KEY_FILE
  if (!keyFile || !keyFile.startsWith('/')) {
    throw new Error('GATEWAY_HPKE_KEY_FILE must be an absolute Docker secret path')
  }
  // No generated/ephemeral key on each restart: fail hard without persisted key.
  const content = await readFile(keyFile, { encoding: 'utf8' })
  let jwk: JsonWebKey
  try { jwk = JSON.parse(content) } catch { throw new Error('Gateway HPKE key file is not valid JSON') }
  return CryptoService.create(jwk, replay, accountEnabled)
}
