import { createHash } from 'node:crypto'
import { createClient } from 'redis'

/**
 * GW-203: login anti-credential-stuffing protection.
 *
 * Dual-dimension design (account + source IP):
 *  - Request-budget throttling lives in services/redis-security.ts (cheap
 *    cap per account/IP per window, fail-closed on Redis errors).
 *  - This module adds *outcome-driven* protection: only real upstream
 *    rejections advance the counters, successful logins reset them, and
 *    repeated failures escalate first to a CAPTCHA challenge and then to a
 *    progressive lockout.
 *
 * Enumeration resistance:
 *  - Counters are keyed on the *submitted* email, not on whether the account
 *    exists. An unknown email fails upstream just like a wrong password, so
 *    the captcha/lock escalation timeline and every response body/status are
 *    byte-identical for existing and non-existing accounts.
 *  - The Gateway never validates CAPTCHA tokens itself; it only signals that
 *    a challenge must be satisfied. Laravel CaptchaService stays the final
 *    authority and the token is forwarded verbatim as a standard field.
 *  - Locked and challenge responses are emitted before the upstream call, so
 *    no timing or error-message difference can distinguish real accounts.
 */

export type LoginVerdict = 'allow' | 'captcha' | 'locked'

export interface LoginAdmission {
  verdict: LoginVerdict
  /** Remaining lock duration in ms; 0 unless verdict === 'locked'. */
  retryAfterMs: number
}

export interface LoginProtection {
  /** Non-consuming admission check. Throws on store unavailability (fail closed). */
  admit(email: string, clientIp?: string): Promise<LoginAdmission>
  /** Record an upstream auth rejection; may raise the verdict to captcha/locked. */
  recordFailure(email: string, clientIp?: string): Promise<LoginAdmission>
  /** Record a successful login; clears the account dimension only. */
  recordSuccess(email: string): Promise<void>
}

export type LoginPolicy = {
  /** Failed attempts (per dimension) before a CAPTCHA challenge is demanded. */
  accountCaptchaAfter: number
  ipCaptchaAfter: number
  /** Lifetime of the failure counter itself. Lock TTLs may outlive it. */
  failureWindowMs: number
  /** Ascending [failureCount, lockMs] tiers. Later matching tiers win. */
  lockTiers: Array<[number, number]>
}

export const defaultLoginPolicy: LoginPolicy = {
  accountCaptchaAfter: 3,
  ipCaptchaAfter: 12,
  failureWindowMs: 900_000,
  lockTiers: [
    [5, 60_000],
    [10, 900_000],
    [20, 3_600_000],
    [40, 86_400_000],
  ],
}

const VERDICT_RANK: Record<LoginVerdict, number> = { allow: 0, captcha: 1, locked: 2 }

function worse(a: LoginAdmission, b: LoginAdmission): LoginAdmission {
  return VERDICT_RANK[b.verdict] > VERDICT_RANK[a.verdict] ? b : a
}

export function normalizeLoginEmail(email: string): string {
  return email.trim().toLowerCase()
}

function digest(namespace: 'a' | 'i', value: string): string {
  // Redis keys never contain raw emails or IPs; namespace prefix keeps the
  // account and IP key spaces disjoint even for identical hashed input.
  return createHash('sha256').update(namespace + '|' + value).digest('hex')
}

function lockMsFor(policy: LoginPolicy, failures: number): number {
  let ms = 0
  for (const [threshold, tierMs] of policy.lockTiers) {
    if (failures >= threshold) ms = Math.max(ms, tierMs)
  }
  return ms
}

// KEYS: failKey, lockKey. ARGV[1]=captchaAfter, ARGV[2]=windowMs, then
// ascending threshold/lockMs tier pairs.
const ADMIT_LUA = [
  "if redis.call('EXISTS', KEYS[2]) == 1 then return {2, redis.call('PTTL', KEYS[2])} end",
  "local fails = redis.call('GET', KEYS[1])",
  "if fails and tonumber(fails) >= tonumber(ARGV[1]) then return {1, 0} end",
  'return {0, 0}',
].join('\n')

