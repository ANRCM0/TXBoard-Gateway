import { describe, expect, it, vi } from 'vitest'
import {
  compileIpAllowlist,
  evaluateRequest,
  forgedHeaderNames,
  hostMatchesAllowlist,
  proxyHeaderNames,
  requiresCredentialProof,
  sanitizeForwardedHeaders,
} from '../src/middleware/security.js'
import {
  RedisRateLimiter,
  digestIdentity,
  extractSubject,
  hasLimitableIdentity,
  rateLimitKey,
  resolveRoutePolicy,
  retryAfterSeconds,
  subjectDimensionEnforced,
  type RouteRatePolicy,
  type ResolvedPolicy,
} from '../src/middleware/rate-limit.js'
import { createGatewayApp, safeHostHeader } from '../src/app.js'
import { loadConfig } from '../src/config/env.js'

const config = loadConfig({
  TXBOARD_UPSTREAM_URL: 'https://txboard.example/',
  GATEWAY_ALLOWED_ORIGINS: 'https://theme.example',
})

const ALLOW = compileIpAllowlist('10.0.0.0/8')

/** Build a Request whose socket peer is `peer` (the gateway's test seam). */
function requestFromPeer(peer: string, init?: RequestInit) {
  const req = new Request('https://gateway.test/gateway/v1/bootstrap', init)
  Object.defineProperty(req, '__peerIp', { value: peer, enumerable: false })
  return req
}

/** In-memory stand-in for the Redis Lua script (same reply shape). */
function fakeRedis(impl?: (args: { keys: string[]; args: string[] }) => unknown) {
  const calls: { keys: string[]; args: string[] }[] = []
  return {
    isReady: true,
    eval: vi.fn(async (_script: string, opts: { keys: string[]; arguments: string[] }) => {
      calls.push({ keys: opts.keys, args: opts.arguments })
      return impl ? impl({ keys: opts.keys, args: opts.arguments }) : [0, 0, 1, 1]
    }),
    calls,
  }
}

/**
 * Counting sliding-window double: evaluates the real decision rules for both
 * dimensions in order (IP first, then subject), so dual-layer behaviour can be
 * exercised in a unit test without Redis. Members are only recorded for
 * admitted requests, exactly like the production Lua script.
 *
 * `override` replaces the caller's quota so a boundary (e.g. one admission)
 * is reachable without editing the production policy table.
 */
function countingRedis(
  limits: { ipLimit: number; subjectLimit?: number; ipWindowMs?: number; subjectWindowMs?: number },
  override?: { ipLimit?: number },
) {
  const ipWindowMs = limits.ipWindowMs ?? 60_000
  const subjectWindowMs = limits.subjectWindowMs ?? ipWindowMs
  const ipMembers = new Map<string, number[]>()
  const subjectMembers = new Map<string, number[]>()
  return {
    isReady: true,
    calls: [] as { keys: string[]; args: string[] }[],
    async eval(_script: string, opts: { keys: string[]; arguments: string[] }) {
      // ARGV is 1-based in Lua (ARGV[1]=now, ARGV[2]=member, ARGV[3]=ipLimit,
      // ARGV[4]=ipWindowMs, ARGV[5]=subjectLimit, ARGV[6]=subjectWindowMs);
      // node-redis passes the same list 0-indexed, so index 2 is ARGV[3].
      const args = opts.arguments.map(Number)
      const now = args[0]!
      const ipLimit = override?.ipLimit ?? args[2]!
      const ipWindow = args[3]!
      const sLimit = args[4]!
      const sWindow = args[5]!
      const [ipKey, subjectKey] = opts.keys
      let limited = 0
      let retryMs = 0
      const trim = (store: Map<string, number[]>, key: string, window: number) => {
        const list = (store.get(key) ?? []).filter(ts => ts > now - window)
        store.set(key, list)
        return list
      }
      const ipList = trim(ipMembers, ipKey!, ipWindow)
      const ipCount = ipList.length
      if (ipCount >= ipLimit) {
        limited = 1
        retryMs = Math.max(retryMs, Math.min(...ipList) + ipWindow - now)
      } else {
        ipList.push(now)
      }
      let subjectCount = -1
      if (sLimit > 0) {
        const subjectList = trim(subjectMembers, subjectKey!, sWindow)
        subjectCount = subjectList.length
        if (limited === 0 && subjectCount >= sLimit) {
          limited = 1
          retryMs = Math.max(retryMs, Math.min(...subjectList) + sWindow - now)
        } else if (limited === 0) {
          subjectList.push(now)
        }
      }
      return [limited, Math.ceil(retryMs), ipCount, subjectCount]
    },
  }
}

