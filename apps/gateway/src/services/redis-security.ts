import { createHash } from 'node:crypto'
import { createClient } from 'redis'
import { GatewayFailure } from '../services/upstream.js'
import type { ReplayStore } from '../services/crypto.js'

export type AccountAction = 'login' | 'register' | 'email-code'
export interface AccountLimiter { check(action: AccountAction, email: string, clientIp?: string): Promise<void> }

const policies: Record<AccountAction, { limit: number; ms: number }> = {
  login: { limit: 8, ms: 60_000 },
  register: { limit: 3, ms: 600_000 },
  'email-code': { limit: 2, ms: 600_000 },
}

// Atomic count+expiry. No GET/INCR race between Gateway replicas.
const RATE_LUA = [
  "local n=redis.call('INCR', KEYS[1])",
  "if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end",
  "return n",
].join('\n')

/** Both replay and account throttle are fail-closed. Redis keys never contain
 * raw email addresses, credentials, CAPTCHA tokens or session identifiers. */
export class RedisSecurity implements ReplayStore, AccountLimiter {
  private constructor(private readonly client: ReturnType<typeof createClient>) {}

  static async connect(raw: string): Promise<RedisSecurity> {
    let url: URL
    try { url = new URL(raw) } catch { throw new Error('Invalid GATEWAY_REDIS_URL') }
    if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname
      || url.search || url.hash) throw new Error('Invalid GATEWAY_REDIS_URL')
    const client = createClient({
      url: raw,
      disableOfflineQueue: true,
      socket: { connectTimeout: 2500, reconnectStrategy: false },
    })
    // Do not log Redis error objects, connection URLs or password-bearing DSNs.
    client.on('error', () => {})
    await client.connect()
    if (!client.isReady) throw new Error('Redis safety store not ready')
    return new RedisSecurity(client)
  }
  private ready() {
    if (!this.client.isReady) {
      throw new GatewayFailure('UPSTREAM_UNAVAILABLE', 503, 'Redis safety store unavailable')
    }
  }
  async reserve(kid: string, nonce: string, ttlMs: number): Promise<boolean> {
    this.ready()
    try {
      const result = await this.client.set(
        'txbgw:v1:replay:' + kid + ':' + nonce, '1', { NX: true, PX: ttlMs },
      )
      return result === 'OK'
    } catch {
      throw new GatewayFailure('UPSTREAM_UNAVAILABLE', 503, 'Redis safety store unavailable')
    }
  }
  async check(action: AccountAction, email: string, clientIp?: string): Promise<void> {
    this.ready()
    const policy = policies[action]
    const digest = createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
    const key = 'txbgw:v1:rate:' + action + ':' + digest
    let used: unknown
    try {
      used = await this.client.eval(RATE_LUA, {
        keys: [key], arguments: [String(policy.ms)],
      })
    } catch {
      throw new GatewayFailure('UPSTREAM_UNAVAILABLE', 503, 'Redis safety store unavailable')
    }
    if (typeof used !== 'number' || !Number.isSafeInteger(used)) {
      throw new GatewayFailure('UPSTREAM_UNAVAILABLE', 503, 'Redis safety store unavailable')
    }
    if (used > policy.limit) {
      throw new GatewayFailure('RATE_LIMITED', 429, 'Too many requests')
    }
    // GW-204: per-source cap on top of the per-account cap. The key is a hash of
    // the sanitized client IP (never the raw header), so credential stuffing from
    // one host cannot spread across many accounts, and rotating IPs cannot spread
    // a single account's budget. clientIp is advisory: absence skips this check.
    if (clientIp) {
      const ipDigest = createHash('sha256').update(clientIp).digest('hex')
      const ipKey = 'txbgw:v1:rateip:' + action + ':' + ipDigest
      let ipUsed: unknown
      try {
        ipUsed = await this.client.eval(RATE_LUA, {
          keys: [ipKey], arguments: [String(policy.ms)],
        })
      } catch {
        throw new GatewayFailure('UPSTREAM_UNAVAILABLE', 503, 'Redis safety store unavailable')
      }
      if (typeof ipUsed !== 'number' || !Number.isSafeInteger(ipUsed)) {
        throw new GatewayFailure('UPSTREAM_UNAVAILABLE', 503, 'Redis safety store unavailable')
      }
      const ipPolicy: Record<AccountAction, number> = { login: 30, register: 10, 'email-code': 6 }
      if (ipUsed > ipPolicy[action]) {
        throw new GatewayFailure('RATE_LIMITED', 429, 'Too many requests')
      }
    }
  }
  async close(): Promise<void> { this.client.destroy() }
}

export async function loadRedisSecurity(env: NodeJS.ProcessEnv): Promise<RedisSecurity | undefined> {
  if (!env.GATEWAY_REDIS_URL) return undefined
  return RedisSecurity.connect(env.GATEWAY_REDIS_URL)
}
