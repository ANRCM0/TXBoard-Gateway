import { describe, expect, it, vi } from 'vitest'
import { createGatewayApp } from '../src/app.js'
import { loadConfig } from '../src/config/env.js'
import { CryptoService } from '../src/services/crypto.js'
import {
  POLICY_DEFINITIONS,
  ROUTE_OPERATIONS,
  activeRouteDefinitions,
  routeDefinitions,
  validatePolicies,
  type PolicyName,
  type RouteDefinition,
} from '../src/config/policies.js'
import {
  buildPolicyIndex,
  resolvePolicy,
} from '../src/middleware/policy.js'
import { generateKeyPairSync } from 'node:crypto'

/**
 * GW-212 / PR-B: the declarative compile-time route policy table.
 *
 * These tests pin the security posture of every route as data, prove the
 * invariant between the routes the app actually registers and the policies the
 * table declares, and verify that the illegal combinations named in
 * docs/middleware-architecture.md §3 are rejected at boot rather than at
 * request time.
 */

const config = loadConfig({
  TXBOARD_UPSTREAM_URL: 'https://txboard.example/',
  GATEWAY_ALLOWED_ORIGINS: 'https://theme.example',
})

const token = 'Bearer usertoken_longer_than_eight'

function ok(data: unknown) { return { status: 'success', message: null, data } }

function mockFetch(payload: unknown, status = 200) {
  return vi.fn(async () => Response.json(payload, { status }))
}

function fakeReplay() {
  const seen = new Set<string>()
  return {
    reserve: async (kid: string, nonce: string) => {
      const key = kid + ':' + nonce
      if (seen.has(key)) return false
      seen.add(key)
      return true
    },
  }
}

async function hpkeService(accountWorkflows = false) {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return CryptoService.create(privateKey.export({ format: 'jwk' }), fakeReplay(), accountWorkflows)
}

/** Every route the running app actually registers, as `METHOD /path` keys. */
function registeredRoutes(app: ReturnType<typeof createGatewayApp>): string[] {
  return app.routes
    .filter(route => route.method !== 'ALL')
    .map(route => `${route.method} ${route.path}`)
}

const EXPECTED_MAPPING: Record<string, PolicyName> = {
  'GET /gateway/v1/bootstrap': 'publicRead',
  'GET /gateway/v1/theme/config': 'publicRead',
  'GET /gateway/v1/plans': 'publicRead',
  'GET /gateway/v1/crypto/key': 'publicRead',
  'POST /gateway/v1/auth/login': 'login',
  'POST /gateway/v1/secure/auth/login': 'secureLogin',
  'POST /gateway/v1/secure/auth/register': 'secureRegister',
  'POST /gateway/v1/secure/auth/email-code': 'secureEmailCode',
  'GET /gateway/v1/user/profile': 'userRead',
  'GET /gateway/v1/user/subscription/summary': 'userRead',
  'GET /gateway/v1/notices': 'userRead',
  'GET /gateway/v1/dashboard/stats': 'userRead',
  'GET /gateway/v1/orders': 'userRead',
  'GET /gateway/v1/orders/:tradeNo': 'userRead',
  'GET /gateway/v1/orders/:tradeNo/status': 'userRead',
  'GET /gateway/v1/payments': 'userRead',
  'POST /gateway/v1/orders': 'disabledWrite',
}

