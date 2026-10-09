import { describe, expect, it, vi } from 'vitest'
import {
  ROUTE_POLICIES,
  RedisRateLimiter,
  digestIdentity,
  extractSubject,
  resolveRoutePolicy,
  retryAfterSeconds,
  type RouteRatePolicy,
  type ResolvedPolicy,
} from '../src/middleware/rate-limit.js'
import { createGatewayApp } from '../src/app.js'
import { loadConfig } from '../src/config/env.js'

const config = loadConfig({
  TXBOARD_UPSTREAM_URL: 'https://txboard.example/',
  GATEWAY_ALLOWED_ORIGINS: 'https://theme.example',
})

/** Minimal in-memory stand-in for the Redis Lua script (same reply shape). */
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

function policy(overrides: Partial<RouteRatePolicy>): ResolvedPolicy {
  const base: RouteRatePolicy = {
    id: 'test-policy', match: '/gateway/v1', ipLimit: 5, ipWindowMs: 1000,
    failClosed: false,
  }
  const merged = { ...base, ...overrides }
  return { ...merged, subjectWindow: merged.subjectWindowMs ?? merged.ipWindowMs }
}

describe('GW-202 route policy resolution', () => {
  it('longest prefix wins for overlapping routes', () => {
    expect(resolveRoutePolicy('/gateway/v1/orders')?.id).toBe('user-orders')
    expect(resolveRoutePolicy('/gateway/v1/orders/ABC123')?.id).toBe('user-orders')
    expect(resolveRoutePolicy('/gateway/v1/user/profile')?.id).toBe('user-read')
    expect(resolveRoutePolicy('/gateway/v1/secure/auth/login', 'POST')?.id).toBe('auth-login')
    // Method mismatch falls through to a broader policy, never to "unlimited".
    expect(resolveRoutePolicy('/gateway/v1/secure/auth/login', 'GET')?.id).toBe('gateway-default')
    expect(resolveRoutePolicy('/gateway/v1/auth/login', 'POST')?.id).toBe('auth-login-plain')
  })

  it('paths outside the limited surface are unlimited (healthz, 404s)', () => {
    expect(resolveRoutePolicy('/healthz')).toBeUndefined()
    expect(resolveRoutePolicy('/')).toBeUndefined()
    expect(resolveRoutePolicy('/nonexistent')).toBeUndefined()
  })

  it('every policy is method- or path-unique and has sane bounds', () => {
    for (const p of ROUTE_POLICIES) {
      expect(p.ipLimit).toBeGreaterThan(0)
      expect(p.ipWindowMs).toBeGreaterThanOrEqual(1000)
      expect(p.match.startsWith('/gateway/v1')).toBe(true)
      if (p.subjectLimit !== undefined) {
        expect(p.subjectLimit).toBeGreaterThan(0)
        expect(p.subjectFrom).toBeTruthy()
        expect((p.subjectWindowMs ?? 0)).toBeGreaterThanOrEqual(p.ipWindowMs)
      }
    }
    // Credential routes must fail closed; public reads must not.
    for (const id of ['auth-login', 'auth-login-plain', 'auth-register', 'auth-email-code']) {
      expect(ROUTE_POLICIES.find(p => p.id === id)?.failClosed).toBe(true)
    }
    expect(ROUTE_POLICIES.find(p => p.id === 'guest-read')?.failClosed).toBe(false)
  })

  it('subject quota never exceeds the IP quota for the same route class', () => {
    // An account can be attacked from many IPs; account budget must not be
    // looser than what a single IP may spend.
    for (const p of ROUTE_POLICIES) {
      if (p.subjectLimit === undefined) continue
      expect(p.subjectLimit).toBeLessThanOrEqual(p.ipLimit * 24)
    }
  })
})