const RECORD_FAILURE_LUA = [
  "local fails = redis.call('INCR', KEYS[1])",
  "if fails == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end",
  'local lockMs = 0',
  'for i = 3, #ARGV, 2 do',
  '  if tonumber(fails) >= tonumber(ARGV[i]) then lockMs = tonumber(ARGV[i + 1]) end',
  'end',
  "if lockMs > 0 then redis.call('SET', KEYS[2], tostring(lockMs), 'PX', lockMs) end",
  "if redis.call('EXISTS', KEYS[2]) == 1 then return {2, redis.call('PTTL', KEYS[2])} end",
  "if tonumber(fails) >= tonumber(ARGV[1]) then return {1, 0} end",
  'return {0, 0}',
].join('\n')

const RECORD_SUCCESS_LUA = [
  "redis.call('DEL', KEYS[1], KEYS[2])",
  'return 1',
].join('\n')

function verdictFrom(raw: unknown): LoginAdmission {
  if (!Array.isArray(raw) || raw.length !== 2) {
    throw new Error('Unexpected login protection reply')
  }
  const [code, ttl] = raw
  if (code === 2) {
    const ms = typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0 ? ttl : 1
    return { verdict: 'locked', retryAfterMs: ms }
  }
  if (code === 1) return { verdict: 'captcha', retryAfterMs: 0 }
  return { verdict: 'allow', retryAfterMs: 0 }
}

function tierArgs(policy: LoginPolicy, captchaAfter: number): string[] {
  const args = [String(captchaAfter), String(policy.failureWindowMs)]
  for (const [threshold, ms] of policy.lockTiers) {
    args.push(String(threshold), String(ms))
  }
  return args
}

/** Redis-backed protection. Atomic per-key Lua scripts; no cross-replica races. */
export class RedisLoginProtection implements LoginProtection {
  private constructor(
    private readonly client: ReturnType<typeof createClient>,
    private readonly policy: LoginPolicy,
    private closed = false,
  ) {}

  static async connect(raw: string, policy: LoginPolicy = defaultLoginPolicy): Promise<RedisLoginProtection> {
    let url: URL
    try { url = new URL(raw) } catch { throw new Error('Invalid GATEWAY_REDIS_URL') }
    if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname || url.search || url.hash) {
      throw new Error('Invalid GATEWAY_REDIS_URL')
    }
    const client = createClient({
      url: raw,
      disableOfflineQueue: true,
      socket: { connectTimeout: 2500, reconnectStrategy: false },
    })
    client.on('error', () => {}) // Never log connection URLs or error objects.
    await client.connect()
    if (!client.isReady) throw new Error('Login protection store not ready')
    return new RedisLoginProtection(client, policy)
  }

  private ready() {
    if (!this.client.isReady) throw new Error('Login protection store unavailable')
  }

  /** Closes the underlying client; safe to call twice. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    // A closed/errored client throws on destroy; the protection decision has
    // already been recorded, so swallowing keeps shutdown idempotent.
    try { this.client.destroy() } catch { /* already gone */ }
  }

  private keys(dimension: 'a' | 'i', value: string) {
    const h = digest(dimension, value)
    return ['txbgw:v1:login:fail:' + h, 'txbgw:v1:login:lock:' + h]
  }

  private async dimensionCheck(keys: string[], captchaAfter: number): Promise<LoginAdmission> {
    this.ready()
    try {
      return verdictFrom(await this.client.eval(ADMIT_LUA, {
        keys, arguments: [String(captchaAfter)],
      }))
    } catch {
      throw new Error('Login protection store unavailable')
    }
  }

  private async dimensionFailure(keys: string[], captchaAfter: number): Promise<LoginAdmission> {
    this.ready()
    try {
      return verdictFrom(await this.client.eval(RECORD_FAILURE_LUA, {
        keys, arguments: tierArgs(this.policy, captchaAfter),
      }))
    } catch {
      throw new Error('Login protection store unavailable')
    }
  }

  async admit(email: string, clientIp?: string): Promise<LoginAdmission> {
    const account = await this.dimensionCheck(this.keys('a', normalizeLoginEmail(email)), this.policy.accountCaptchaAfter)
    if (!clientIp) return account
    const ip = await this.dimensionCheck(this.keys('i', clientIp), this.policy.ipCaptchaAfter)
    return worse(account, ip)
  }

  async recordFailure(email: string, clientIp?: string): Promise<LoginAdmission> {
    const account = await this.dimensionFailure(this.keys('a', normalizeLoginEmail(email)), this.policy.accountCaptchaAfter)
    if (!clientIp) return account
    const ip = await this.dimensionFailure(this.keys('i', clientIp), this.policy.ipCaptchaAfter)
    return worse(account, ip)
  }

  async recordSuccess(email: string): Promise<void> {
    // IP failures deliberately survive a single account's success: one real
    // user logging in must not launder credential-stuffing counters.
    this.ready()
    try {
      await this.client.eval(RECORD_SUCCESS_LUA, { keys: this.keys('a', normalizeLoginEmail(email)), arguments: [] })
    } catch {
      throw new Error('Login protection store unavailable')
    }
  }
}