describe('GW-212 route policy table', () => {
  it('pins the full method + path -> policy mapping as a snapshot', () => {
    const snapshot = Object.fromEntries(
      routeDefinitions.map(definition => [
        `${definition.method} ${definition.path}`,
        definition.policy.name,
      ]),
    )
    expect(snapshot).toEqual(EXPECTED_MAPPING)
    // Snapshot the policy bodies too: a silent posture change in auth, body,
    // limiter or cache must fail this test rather than ship.
    expect(routeDefinitions.map(d => ({ ...d.policy }))).toEqual([
      { name: 'publicRead', auth: 'none', body: 'none', limiter: 'public', cache: 'public-short' },
      { name: 'publicRead', auth: 'none', body: 'none', limiter: 'public', cache: 'public-short' },
      { name: 'publicRead', auth: 'none', body: 'none', limiter: 'public', cache: 'public-short' },
      { name: 'publicRead', auth: 'none', body: 'none', limiter: 'public', cache: 'public-short' },
      { name: 'login', auth: 'none', body: 'json', limiter: 'login', cache: 'off' },
      { name: 'secureLogin', auth: 'none', body: 'hpke', limiter: 'login', cache: 'off' },
      { name: 'secureRegister', auth: 'none', body: 'hpke', limiter: 'register', cache: 'off' },
      { name: 'secureEmailCode', auth: 'none', body: 'hpke', limiter: 'email-code', cache: 'off' },
      { name: 'userRead', auth: 'bearer', body: 'none', limiter: 'public', cache: 'off' },
      { name: 'userRead', auth: 'bearer', body: 'none', limiter: 'public', cache: 'off' },
      { name: 'userRead', auth: 'bearer', body: 'none', limiter: 'public', cache: 'off' },
      { name: 'userRead', auth: 'bearer', body: 'none', limiter: 'public', cache: 'off' },
      { name: 'userRead', auth: 'bearer', body: 'none', limiter: 'public', cache: 'off' },
      { name: 'userRead', auth: 'bearer', body: 'none', limiter: 'public', cache: 'off' },
      { name: 'userRead', auth: 'bearer', body: 'none', limiter: 'public', cache: 'off' },
      { name: 'userRead', auth: 'bearer', body: 'none', limiter: 'public', cache: 'off' },
      { name: 'disabledWrite', auth: 'none', body: 'none', limiter: 'none', cache: 'off' },
    ])
  })

  it('keeps every route in the app.ts inventory covered by the table', () => {
    const declared = new Set(
      routeDefinitions.map(d => `${d.method} ${d.path}`),
    )
    for (const key of Object.keys(EXPECTED_MAPPING)) {
      expect(declared, `inventory route ${key} has no policy definition`).toContain(key)
    }
  })

  it('has no orphan definitions: every policy maps to a route the app registers', async () => {
    // /healthz is the operator probe, registered at the root and deliberately
    // outside the /gateway/v1 policy surface, so it is not part of the table.
    const gatewayRoutes = (app: ReturnType<typeof createGatewayApp>) =>
      registeredRoutes(app).filter(k => k.startsWith('GET /gateway/')
        || k.startsWith('POST /gateway/'))
    const plainApp = createGatewayApp(config, mockFetch(ok({})))
    const plainRoutes = new Set(gatewayRoutes(plainApp))
    const plainDeclared = new Set(
      activeRouteDefinitions({}).map(d => `${d.method} ${d.path}`),
    )
    // Nothing the table declares is missing from the app, and nothing the app
    // registers is missing from the table: no orphans in either direction.
    expect([...plainDeclared].filter(k => !plainRoutes.has(k))).toEqual([])
    expect([...plainRoutes].filter(k => !plainDeclared.has(k))).toEqual([])

    // HPKE on: /gateway/v1/crypto/key and /gateway/v1/secure/auth/login join.
    const crypto = await hpkeService()
    const hpkeApp = createGatewayApp(config, mockFetch(ok({})), crypto)
    const hpkeRoutes = new Set(gatewayRoutes(hpkeApp))
    const hpkeDeclared = new Set(
      activeRouteDefinitions({ hpke: true, replayStore: true }).map(
        d => `${d.method} ${d.path}`,
      ),
    )
    expect([...hpkeDeclared].filter(k => !hpkeRoutes.has(k))).toEqual([])
    expect([...hpkeRoutes].filter(k => !hpkeDeclared.has(k))).toEqual([])

    // Account workflows on: register + email-code join, and only then.
    const workflows = await hpkeService(true)
    const limiter = { check: vi.fn(async () => {}) }
    const fullApp = createGatewayApp(config, mockFetch(ok({})), workflows, {
      accountWorkflows: true,
      limiter,
    })
    const fullRoutes = new Set(gatewayRoutes(fullApp))
    const fullDeclared = new Set(
      activeRouteDefinitions({
        hpke: true, redis: true, accountWorkflows: true, replayStore: true,
      }).map(d => `${d.method} ${d.path}`),
    )
    expect([...fullDeclared].filter(k => !fullRoutes.has(k))).toEqual([])
    expect([...fullRoutes].filter(k => !fullDeclared.has(k))).toEqual([])
    expect(fullRoutes).toContain('POST /gateway/v1/secure/auth/register')
    expect(fullRoutes).toContain('POST /gateway/v1/secure/auth/email-code')
  })

  it('resolves the policy of a concrete request path with longest-prefix + method matching', () => {
    const index = buildPolicyIndex(routeDefinitions)
    // Method-specific entries win over method-agnostic ones, and a longer
    // path wins over a shorter prefix of it.
    expect(resolvePolicy('/gateway/v1/orders', 'GET', index)?.policy.name).toBe('userRead')
    expect(resolvePolicy('/gateway/v1/orders', 'POST', index)?.policy.name).toBe('disabledWrite')
    expect(resolvePolicy('/gateway/v1/orders/T123', 'GET', index)?.policy.name).toBe('userRead')
    expect(resolvePolicy('/gateway/v1/orders/T123/status', 'GET', index)?.policy.name).toBe('userRead')
    expect(resolvePolicy('/gateway/v1/plans', 'GET', index)?.policy.name).toBe('publicRead')
    expect(resolvePolicy('/gateway/v1/auth/login', 'POST', index)?.policy.name).toBe('login')
    // A path that is only a string-prefix of a route must not match it.
    expect(resolvePolicy('/gateway/v1/ordersX', 'GET', index)).toBeUndefined()
    // An unlisted method on a listed path is never implicitly permissive.
    expect(resolvePolicy('/gateway/v1/plans', 'DELETE', index)).toBeUndefined()
    expect(resolvePolicy('/gateway/v1/unknown', 'GET', index)).toBeUndefined()
  })
})