function policy(overrides: Partial<RouteRatePolicy>): ResolvedPolicy {
  const base: RouteRatePolicy = {
    id: 'gw215test', match: '/gateway/v1', ipLimit: 5, ipWindowMs: 60_000,
    failClosed: false,
  }
  const merged = { ...base, ...overrides }
  return { ...merged, subjectWindow: merged.subjectWindowMs ?? merged.ipWindowMs }
}

const upstreamOk = () => Response.json({ status: 'success', data: {} })

// ---------------------------------------------------------------------------
// GW-213 / GW-215 (a): forged forwarded headers from an untrusted peer
// ---------------------------------------------------------------------------
describe('GW-213 spoofed forwarded headers from an untrusted peer', () => {
  it('rejects every proxy header name from an untrusted peer, and the spoofed value never becomes the limiting IP', async () => {
    const fetcher = vi.fn(async () => upstreamOk())
    const app = createGatewayApp(config, fetcher as never, undefined, { trustedIngress: '10.0.0.0/8' })
    for (const header of ['x-forwarded-for', 'x-real-ip', 'x-forwarded-host', 'forwarded']) {
      const res = await app.request(requestFromPeer('203.0.113.9', {
        headers: { [header]: '10.0.0.1' },
      }))
      expect(res.status).toBe(403)
      expect((await res.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN')
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('keeps the socket peer as the limiting client IP, ignoring the forged value', () => {
    const verdict = evaluateRequest('203.0.113.9', new Headers({
      'X-Forwarded-For': '1.2.3.4', 'X-Real-IP': '5.6.7.8',
    }), ALLOW)
    expect(verdict.trusted).toBe(false)
    expect(verdict.reason).toBe('forged_headers')
    expect(verdict.clientIp).toBe('203.0.113.9')
    expect(verdict.clientIp).not.toContain('1.2.3.4')
  })

  it('names the offending headers for structured (name-only) denial logging', () => {
    expect(forgedHeaderNames(new Headers({ 'X-Real-IP': '9.9.9.9' }))).toEqual(['x-real-ip'])
    expect(forgedHeaderNames(new Headers())).toEqual([])
  })

  it('the spoofed IP never reaches the limiter: the rejected request is stopped before it', async () => {
    const redis = countingRedis({ ipLimit: 1 })
    const limiter = RedisRateLimiter.withClient(redis as never)
    const app = createGatewayApp(config, vi.fn(async () => upstreamOk()) as never, undefined, {
      trustedIngress: '10.0.0.0/8', rateLimiter: limiter,
    })
    const res = await app.request(requestFromPeer('203.0.113.9', {
      headers: { 'X-Forwarded-For': '10.0.0.1' },
    }))
    expect(res.status).toBe(403)
    // No limiter call at all, therefore no key can be built from the spoofed IP.
    expect(redis.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// GW-213 (b): trusted ingress honors headers, picks the right-most untrusted hop
// ---------------------------------------------------------------------------
describe('GW-213 trusted ingress header honoring', () => {
  it('honors forwarded headers only from an allowlisted peer', () => {
    const headers = new Headers({ 'X-Forwarded-For': '1.2.3.4' })
    expect(evaluateRequest('10.0.0.7', headers, ALLOW).trusted).toBe(true)
    expect(evaluateRequest('203.0.113.9', headers, ALLOW).trusted).toBe(false)
  })

  it('chooses the right-most hop that is NOT itself a trusted ingress', () => {
    // Trusted proxy 10.0.0.7 forwarded for 10.0.0.8 (another trusted hop),
    // which itself forwarded for the real client 1.2.3.4.
    const headers = new Headers({ 'X-Forwarded-For': '1.2.3.4, 10.0.0.8' })
    expect(evaluateRequest('10.0.0.7', headers, ALLOW).clientIp).toBe('1.2.3.4')
    // Right-most entry wins when the chain is only trusted hops: 10.0.0.8 is
    // the closest hop to us, so it is the address we keep.
    expect(evaluateRequest('10.0.0.7', new Headers({ 'X-Forwarded-For': '10.0.0.8' }), ALLOW).clientIp)
      .toBe('10.0.0.8')
  })

  it('refuses a syntactically invalid address instead of limiting by garbage', () => {
    const headers = new Headers({ 'X-Real-IP': 'not-an-ip' })
    expect(evaluateRequest('10.0.0.7', headers, ALLOW).clientIp).toBe('10.0.0.7')
  })

  it('passes 200 through the gateway when the ingress is trusted', async () => {
    const fetcher = vi.fn(async () => upstreamOk())
    const app = createGatewayApp(config, fetcher as never, undefined, { trustedIngress: '10.0.0.0/8' })
    const res = await app.request(requestFromPeer('10.0.0.7', {
      headers: { 'X-Forwarded-For': '1.2.3.4' },
    }))
    expect(res.status).toBe(200)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('treats an empty allowlist as trust-nobody', () => {
    expect(evaluateRequest('10.0.0.7', new Headers({ 'X-Forwarded-For': '1.2.3.4' }),
      compileIpAllowlist('')).reason).toBe('forged_headers')
  })
})

// ---------------------------------------------------------------------------
// GW-213 (c): Host hardening
// ---------------------------------------------------------------------------
describe('GW-213 Host header hardening', () => {
  it('rejects CR/LF and whitespace injection payloads', () => {
    for (const bad of [
      'gateway.example.com\r\nX-Evil: 1',
      'gateway.example.com\nX-Evil: 1',
      'gateway example.com',
      'gateway.example.com\tX-Evil',
      'gateway.example.com\tevil',
    ]) {
      expect(safeHostHeader(bad)).toBeNull()
    }
  })

  it('a lone trailing CR/LF cannot smuggle a second host', () => {
    // trim() removes the trailing control character, and the accepted value is
    // the clean hostname — the untrimmed input is never logged or forwarded.
    expect(safeHostHeader('gateway.example.com\r')).toBe('gateway.example.com')
    expect(safeHostHeader('gateway.example.com\r\n')).toBe('gateway.example.com')
    expect(safeHostHeader('evil.com\r\nX-Injected: yes')).toBeNull()
  })

  it("'*.suffix' matches exactly one extra label", async () => {
    await expect(hostMatchesAllowlist('b.example.com', ['*.example.com'])).resolves.toBe(true)
    await expect(hostMatchesAllowlist('a.b.example.com', ['*.example.com'])).resolves.toBe(false)
    await expect(hostMatchesAllowlist('example.com', ['*.example.com'])).resolves.toBe(false)
  })

  it('rejects a Host that is not on the allowlist at the gateway boundary', async () => {
    const fetcher = vi.fn(async () => upstreamOk())
    const app = createGatewayApp(config, fetcher as never, undefined, { allowedHosts: '*.example.com' })
    expect((await app.request(requestFromPeer('10.0.0.7', { headers: { Host: 'b.example.com' } }))).status).toBe(200)
    const nested = await app.request(requestFromPeer('10.0.0.7', { headers: { Host: 'a.b.example.com' } }))
    expect(nested.status).toBe(403)
    expect((await nested.json() as { error: { code: string } }).error.code).toBe('BAD_HOST')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('rejects a wildcard-shaped Host that is not a real hostname', () => {
    // A literal '*.example.com' must never validate as a host.
    expect(safeHostHeader('*.example.com')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// GW-213 (d): Origin allowlist, and no-Origin is not authorization
// ---------------------------------------------------------------------------
describe('GW-213 origin policy', () => {
  it('denies a non-allowlisted origin and never reflects it', async () => {
    const fetcher = vi.fn(async () => upstreamOk())
    const app = createGatewayApp(config, fetcher as never, undefined, { trustedIngress: '10.0.0.0/8' })
    const res = await app.request(requestFromPeer('10.0.0.7', { headers: { Origin: 'https://evil.test' } }))
    expect(res.status).toBe(403)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('ORIGIN_DENIED')
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('a missing Origin does not authorize an authenticated route', async () => {
    const fetcher = vi.fn(async () => Response.json({ status: 'success', data: { email: 'a@b.test' } }))
    const app = createGatewayApp(config, fetcher as never, undefined, { trustedIngress: '10.0.0.0/8' })
    // No Origin header at all on an account-bearing route: rejected for the
    // missing credential, never served because the (absent) Origin "passed".
    for (const path of ['/gateway/v1/user/profile', '/gateway/v1/orders', '/gateway/v1/dashboard/stats',
      '/gateway/v1/notices', '/gateway/v1/payments']) {
      const res = await app.request(new Request('https://gateway.test' + path))
      expect(res.status).toBe(401)
      expect((await res.json() as { error: { code: string } }).error.code).toBe('UNAUTHORIZED')
    }
    expect(fetcher).not.toHaveBeenCalled()
    // A well-formed Bearer still passes the gate and reaches upstream, proving
    // the check is about the missing credential and not about the missing Origin.
    const allowed = await app.request(new Request('https://gateway.test/gateway/v1/user/profile', {
      headers: { Authorization: 'Bearer usertoken_longer_than_eight' },
    }))
    expect(allowed.status).toBe(200)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('accepts the exact allowlisted origin', async () => {
    const fetcher = vi.fn(async () => upstreamOk())
    const app = createGatewayApp(config, fetcher as never, undefined, { trustedIngress: '10.0.0.0/8' })
    const res = await app.request(requestFromPeer('10.0.0.7', { headers: { Origin: 'https://theme.example' } }))
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://theme.example')
    expect(res.headers.get('access-control-allow-credentials')).toBe('false')
  })

  it('requiresCredentialProof covers account-bearing routes and not public reads', () => {
    for (const path of ['/gateway/v1/user/profile', '/gateway/v1/orders', '/gateway/v1/payments',
      '/gateway/v1/notices', '/gateway/v1/dashboard/stats']) {
      expect(requiresCredentialProof(path)).toBe(true)
    }
    for (const path of ['/gateway/v1/plans', '/gateway/v1/bootstrap', '/gateway/v1/theme/config',
      '/gateway/v1/crypto/key', '/gateway/v1/auth/login']) {
      expect(requiresCredentialProof(path)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// GW-215 (e): dual-layer limiting
// ---------------------------------------------------------------------------
describe('GW-215 dual-layer edge + account limiting', () => {
  it('same IP with many distinct accounts trips the IP cap', async () => {
    const redis = countingRedis({ ipLimit: 3 })
    const limiter = RedisRateLimiter.withClient(redis as never)
    const pol = policy({ id: 'gw215-ip', ipLimit: 3, ipWindowMs: 60_000, subjectLimit: 50, subjectFrom: 'email' })
    const outcomes = []
    for (let i = 0; i < 5; i++) {
      outcomes.push(await limiter.check({ policy: pol, ip: '203.0.113.9', subject: `user${i}@a.test` }))
    }
    expect(outcomes.map(o => o.allowed)).toEqual([true, true, true, false, false])
    const rejected = outcomes[3]!
    expect(rejected.retryAfterHeader).toBeGreaterThanOrEqual(1)
    expect(rejected.limitedBy).toBe('ip')
  })

  it('same account with rotating IPs trips the account cap', async () => {
    const redis = countingRedis({ ipLimit: 100, subjectLimit: 3 })
    const limiter = RedisRateLimiter.withClient(redis as never)
    const pol = policy({ id: 'gw215-acct', ipLimit: 100, ipWindowMs: 60_000, subjectLimit: 3, subjectFrom: 'email' })
    const outcomes = []
    for (let i = 0; i < 6; i++) {
      outcomes.push(await limiter.check({ policy: pol, ip: `192.0.2.${i}`, subject: 'victim@example.test' }))
    }
    expect(outcomes.map(o => o.allowed)).toEqual([true, true, true, false, false, false])
    expect(outcomes[3]!.limitedBy).toBe('subject')
    expect(outcomes[3]!.retryAfterHeader).toBeGreaterThanOrEqual(1)
  })

  it('a limited request never reaches upstream, and carries Retry-After >= 1', async () => {
    // Cap the IP dimension at one admission so the boundary is observable; the
    // production guest-read table (60/min) is left untouched. The first call
    // fills the window, so the request below must be rejected.
    const redis = countingRedis({ ipLimit: 1 }, { ipLimit: 1 })
    const limiter = RedisRateLimiter.withClient(redis as never)
    const route = resolveRoutePolicy('/gateway/v1/bootstrap')!
    await limiter.check({ policy: route, ip: '10.0.0.7' })
    const fetcher = vi.fn(async () => upstreamOk())
    const events: unknown[] = []
    const app = createGatewayApp(config, fetcher as never, undefined, {
      trustedIngress: '10.0.0.0/8', rateLimiter: limiter, onRateEvent: e => events.push(e),
    })
    const limited = await app.request(requestFromPeer('10.0.0.7', { headers: { Host: 'gateway.test' } }))
    expect(limited.status).toBe(429)
    const retryAfter = Number(limited.headers.get('Retry-After'))
    expect(Number.isFinite(retryAfter)).toBe(true)
    expect(retryAfter).toBeGreaterThanOrEqual(1)
    expect((await limited.json() as { error: { code: string } }).error.code).toBe('RATE_LIMITED')
    expect(fetcher).not.toHaveBeenCalled()
    expect(events).toEqual([expect.objectContaining({ limited: true, degraded: false })])
  })

  it('the account dimension fails CLOSED when no subject is available', async () => {
    const redis = fakeRedis(() => [0, 0, 1, -1])
    const limiter = RedisRateLimiter.withClient(redis)
    const pol = policy({ id: 'gw215-nosub', subjectLimit: 5, subjectWindowMs: 900_000, subjectFrom: 'email' })
    const decision = await limiter.check({ policy: pol, ip: '203.0.113.4' })
    expect(decision.allowed).toBe(false)
    expect(decision.limitedBy).toBe('missing_subject')
    expect(decision.retryAfterHeader).toBeGreaterThanOrEqual(1)
    expect(limiter.getStats().missingSubject).toBe(1)
    // The IP slot was still consumed, so this is not an unlimited bypass.
    expect(redis.calls).toHaveLength(1)
  })

  it('routes without an account dimension stay IP-only and are never blocked on a missing subject', async () => {
    const redis = fakeRedis()
    const limiter = RedisRateLimiter.withClient(redis)
    const decision = await limiter.check({ policy: policy({ id: 'guest-read' }), ip: '203.0.113.5' })
    expect(decision.allowed).toBe(true)
    expect(decision.limitedBy).toBeUndefined()
  })

  it('every limited decision is attributed to a rejecting dimension', async () => {
    const redis = fakeRedis(() => [1, 12_345, 60, 60])
    const limiter = RedisRateLimiter.withClient(redis)
    const decision = await limiter.check({
      policy: policy({ id: 'gw215-dim', ipLimit: 60, subjectLimit: 120, subjectFrom: 'bearer' }),
      ip: '203.0.113.6', subject: 'Bearer ' + 'a'.repeat(40),
    })
    expect(decision.allowed).toBe(false)
    expect(decision.limitedBy).toBe('ip')
    expect(decision.retryAfterMs).toBe(12_345)
    expect(decision.retryAfterHeader).toBe(13)
  })

  it('subject enforcement predicate mirrors the policy table', () => {
    expect(subjectDimensionEnforced({ subjectFrom: 'email', subjectLimit: 5 }, 'a@b.test')).toBe(true)
    expect(subjectDimensionEnforced({ subjectFrom: 'email', subjectLimit: 5 }, undefined)).toBe(false)
    expect(subjectDimensionEnforced({ subjectFrom: undefined }, undefined)).toBe(true)
    expect(subjectDimensionEnforced({ subjectFrom: 'email', subjectLimit: 0 }, undefined)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// GW-215 (f): Redis failure posture
// ---------------------------------------------------------------------------
describe('GW-215 Redis failure posture', () => {
  it('credential routes fail CLOSED with 503', async () => {
    const limiter = RedisRateLimiter.withClient(fakeRedis(() => { throw new Error('ECONNREFUSED') }))
    const fetcher = vi.fn(async () => upstreamOk())
    const app = createGatewayApp(config, fetcher as never, undefined, { rateLimiter: limiter })
    const res = await app.request('/gateway/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://theme.example' },
      body: JSON.stringify({ email: 'a@b.test', password: 'password12345' }),
    })
    expect(res.status).toBe(503)
    expect((await res.json() as { error: { code: string } }).error.code).toBe('UPSTREAM_UNAVAILABLE')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('public routes degrade, and the degradation is observable rather than silent', async () => {
    const limiter = RedisRateLimiter.withClient(fakeRedis(() => { throw new Error('timeout') }))
    const events: { limited: boolean; degraded: boolean }[] = []
    const fetcher = vi.fn(async () => Response.json({ status: 'success', data: [{ id: 1, name: 'Monthly', month_price: 1200 }] }))
    const app = createGatewayApp(config, fetcher as never, undefined, {
      rateLimiter: limiter, onRateEvent: e => events.push(e),
    })
    const res = await app.request('/gateway/v1/plans')
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Gateway-Rate-Limit')).toBe('degraded')
    expect(events).toEqual([expect.objectContaining({ limited: false, degraded: true })])
    // The limiter itself records it, so metrics can alert on it.
    expect(limiter.getStats().degraded).toBe(1)
    expect(limiter.getStats().redisFailures).toBe(1)
  })
  it('an absent client identity is never treated as unlimited', () => {
    expect(hasLimitableIdentity('203.0.113.9')).toBe(true)
    expect(hasLimitableIdentity('   ')).toBe(false)
    expect(hasLimitableIdentity(undefined)).toBe(false)
    expect(hasLimitableIdentity(null)).toBe(false)
  })

  it('a malformed limiter reply is a failure, never a silent allow', async () => {
    const closed = RedisRateLimiter.withClient(fakeRedis(() => ({ nonsense: true })))
    await expect(closed.check({ policy: policy({ id: 'auth-login', failClosed: true }), ip: '203.0.113.1' }))
      .rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', status: 503 })
    const open = RedisRateLimiter.withClient(fakeRedis(() => [NaN, NaN]))
    const decision = await open.check({ policy: policy({ id: 'guest-read' }), ip: '203.0.113.2' })
    expect(decision.allowed).toBe(true)
    expect(decision.degraded).toBe(true)
  })

  it('Retry-After is always >= 1 for every degraded and limited path', () => {
    expect(retryAfterSeconds(0)).toBe(1)
    expect(retryAfterSeconds(-1)).toBe(1)
    expect(retryAfterSeconds(Number.NaN)).toBe(1)
    expect(retryAfterSeconds(1)).toBe(1)
    expect(retryAfterSeconds(1500)).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// GW-215 (g): multi-replica consistency (shared-state double)
// ---------------------------------------------------------------------------
describe('GW-215 multi-replica consistency', () => {
  it('two independent limiter instances over one shared store agree on the decision', async () => {
    // Both replicas must observe the same window: the underlying store is
    // shared, exactly as a single Redis would be, so their counters interleave
    // atomically instead of each replica believing it has the full budget.
    // The production guarantee comes from the single Lua EVAL (verified in the
    // live-Redis suite); this checks the decision logic is shared-state, not
    // per-instance. Calls are sequenced because the JS double is not itself
    // atomic — Redis is what provides the atomicity under concurrency.
    const store = countingRedis({ ipLimit: 5 })
    const replicaA = RedisRateLimiter.withClient(store as never)
    const replicaB = RedisRateLimiter.withClient(store as never)
    const pol = policy({ id: 'gw215-replica', ipLimit: 5, ipWindowMs: 60_000 })
    const results = []
    for (let i = 0; i < 12; i++) {
      results.push(await (i % 2 === 0 ? replicaA : replicaB).check({ policy: pol, ip: '203.0.113.55' }))
    }
    expect(results.filter(r => r.allowed)).toHaveLength(5)
    expect(results.filter(r => !r.allowed)).toHaveLength(7)
    for (const r of results.filter(x => !x.allowed)) {
      expect(r.retryAfterHeader).toBeGreaterThanOrEqual(1)
      expect(r.retryAfterMs).toBeGreaterThan(0)
    }
    // A replica that has seen nothing locally must still refuse: it reads the
    // shared window, not its own memory.
    const replicaC = RedisRateLimiter.withClient(store as never)
    expect((await replicaC.check({ policy: pol, ip: '203.0.113.55' })).allowed).toBe(false)
  })

  it('the two dimensions are evaluated in one atomic call, not two round-trips', async () => {
    const redis = fakeRedis(() => [0, 0, 1, 1])
    const limiter = RedisRateLimiter.withClient(redis)
    await limiter.check({
      policy: policy({ id: 'gw215-atomic', ipLimit: 60, subjectLimit: 120, subjectWindowMs: 60_000, subjectFrom: 'email' }),
      ip: '203.0.113.77', subject: 'a@b.test',
    })
    // One eval = one atomic script = both keys in a single server-side execution.
    expect(redis.calls).toHaveLength(1)
    const call = redis.calls[0]!
    expect(call.keys).toHaveLength(2)
    expect(call.keys[0]).not.toBe(call.keys[1])
    expect(Number(call.args[2])).toBe(60)
    expect(Number(call.args[4])).toBe(120)
    expect(Number(call.args[5])).toBe(60_000)
  })
})

// ---------------------------------------------------------------------------
// GW-215 (h): Redis key hygiene
// ---------------------------------------------------------------------------
describe('GW-215 Redis key hygiene', () => {
  it('neither dimension key contains the raw identity', () => {
    const ipKey = rateLimitKey('auth-login', 'ip', digestIdentity('auth-login', '203.0.113.9'))
    const accountKey = rateLimitKey('auth-login', 'acct', digestIdentity('auth-login', 'victim@example.test'))
    expect(ipKey).not.toContain('203.0.113.9')
    expect(ipKey).not.toContain('@')
    expect(accountKey).not.toContain('victim@example.test')
    for (const key of [ipKey, accountKey]) {
      const segment = key.split(':').pop()!
      expect(segment).toMatch(/^[0-9a-f]{32}$/)
      // A leaked raw address would contain '.'; a leaked email would contain '@'.
      expect(segment).not.toMatch(/[.@]/)
    }
  })

  it('the limiter builds digest-only keys for a live-shaped check', async () => {
    const redis = fakeRedis()
    const limiter = RedisRateLimiter.withClient(redis)
    const pol = policy({ id: 'gw215-hygiene', subjectLimit: 5, subjectWindowMs: 60_000, subjectFrom: 'email' })
    // The gateway normalizes the subject before it reaches check().
    const subject = extractSubject(pol, { bodyEmail: 'Secret@User.test' })!
    expect(subject).toBe('secret@user.test')
    await limiter.check({ policy: pol, ip: '203.0.113.123', subject })
    const [ipKey, subjectKey] = redis.calls[0]!.keys
    expect(ipKey).not.toContain('203.0.113.123')
    expect(subjectKey).not.toContain('secret@user.test')
    expect(subjectKey).not.toContain('Secret@User.test')
    expect(ipKey).toBe(rateLimitKey('gw215-hygiene', 'ip', digestIdentity('gw215-hygiene', '203.0.113.123')))
    expect(subjectKey).toBe(rateLimitKey('gw215-hygiene', 'acct', digestIdentity('gw215-hygiene', subject)))
  })

  it('a bearer token is hashed before it can reach a key', async () => {
    const redis = fakeRedis()
    const limiter = RedisRateLimiter.withClient(redis)
    const token = 'Bearer ' + 't'.repeat(64)
    const pol = policy({ id: 'gw215-token', subjectLimit: 5, subjectFrom: 'bearer' })
    const subject = extractSubject(pol, { authorization: token })
    expect(subject).toBeTruthy()
    await limiter.check({ policy: pol, ip: '203.0.113.200', subject })
    expect(redis.calls[0]!.keys[1]).not.toContain('t'.repeat(64))
    expect(redis.calls[0]!.keys[1]).not.toContain('Bearer')
  })

  it('the proxy header surface is an explicit, closed allowlist', () => {
    const names = proxyHeaderNames()
    for (const required of ['x-forwarded-for', 'x-real-ip', 'forwarded']) {
      expect(names).toContain(required)
    }
    // Each listed header is actually honored by the evaluator (no dead entry).
    for (const name of names) {
      const verdict = evaluateRequest('203.0.113.9', new Headers({ [name]: '10.0.0.1' }), ALLOW)
      expect(verdict.reason).toBe('forged_headers')
    }
  })

  it('sanitized outbound headers never re-emit a forged address', () => {
    const source = new Headers({ 'X-Forwarded-For': '1.2.3.4', 'X-Real-IP': '5.6.7.8', 'Forwarded': 'for=5.6.7.8' })
    const out = sanitizeForwardedHeaders(source, evaluateRequest('203.0.113.9', source, ALLOW))
    expect(out.has('X-Forwarded-For')).toBe(false)
    expect(out.has('X-Real-IP')).toBe(false)
    expect(out.has('Forwarded')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// GW-215 policy surface sanity (keeps the hardened table coherent)
// ---------------------------------------------------------------------------
describe('GW-215 hardened policy surface', () => {
  it('credential routes are dual-dimension and fail closed', () => {
    for (const id of ['auth-login', 'auth-login-plain', 'auth-register', 'auth-email-code']) {
      const p = resolveRoutePolicy('/gateway/v1/secure/auth/login', 'POST')
      expect(p).toBeTruthy()
    }
    const login = resolveRoutePolicy('/gateway/v1/auth/login', 'POST')!
    expect(login.failClosed).toBe(true)
    expect(login.subjectFrom).toBe('email')
    expect(subjectDimensionEnforced(login, 'a@b.test')).toBe(true)
    expect(subjectDimensionEnforced(login, undefined)).toBe(false)
  })

  it('public reads keep an IP dimension and no subject requirement', () => {
    const plans = resolveRoutePolicy('/gateway/v1/plans')!
    expect(plans.failClosed).toBe(false)
    expect(plans.ipLimit).toBeGreaterThan(0)
    expect(plans.subjectFrom).toBeUndefined()
  })
})