/**
 * In-process implementation mirroring the Lua semantics. Used by unit tests
 * and single-node deployments without Redis. Semantics (window expiry, tier
 * escalation, IP counters surviving account success) are identical.
 */
export class MemoryLoginProtection implements LoginProtection {
  private readonly fails = new Map<string, { count: number; expiresAt: number }>()
  private readonly locks = new Map<string, number>()

  constructor(private readonly policy: LoginPolicy = defaultLoginPolicy, private readonly now: () => number = Date.now) {}

  private current(key: string): number {
    const entry = this.fails.get(key)
    if (!entry) return 0
    if (entry.expiresAt <= this.now()) {
      this.fails.delete(key)
      return 0
    }
    return entry.count
  }

  private checkDimension(namespace: 'a' | 'i', value: string, captchaAfter: number): LoginAdmission {
    const h = digest(namespace, value)
    const lockedUntil = this.locks.get(h)
    if (lockedUntil !== undefined) {
      const remaining = lockedUntil - this.now()
      if (remaining > 0) return { verdict: 'locked', retryAfterMs: remaining }
      this.locks.delete(h)
    }
    return this.current(h) >= captchaAfter
      ? { verdict: 'captcha', retryAfterMs: 0 }
      : { verdict: 'allow', retryAfterMs: 0 }
  }

  private recordDimension(namespace: 'a' | 'i', value: string, captchaAfter: number): LoginAdmission {
    const h = digest(namespace, value)
    const at = this.now()
    const entry = this.fails.get(h)
    const count = entry && entry.expiresAt > at ? entry.count + 1 : 1
    this.fails.set(h, { count, expiresAt: at + this.policy.failureWindowMs })
    const lockMs = lockMsFor(this.policy, count)
    if (lockMs > 0) this.locks.set(h, at + lockMs)
    return this.checkDimension(namespace, value, captchaAfter)
  }

  async admit(email: string, clientIp?: string): Promise<LoginAdmission> {
    const account = this.checkDimension('a', normalizeLoginEmail(email), this.policy.accountCaptchaAfter)
    if (!clientIp) return account
    return worse(account, this.checkDimension('i', clientIp, this.policy.ipCaptchaAfter))
  }

  async recordFailure(email: string, clientIp?: string): Promise<LoginAdmission> {
    const account = this.recordDimension('a', normalizeLoginEmail(email), this.policy.accountCaptchaAfter)
    if (!clientIp) return account
    return worse(account, this.recordDimension('i', clientIp, this.policy.ipCaptchaAfter))
  }

  async recordSuccess(email: string): Promise<void> {
    const h = digest('a', normalizeLoginEmail(email))
    this.fails.delete(h)
    this.locks.delete(h)
  }
}

export async function loadLoginProtection(
  env: Record<string, string | undefined> = process.env,
): Promise<LoginProtection | undefined> {
  if (!env.GATEWAY_REDIS_URL) return undefined
  return RedisLoginProtection.connect(env.GATEWAY_REDIS_URL)
}
