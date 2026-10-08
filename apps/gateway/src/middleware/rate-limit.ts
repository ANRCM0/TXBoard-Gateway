import { createHash, randomBytes } from 'node:crypto'
import { createClient } from 'redis'
import { GatewayFailure } from '../services/upstream.js'

/**
 * GW-202: Redis atomic sliding-window rate limiter with route-level policies.
 *
 * Design notes:
 * - One Lua script evaluates BOTH the IP dimension and the subject (account)
 *   dimension in a single atomic server-side execution, so concurrent Gateway
 *   replicas observe a consistent decision and can never interleave a
 *   GET/INCR race (the failure mode of the old fixed-window counter).
 * - Sliding window (not fixed bucket): each admitted request is a scored
 *   member of a ZSET; the window is trimmed with ZREMRANGEBYSCORE on every
 *   call, so a burst at the window edge cannot double the effective quota.
 * - Keys never contain raw emails, tokens or IPs beyond a keyed SHA-256
 *   digest, mirroring the privacy rule of redis-security.ts.
 * - Retry-After is derived from the oldest in-window member's expiry, not
 *   from the full window, so clients are told the real wait.
 */

export type RateDimension = 'ip' | 'subject'

export interface RouteRatePolicy {
  /** Stable policy id, also the key namespace segment. */
  id: string
  /** Path prefix match (longest match wins). */
  match: string
  /** Optional HTTP method filter; undefined = any method. */
  method?: string
  /** IP dimension quota within windowMs. 0 disables the dimension. */
  ipLimit: number
  ipWindowMs: number
  /** Subject dimension quota within subjectWindowMs. 0/undefined = off. */
  subjectLimit?: number
  subjectWindowMs?: number
  /** How the subject identity is derived for authenticated/account routes. */
  subjectFrom?: 'email' | 'bearer'
  /** Sensitive routes (login/register/email-code) fail closed on Redis error. */
  failClosed: boolean
}

export interface ResolvedPolicy extends RouteRatePolicy {
  subjectWindow: number
}

/**
 * Candidate initial quotas (docs/implementation-plan.md §2.2). Tune after
 * load testing; these are deliberately conservative for credential endpoints.
 * WAF / Laravel-side limits remain in force — this is defense in depth.
 */
export const ROUTE_POLICIES: readonly RouteRatePolicy[] = [
  // --- credential / abuse-sensitive writes: fail-closed, dual dimension ---
  {
    id: 'auth-login',
    match: '/gateway/v1/secure/auth/login',
    method: 'POST',
    ipLimit: 5, ipWindowMs: 300_000,
    subjectLimit: 5, subjectWindowMs: 900_000, subjectFrom: 'email',
    failClosed: true,
  },
  {
    id: 'auth-login-plain',
    match: '/gateway/v1/auth/login',
    method: 'POST',
    ipLimit: 5, ipWindowMs: 300_000,
    subjectLimit: 5, subjectWindowMs: 900_000, subjectFrom: 'email',
    failClosed: true,
  },
  {
    id: 'auth-register',
    match: '/gateway/v1/secure/auth/register',
    method: 'POST',
    ipLimit: 3, ipWindowMs: 600_000,
    subjectLimit: 3, subjectWindowMs: 1_800_000, subjectFrom: 'email',
    failClosed: true,
  },
  {
    id: 'auth-email-code',
    match: '/gateway/v1/secure/auth/email-code',
    method: 'POST',
    ipLimit: 2, ipWindowMs: 600_000,
    subjectLimit: 2, subjectWindowMs: 1_800_000, subjectFrom: 'email',
    failClosed: true,
  },
  // --- authenticated reads: dual dimension, bearer-derived subject ---
  {
    id: 'user-orders',
    match: '/gateway/v1/orders',
    ipLimit: 60, ipWindowMs: 60_000,
    subjectLimit: 120, subjectWindowMs: 60_000, subjectFrom: 'bearer',
    failClosed: false,
  },
  {
    id: 'user-read',
    match: '/gateway/v1/user',
    ipLimit: 60, ipWindowMs: 60_000,
    subjectLimit: 120, subjectWindowMs: 60_000, subjectFrom: 'bearer',
    failClosed: false,
  },
  {
    id: 'payments',
    match: '/gateway/v1/payments',
    ipLimit: 60, ipWindowMs: 60_000,
    subjectLimit: 120, subjectWindowMs: 60_000, subjectFrom: 'bearer',
    failClosed: false,
  },
  // --- public guest reads: IP only, fail-open with conservative fallback ---
  {
    id: 'guest-read',
    match: '/gateway/v1/bootstrap',
    ipLimit: 60, ipWindowMs: 60_000,
    failClosed: false,
  },
  {
    id: 'guest-read',
    match: '/gateway/v1/theme',
    ipLimit: 60, ipWindowMs: 60_000,
    failClosed: false,
  },
  {
    id: 'guest-read',
    match: '/gateway/v1/plans',
    ipLimit: 60, ipWindowMs: 60_000,
    failClosed: false,
  },
  {
    id: 'crypto-key',
    match: '/gateway/v1/crypto/key',
    ipLimit: 60, ipWindowMs: 60_000,
    failClosed: false,
  },
  // --- catch-all for any future /gateway/v1/* route ---
  {
    id: 'gateway-default',
    match: '/gateway/v1',
    ipLimit: 120, ipWindowMs: 60_000,
    failClosed: false,
  },
]