describe('GW-212 illegal policy combinations are rejected', () => {
  it('rejects body: hpke without a replay store', () => {
    // secureLogin is live as soon as HPKE is wired, so it is held to the
    // replay-store rule.
    const live = routeDefinitions.filter(d => d.policy.name !== 'secureRegister'
      && d.policy.name !== 'secureEmailCode')
    expect(() => validatePolicies(live, { hpke: true })).toThrow(/replay store/)
    // With a store the same table validates.
    expect(() => validatePolicies(live, { hpke: true, replayStore: true })).not.toThrow()
  })

  it('rejects userRead combined with a shared public cache', () => {
    const cacheableUserRead = routeDefinitions.map(d => d.policy.name === 'userRead'
      ? { ...d, policy: { ...POLICY_DEFINITIONS.userRead, cache: 'public-short' as const } }
      : d)
    expect(() => validatePolicies(cacheableUserRead, {})).toThrow(/userRead/)
  })

  it('rejects disabledWrite paired with an upstream write operation', () => {
    const writeBanBypassed = routeDefinitions.map(d => d.policy.name === 'disabledWrite'
      ? { ...d, policy: { ...POLICY_DEFINITIONS.login, name: 'disabledWrite' as const } }
      : d)
    // The tampered definition is non-canonical, which is itself rejected.
    expect(() => validatePolicies(writeBanBypassed, {})).toThrow(/disabledWrite/)
    // And a canonical disabledWrite entry that maps to a write operation is
    // rejected by the upstream-operation rule.
    const operations = { ...ROUTE_OPERATIONS, 'POST /gateway/v1/orders': ['login'] }
    expect(() => validatePolicies(routeDefinitions, {}, operations)).toThrow(
      /upstream write operation/,
    )
  })

  it('rejects a secure* policy that a partial configuration would unlock', () => {
    const workflows = routeDefinitions.filter(
      d => d.policy.name === 'secureRegister' || d.policy.name === 'secureEmailCode',
    )
    // A partial configuration makes the routes live, which is exactly what
    // must be refused: HPKE alone, Redis alone, or the flag alone.
    for (const partial of [
      { hpke: true, replayStore: true },
      { redis: true, replayStore: true },
      { accountWorkflows: true },
    ]) {
      expect(() => validatePolicies(workflows, partial)).toThrow(/HPKE/)
    }
    // All three together is the only acceptable combination.
    expect(() => validatePolicies(workflows, {
      hpke: true, replayStore: true, redis: true, accountWorkflows: true,
    })).not.toThrow()
  })

  it('fails the boot closed on a malformed or duplicated table', () => {
    const offPrefix: RouteDefinition[] = [
      { method: 'GET', path: '/api/v1/plans', policy: POLICY_DEFINITIONS.publicRead },
    ]
    expect(() => validatePolicies(offPrefix, {})).toThrow(/outside/)
    expect(() => validatePolicies([
      routeDefinitions[0]!,
      routeDefinitions[0]!,
    ], {})).toThrow(/Duplicate/)
    expect(() => validatePolicies([
      { method: 'GET', path: '/gateway/v1/x', policy: 'nope' as never },
    ], {})).toThrow(/unknown policy/)
  })
})