describe('GW-202 helpers', () => {
  it('digestIdentity is stable, salted and non-reversible', () => {
    expect(digestIdentity('route', 'user@x.test')).toBe(digestIdentity('route', 'user@x.test'))
    expect(digestIdentity('route', 'user@x.test')).not.toBe(digestIdentity('other', 'user@x.test'))
    expect(digestIdentity('route', 'user@x.test')).toMatch(/^[0-9a-f]{32}$/)
    // Raw email must not appear anywhere in the digest space.
    expect(digestIdentity('route', 'user@x.test')).not.toContain('user@x.test')
  })

  it('retryAfterSeconds rounds up and never returns 0', () => {
    expect(retryAfterSeconds(1)).toBe(1)
    expect(retryAfterSeconds(1500)).toBe(2)
    expect(retryAfterSeconds(0)).toBe(1)
    expect(retryAfterSeconds(-5)).toBe(1)
    expect(retryAfterSeconds(Number.NaN)).toBe(1)
  })

  it('extractSubject: email routes need a bounded email; bearer routes hash the token', () => {
    const emailPolicy = policy({ subjectFrom: 'email' })
    expect(extractSubject(emailPolicy, { bodyEmail: ' A@B.test ' })).toBe('a@b.test')
    expect(extractSubject(emailPolicy, { bodyEmail: 'x'.repeat(300) })).toBeUndefined()
    expect(extractSubject(emailPolicy, {})).toBeUndefined()

    const bearerPolicy = policy({ subjectFrom: 'bearer' })
    const token = 'Bearer ' + 'a'.repeat(40)
    expect(extractSubject(bearerPolicy, { authorization: token })).toBe(token)
    expect(extractSubject(bearerPolicy, { authorization: 'Basic abc' })).toBeUndefined()
    expect(extractSubject(bearerPolicy, {})).toBeUndefined()

    expect(extractSubject(policy({}), {})).toBeUndefined()
  })
})

describe('GW-202 limiter engine', () => {
  it('passes through when the Lua reply allows the request', async () => {
    const redis = fakeRedis()
    const limiter = RedisRateLimiter.withClient(redis)
    const decision = await limiter.check({ policy: policy({}), ip: '203.0.113.7' })
    expect(decision.allowed).toBe(true)
    expect(decision.retryAfterHeader).toBe(0)
    expect(decision.degraded).toBe(false)
    expect(limiter.getStats().checks).toBe(1)
    expect(limiter.getStats().limited).toBe(0)
    // Key must be a digest, never the raw IP.
    expect(redis.calls[0]!.keys[0]).toContain(digestIdentity('test-policy', '203.0.113.7'))
    expect(redis.calls[0]!.keys[0]).not.toContain('203.0.113.7')
  })

  it('rejects with 429 + real Retry-After when the window is full', async () => {
    const redis = fakeRedis(() => [1, 12_345, 5, 5])
    const limiter = RedisRateLimiter.withClient(redis)
    const decision = await limiter.check({ policy: policy({}), ip: '198.51.100.9' })
    expect(decision.allowed).toBe(false)
    expect(decision.retryAfterMs).toBe(12_345)
    expect(decision.retryAfterHeader).toBe(13) // ceil(12.345s)
    expect(decision.ipCount).toBe(5)
    expect(limiter.getStats().limited).toBe(1)
  })

  it('fails CLOSED (503) for credential routes when Redis errors', async () => {
    const redis = fakeRedis(() => { throw new Error('ECONNREFUSED') })
    const limiter = RedisRateLimiter.withClient(redis)
    await expect(limiter.check({
      policy: policy({ id: 'auth-login', failClosed: true }), ip: '203.0.113.1',
    })).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', status: 503 })
    expect(limiter.getStats().redisFailures).toBe(1)
    expect(limiter.getStats().degraded).toBe(0)
  })

  it('fails OPEN (degraded, flagged) for public routes when Redis errors', async () => {
    const redis = fakeRedis(() => { throw new Error('timeout') })
    const limiter = RedisRateLimiter.withClient(redis)
    const decision = await limiter.check({
      policy: policy({ id: 'guest-read', failClosed: false }), ip: '203.0.113.2',
    })
    expect(decision.allowed).toBe(true)
    expect(decision.degraded).toBe(true)
    expect(limiter.getStats().degraded).toBe(1)
  })

  it('treats a malformed Lua reply as a failure, never as allowed', async () => {
    const redis = fakeRedis(() => ({ nonsense: true }))
    const limiter = RedisRateLimiter.withClient(redis)
    await expect(limiter.check({
      policy: policy({ failClosed: true }), ip: '203.0.113.3',
    })).rejects.toMatchObject({ status: 503 })
    const openRedis = fakeRedis(() => [NaN, NaN])
    const openLimiter = RedisRateLimiter.withClient(openRedis)
    const decision = await openLimiter.check({
      policy: policy({ failClosed: false }), ip: '203.0.113.3',
    })
    expect(decision.allowed).toBe(true)
    expect(decision.degraded).toBe(true)
  })

  it('omits the subject key when no subject is available (IP-only enforcement)', async () => {
    const redis = fakeRedis()
    const limiter = RedisRateLimiter.withClient(redis)
    await limiter.check({
      policy: policy({ subjectLimit: 5, subjectFrom: 'email' }), ip: '203.0.113.4',
    })
    const [ipKey, subjectKey] = redis.calls[0]!.keys
    const args = redis.calls[0]!.args
    expect(subjectKey).toBe('txbgw:v1:rl:none')
    expect(Number(args[4])).toBe(0) // subjectLimit disabled
    expect(ipKey).toContain('ip:')
  })

  it('activates the subject dimension with its own window when a subject is present', async () => {
    const redis = fakeRedis()
    const limiter = RedisRateLimiter.withClient(redis)
    await limiter.check({
      policy: policy({ subjectLimit: 3, subjectWindowMs: 900_000, subjectFrom: 'email' }),
      ip: '203.0.113.5', subject: 'victim@example.test',
    })
    const [, subjectKey] = redis.calls[0]!.keys
    const args = redis.calls[0]!.args
    expect(subjectKey).toContain(digestIdentity('test-policy', 'victim@example.test'))
    expect(subjectKey).not.toContain('victim@example.test')
    expect(Number(args[4])).toBe(3)
    expect(Number(args[5])).toBe(900_000)
  })
})