/**
 * Longest-prefix route match with optional method filter.
 * Returns undefined for paths outside the limited surface (e.g. /healthz).
 */
export function resolveRoutePolicy(
  path: string,
  method = 'GET',
  policies: readonly RouteRatePolicy[] = ROUTE_POLICIES,
): ResolvedPolicy | undefined {
  let best: ResolvedPolicy | undefined
  for (const policy of policies) {
    if (!path.startsWith(policy.match)) continue
    if (policy.method && policy.method !== method.toUpperCase()) continue
    if (!best || policy.match.length > best.match.length) {
      best = { ...policy, subjectWindow: policy.subjectWindowMs ?? policy.ipWindowMs }
    }
  }
  return best
}

/** Keyed digest so key material is bounded-length and non-reversible. */
export function digestIdentity(salt: string, value: string): string {
  return createHash('sha256').update(salt).update('\u0000').update(value).digest('hex').slice(0, 32)
}

/** Retry-After seconds: always >= 1, derived from the real remaining wait. */
export function retryAfterSeconds(retryAfterMs: number): number {
  if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return 1
  return Math.max(1, Math.ceil(retryAfterMs / 1000))
}

/**
 * Sliding-window limiter, both dimensions, single atomic execution.
 *
 * KEYS[1] = IP key, KEYS[2] = subject key
 * ARGV   = now, member, ipLimit, ipWindowMs, subjectLimit, subjectWindowMs
 * returns { limited(0/1), retryAfterMs, ipCount, subjectCount }
 *
 * Invariants:
 * - A dimension with limit 0 is fully disabled (no key access at all).
 * - The subject key is only written when its limit is active; callers pass a
 *   namespaced dummy key otherwise (Redis requires the key to be declared).
 * - A request is admitted only when BOTH dimensions have headroom. If the IP
 *   dimension already rejected, the subject slot is not consumed.
 * - Retry-After is the max remaining wait across the rejecting dimensions,
 *   measured from the oldest in-window member.
 */
const SLIDING_WINDOW_LUA = `
local now = tonumber(ARGV[1])
local member = ARGV[2]
local limited = 0
local retry = 0
local ipCount = -1
local subjectCount = -1

local function oldestRetry(key, window)
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  if oldest[2] ~= nil then
    local r = (tonumber(oldest[2]) + window) - now
    if r > retry then retry = r end
  else
    if window > retry then retry = window end
  end
end

local ipLimit = tonumber(ARGV[3])
if ipLimit > 0 then
  local w = tonumber(ARGV[4])
  redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - w)
  local c = redis.call('ZCARD', KEYS[1])
  ipCount = c
  if c >= ipLimit then
    limited = 1
    oldestRetry(KEYS[1], w)
  else
    redis.call('ZADD', KEYS[1], now, member)
    redis.call('PEXPIRE', KEYS[1], w)
  end
end

local subjectLimit = tonumber(ARGV[5])
if subjectLimit > 0 then
  local w = tonumber(ARGV[6])
  redis.call('ZREMRANGEBYSCORE', KEYS[2], 0, now - w)
  local c = redis.call('ZCARD', KEYS[2])
  subjectCount = c
  if limited == 0 and c >= subjectLimit then
    limited = 1
    oldestRetry(KEYS[2], w)
  elseif limited == 0 then
    redis.call('ZADD', KEYS[2], now, member)
    redis.call('PEXPIRE', KEYS[2], w)
  end
end

return { limited, math.ceil(retry), ipCount, subjectCount }
`

export interface RateCheckInput {
  policy: ResolvedPolicy
  /** Sanitized client IP (GW-204 verdict), never a raw header. */
  ip: string
  /** Verified subject identity (already extracted + trimmed by the caller). */
  subject?: string
}

export interface RateDecision {
  allowed: boolean
  retryAfterMs: number
  retryAfterHeader: number
  ipCount: number
  subjectCount: number
  /** True when Redis failed and the route policy failed OPEN (degraded). */
  degraded: boolean
}

export interface RateLimiterStats {
  checks: number
  limited: number
  degraded: number
  redisFailures: number
}

type RedisEvalOptions = { keys: string[]; arguments: string[] }
export interface RedisLike {
  isReady: boolean
  eval(script: string, options: RedisEvalOptions): Promise<unknown>
}

const DUMMY_KEY = 'txbgw:v1:rl:none'

/**
 * Engine usable with the real redis client or a test double that implements
 * `eval`/`isReady` with the same reply shapes (node-redis reply semantics).
 */