describe('GW-212 enforcement rejects unknown and banned routes without upstream calls', () => {
  it('answers 404 for an unknown path and an unlisted method with zero upstream calls', async () => {
    const fetcher = mockFetch(ok({}))
    const app = createGatewayApp(config, fetcher)

    const unknownPath = await app.request('/gateway/v1/api/v2/secret/config/fetch')
    expect(unknownPath.status).toBe(404)
    const outsidePrefix = await app.request('/api/v2/secret/config/fetch')
    expect(outsidePrefix.status).toBe(404)
    // An unlisted method on a listed path never falls through to upstream.
    const unlistedMethod = await app.request('/gateway/v1/plans', { method: 'DELETE' })
    expect([404, 405]).toContain(unlistedMethod.status)
    const putOnLogin = await app.request('/gateway/v1/auth/login', { method: 'PUT' })
    expect([404, 405]).toContain(putOnLogin.status)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('performs zero upstream calls for POST /gateway/v1/orders (disabledWrite)', async () => {
    const fetcher = mockFetch(ok({}))
    const app = createGatewayApp(config, fetcher)
    for (const body of [null, JSON.stringify({ plan_id: 1, email: 'x@example.test' })]) {
      const res = await app.request('/gateway/v1/orders', {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ?? undefined,
      })
      expect(res.status).toBe(405)
      expect((await res.json() as { error: { code: string } }).error.code)
        .toBe('METHOD_NOT_ALLOWED')
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('returns 401 for a bearer route without Authorization, before any upstream call', async () => {
    const fetcher = mockFetch(ok({ email: 'alice@example.test' }))
    const app = createGatewayApp(config, fetcher)
    for (const path of [
      '/gateway/v1/user/profile',
      '/gateway/v1/user/subscription/summary',
      '/gateway/v1/notices',
      '/gateway/v1/dashboard/stats',
      '/gateway/v1/orders',
      '/gateway/v1/orders/T123',
      '/gateway/v1/orders/T123/status',
      '/gateway/v1/payments',
    ]) {
      const missing = await app.request(path)
      expect(missing.status, `${path} without Authorization`).toBe(401)
      expect((await missing.json() as { error: { code: string } }).error.code)
        .toBe('UNAUTHORIZED')
      const malformed = await app.request(path, { headers: { Authorization: 'Basic abc' } })
      expect(malformed.status, `${path} with a malformed token`).toBe(401)
    }
    // The bearer shape check happens before the handler, so a request that
    // would otherwise hit the upstream is rejected with zero calls.
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('still answers CORS preflight before the policy layer touches the body', async () => {
    const fetcher = mockFetch(ok({}))
    const app = createGatewayApp(config, fetcher)
    // The CORS layer runs before the policy layer, so a bodyless OPTIONS
    // request on a json-body route is a 204, never a body-validation error.
    const preflight = await app.request('/gateway/v1/auth/login', {
      method: 'OPTIONS',
      headers: { Origin: 'https://theme.example', 'Access-Control-Request-Method': 'POST' },
    })
    expect(preflight.status).toBe(204)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('requires a sealed envelope on an hpke route before any upstream call', async () => {
    const crypto = await hpkeService()
    const fetcher = mockFetch(ok({ auth_data: token }))
    const app = createGatewayApp(config, fetcher, crypto)

    const notJson = await app.request('/gateway/v1/secure/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'nope',
    })
    expect(notJson.status).toBe(400)
    const unsealed = await app.request('/gateway/v1/secure/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.test', password: 'pass12345678' }),
    })
    expect(unsealed.status).toBe(400)
    const partialSeal = await app.request('/gateway/v1/secure/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kid: 'aaaaaaaaaaaaaaaaaaaaaaaa', ct: 'x' }),
    })
    expect(partialSeal.status).toBe(400)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('keeps secureRegister and secureEmailCode absent unless HPKE + Redis + the flag are all present', async () => {
    const fetcher = mockFetch(ok({ auth_data: token }))
    const limiter = { check: vi.fn(async () => {}) }
    const sealedBody = {
      kid: 'aaaaaaaaaaaaaaaaaaaaaaaa', ts: Date.now(), nonce: 'n',
      enc: 'e', ct: 'c',
    }
    const send = (app: ReturnType<typeof createGatewayApp>, operation: string) =>
      app.request(`/gateway/v1/secure/auth/${operation}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sealedBody),
      })

    // Nothing enabled.
    const bare = createGatewayApp(config, fetcher)
    expect((await send(bare, 'register')).status).toBe(404)
    expect((await send(bare, 'email-code')).status).toBe(404)
    expect(fetcher).not.toHaveBeenCalled()

    // HPKE only: still absent, and the app still boots.
    const crypto = await hpkeService()
    const hpkeOnly = createGatewayApp(config, fetcher, crypto)
    expect((await send(hpkeOnly, 'register')).status).toBe(404)
    expect((await send(hpkeOnly, 'email-code')).status).toBe(404)

    // HPKE + Redis but no feature flag: still absent.
    const noFlag = createGatewayApp(config, fetcher, crypto, { limiter })
    expect((await send(noFlag, 'register')).status).toBe(404)
    expect((await send(noFlag, 'email-code')).status).toBe(404)

    // HPKE + Redis + flag: present and enforced.
    const workflows = await hpkeService(true)
    const enabled = createGatewayApp(config, fetcher, workflows, {
      accountWorkflows: true, limiter,
    })
    expect((await send(enabled, 'register')).status).toBe(400)
    expect((await send(enabled, 'email-code')).status).toBe(400)
    expect(fetcher).not.toHaveBeenCalled()

    // The flag alone can never unlock them.
    expect(() => createGatewayApp(config, fetcher, undefined, { accountWorkflows: true }))
      .toThrow()
  })
})