describe('GW-202 gateway middleware integration', () => {
  function gatewayWithLimiter(limiter: RedisRateLimiter, events: any[] = []) {
    return createGatewayApp(config, vi.fn(async () => Response.json({ status: 'success', data: [] })),
      undefined, {
        rateLimiter: limiter,
        onRateEvent: e => events.push(e),
      })
  }

  it('returns 429 with Retry-After header and never calls upstream', async () => {
    const limiter = RedisRateLimiter.withClient(fakeRedis(() => [1, 30_000, 60, 60]))
    const fetcher = vi.fn(async () => Response.json({ status: 'success', data: [] }))
    const app = createGatewayApp(config, fetcher as any, undefined, { rateLimiter: limiter })
    const res = await app.request('/gateway/v1/plans')
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('30')
    expect(await res.json()).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('passes allowed requests through to upstream and does not set Retry-After', async () => {
    const limiter = RedisRateLimiter.withClient(fakeRedis(() => [0, 0, 1, 1]))
    const fetcher = vi.fn(async () => Response.json({ status: 'success', data: [] }))
    const app = createGatewayApp(config, fetcher as any, undefined, { rateLimiter: limiter })
    const res = await app.request('/gateway/v1/plans')
    expect(res.status).toBe(200)
    expect(res.headers.get('Retry-After')).toBeNull()
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('does not limit /healthz or non-gateway paths', async () => {
    const limiter = RedisRateLimiter.withClient(fakeRedis(() => [1, 999, 99, 99]))
    const app = createGatewayApp(config, vi.fn(async () => Response.json({})), undefined, { rateLimiter: limiter })
    expect((await app.request('/healthz')).status).toBe(200)
    expect((await app.request('/other')).status).toBe(404)
  })

  it('credential routes return 503 (fail-closed) when Redis is down', async () => {
    const limiter = RedisRateLimiter.withClient(fakeRedis(() => { throw new Error('down') }))
    const events: any[] = []
    const app = gatewayWithLimiter(limiter, events)
    const res = await app.request('/gateway/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://theme.example' },
      body: JSON.stringify({ email: 'a@b.test', password: 'password12345' }),
    })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: { code: 'UPSTREAM_UNAVAILABLE' } })
    expect(events).toHaveLength(0) // hard failures are not "limited" events
  })

  it('reports degraded public-route traffic through the observer (for GW-205 alerts)', async () => {
    const limiter = RedisRateLimiter.withClient(fakeRedis(() => { throw new Error('flaky') }))
    const events: any[] = []
    const app = gatewayWithLimiter(limiter, events)
    const res = await app.request('/gateway/v1/plans')
    expect(res.status).toBe(200)
    expect(events).toEqual([{
      policyId: 'guest-read',
      requestId: expect.any(String),
      limited: false, degraded: true, retryAfterHeader: 0,
      ipCount: -1, subjectCount: -1,
    }])
  })

  it('login requests consume the account dimension (subject extracted from body)', async () => {
    const redis = fakeRedis(() => [0, 0, 1, 1])
    const limiter = RedisRateLimiter.withClient(redis)
    const app = createGatewayApp(config, vi.fn(async () => Response.json({
      status: 'success', data: { auth_data: 'Bearer ' + 'x'.repeat(30) },
    })) as any, undefined, { rateLimiter: limiter })
    const res = await app.request('/gateway/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://theme.example' },
      body: JSON.stringify({ email: 'Victim@Example.test', password: 'password12345' }),
    })
    expect(res.status).toBe(200)
    const [, subjectKey] = redis.calls[0]!.keys
    expect(subjectKey).toContain(digestIdentity('auth-login-plain', 'victim@example.test'))
    expect(subjectKey).not.toContain('victim@example.test')
  })
})