export class RedisRateLimiter {
  private readonly stats: RateLimiterStats = { checks: 0, limited: 0, degraded: 0, redisFailures: 0 }

  private constructor(private readonly client: RedisLike) {}

  static withClient(client: RedisLike): RedisRateLimiter {
    return new RedisRateLimiter(client)
  }

  static async connect(raw: string): Promise<RedisRateLimiter> {
    let url: URL
    try { url = new URL(raw) } catch { throw new Error('Invalid GATEWAY_REDIS_URL') }
    if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname
      || url.search || url.hash) throw new Error('Invalid GATEWAY_REDIS_URL')
    const client = createClient({
      url: raw,
      disableOfflineQueue: true,
      socket: { connectTimeout: 2500, reconnectStrategy: false },
    })
    client.on('error', () => {})
    await client.connect()
    if (!client.isReady) throw new Error('Redis rate limiter store not ready')
    return new RedisRateLimiter(client)
  }

  getStats(): Readonly<RateLimiterStats> {
    return { ...this.stats }
  }

  async close(): Promise<void> {
    const closable = this.client as unknown as { destroy?: () => void; quit?: () => Promise<void> }
    if (typeof closable.quit === 'function') await closable.quit().catch(() => {})
    else if (typeof closable.destroy === 'function') closable.destroy()
  }

  async check(input: RateCheckInput): Promise<RateDecision> {
    const { policy, ip } = input
    this.stats.checks += 1
    const now = Date.now()
    const member = `${now}-${randomBytes(8).toString('hex')}`
    const ipKey = `txbgw:v1:rl:${policy.id}:ip:${digestIdentity(policy.id, ip)}`
    const subjectLimit = policy.subjectFrom && input.subject
      ? (policy.subjectLimit ?? 0)
      : 0
    const subjectKey = subjectLimit > 0
      ? `txbgw:v1:rl:${policy.id}:acct:${digestIdentity(policy.id, input.subject!)}`
      : DUMMY_KEY

    let reply: unknown
    try {
      reply = await this.client.eval(SLIDING_WINDOW_LUA, {
        keys: [ipKey, subjectKey],
        arguments: [
          String(now),
          member,
          String(policy.ipLimit),
          String(policy.ipWindowMs),
          String(subjectLimit),
          String(policy.subjectWindow),
        ],
      })
    } catch {
      this.stats.redisFailures += 1
      if (policy.failClosed) {
        throw new GatewayFailure('UPSTREAM_UNAVAILABLE', 503, 'Rate limiter unavailable')
      }
      // Public/read routes fail OPEN but flagged degraded for observability.
      this.stats.degraded += 1
      return {
        allowed: true, retryAfterMs: 0, retryAfterHeader: 1,
        ipCount: -1, subjectCount: -1, degraded: true,
      }
    }

    const values = Array.isArray(reply) ? reply : []
    // Strict shape validation: a reply that is not [limited(0|1), retryMs,
    // ipCount, subjectCount] is treated as a limiter failure, never as
    // "allowed" — and never silently reinterpreted as a rejection either.
    const wellFormed = values.length === 4
      && (values[0] === 0 || values[0] === 1)
      && Number.isSafeInteger(Number(values[1]))
      && Number.isSafeInteger(Number(values[2]))
      && Number.isSafeInteger(Number(values[3]))
    if (!wellFormed) {
      this.stats.redisFailures += 1
      if (policy.failClosed) {
        throw new GatewayFailure('UPSTREAM_UNAVAILABLE', 503, 'Rate limiter unavailable')
      }
      this.stats.degraded += 1
      return {
        allowed: true, retryAfterMs: 0, retryAfterHeader: 1,
        ipCount: -1, subjectCount: -1, degraded: true,
      }
    }

    const limited = values[0] === 1
    const retryMs = Number(values[1])
    const ipCount = Number(values[2])
    const subjectCount = Number(values[3])
    if (limited) {
      this.stats.limited += 1
      return {
        allowed: false,
        retryAfterMs: retryMs,
        retryAfterHeader: retryAfterSeconds(retryMs),
        ipCount, subjectCount, degraded: false,
      }
    }
    return {
      allowed: true, retryAfterMs: 0, retryAfterHeader: 0,
      ipCount, subjectCount, degraded: false,
    }
  }
}

/** Extract the subject identity for a policy, or undefined when absent. */
export function extractSubject(
  policy: ResolvedPolicy,
  source: { authorization?: string; bodyEmail?: string },
): string | undefined {
  if (!policy.subjectFrom) return undefined
  if (policy.subjectFrom === 'email') {
    const email = source.bodyEmail?.trim().toLowerCase()
    return email && email.length <= 254 ? email : undefined
  }
  // bearer: hash the whole token value; never store the raw token in Redis.
  const auth = source.authorization || ''
  return /^Bearer \S{8,4096}$/.test(auth) ? auth : undefined
}
