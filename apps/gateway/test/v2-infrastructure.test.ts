import { describe, expect, it, vi } from 'vitest'
import { createGatewayApp } from '../src/app.js'
import { loadConfig } from '../src/config/env.js'
import { AAD_PREFIXES, CryptoService } from '../src/services/crypto.js'
import { CONTRACT_VERSION, CONTRACT_VERSION_V2, PREFIX_V2 } from '../src/middleware/request-context.js'
import {
  activeV2RouteDefinitions,
  validateV2Policies,
  v2RouteDefinitions,
} from '../src/config/policies.js'
import { v2Capabilities } from '../src/v2/capabilities.js'
import { parseScopeValue, resolveScope, scopeFromClaims, decodeBearerClaims } from '../src/v2/scope.js'
import { v2Page } from '../src/v2/dto.js'
import { keyPrefix } from '../src/services/redis-security.js'
import { encryptForOperation } from '../../../packages/theme-sdk/src/crypto.js'
import { generateKeyPairSync } from 'node:crypto'

/**
 * PR1 — v2 (`/txapi/*`) API infrastructure.
 *
 * The gates this file must hold:
 *  1. `/txapi/healthz` answers 200 with contract version `txboard-v1`.
 *  2. v1 `/gateway/v1/healthz` still answers 200 with contract version `1`,
 *     and the v1 route surface is untouched (spot checks).
 *  3. CORS preflight and Origin validation work identically on both prefixes.
 *  4. GATEWAY_ENABLE_V2=false disables every `/txapi/*` route (plain 404).
 *  5. v1 sealed ciphertext can never be opened on the v2 surface (AAD bound).
 */

const baseEnv = {
  TXBOARD_UPSTREAM_URL: 'https://txboard.example/',
  GATEWAY_ALLOWED_ORIGINS: 'https://theme.example',
}

const config = loadConfig(baseEnv)
const token = 'Bearer usertoken_longer_than_eight'

function ok(data: unknown) { return { status: 'success', message: null, data } }
function mockFetch(payload: unknown, status = 200) {
  return vi.fn(async () => Response.json(payload, { status }))
}
async function bodyOf(response: Response) { return await response.json() as any }

function fakeReplay() {
  const seen = new Set<string>()
  return { reserve: async (kid: string, nonce: string) => {
    const key = kid + ':' + nonce
    if (seen.has(key)) return false
    seen.add(key)
    return true
  } }
}

describe('v2 infrastructure — healthz on both contract surfaces', () => {
  it('answers /txapi/healthz with 200 and contract version txboard-v1', async () => {
    const fetcher = mockFetch(ok({}))
    const res = await createGatewayApp(config, fetcher).request('/txapi/healthz')
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toEqual({
      status: 'ok',
      contract: CONTRACT_VERSION_V2,
      capabilities: ['txboard.health.check'],
    })
    // Gateway-local: never touches the upstream.
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('keeps v1 /healthz answering contract version 1', async () => {
    const fetcher = mockFetch(ok({}))
    const res = await createGatewayApp(config, fetcher).request('/healthz')
    expect(res.status).toBe(200)
    expect(await bodyOf(res)).toEqual({ status: 'ok', contract: CONTRACT_VERSION })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('reports the v2 capabilities unlocked by GATEWAY_V2_FEATURES', async () => {
    const flagged = loadConfig({ ...baseEnv, GATEWAY_V2_FEATURES: 'agent,theme,unknown-flag' })
    const res = await createGatewayApp(flagged, mockFetch(ok({}))).request('/txapi/healthz')
    const capabilities = (await bodyOf(res)).capabilities
    expect(capabilities).toContain('txboard.health.check')
    expect(capabilities).toContain('txboard.agent.whoami')
    expect(capabilities).toContain('txboard.theme.manifest')
    // An unknown flag is ignored rather than crashing, and never invents a capability.
    expect(capabilities.some((c: string) => c.includes('unknown-flag'))).toBe(false)
  })
})

describe('v2 infrastructure — CORS and Origin on both prefixes', () => {
  it('answers an exact-origin preflight on /txapi and reflects only trusted origins', async () => {
    const fetcher = mockFetch(ok({}))
    const app = createGatewayApp(config, fetcher)

    const preflight = await app.request('/txapi/healthz', {
      method: 'OPTIONS',
      headers: { Origin: 'https://theme.example', 'Access-Control-Request-Method': 'GET' },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://theme.example')
    expect(preflight.headers.get('access-control-allow-methods')).toContain('GET')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects an untrusted Origin on /txapi exactly as on /gateway/v1', async () => {
    const app = createGatewayApp(config, mockFetch(ok({})))
    for (const path of ['/txapi/healthz', '/gateway/v1/plans']) {
      const denied = await app.request(path, { headers: { Origin: 'https://evil.example' } })
      expect(denied.status).toBe(403)
      expect(denied.headers.has('access-control-allow-origin')).toBe(false)
      expect((await bodyOf(denied)).error.code).toBe('ORIGIN_DENIED')
    }
  })

  it('allows an exact-origin request on /txapi', async () => {
    const res = await createGatewayApp(config, mockFetch(ok({})))
      .request('/txapi/healthz', { headers: { Origin: 'https://theme.example' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://theme.example')
    expect(res.headers.get('vary')).toContain('Origin')
  })
})

describe('v2 infrastructure — v1 regression', () => {
  it('still serves /gateway/v1/bootstrap with contract version 1', async () => {
    const fetcher = mockFetch(ok({ app_name: 'TXBoard Site' }))
    const res = await createGatewayApp(config, fetcher).request('/gateway/v1/bootstrap', {
      headers: { Origin: 'https://theme.example' },
    })
    expect(res.status).toBe(200)
    const payload = await bodyOf(res)
    expect(payload.ok).toBe(true)
    expect(payload.meta.version).toBe(CONTRACT_VERSION)
    expect(payload.meta.requestId).toBeTruthy()
    expect(payload.data.site.name).toBe('TXBoard Site')
  })

  it('keeps the v1 bearer surface enforcing credentials before upstream', async () => {
    const fetcher = mockFetch(ok({ email: 'alice@example.test' }))
    const app = createGatewayApp(config, fetcher)
    expect((await app.request('/gateway/v1/user/profile')).status).toBe(401)
    const res = await app.request('/gateway/v1/user/profile', { headers: { Authorization: token } })
    expect(res.status).toBe(200)
    expect((await bodyOf(res)).data.email).toBe('alice@example.test')
  })
})

describe('v2 infrastructure — GATEWAY_ENABLE_V2=false', () => {
  it('disables every /txapi route when the flag is false', async () => {
    const disabled = loadConfig({ ...baseEnv, GATEWAY_ENABLE_V2: 'false' })
    expect(disabled.enableV2).toBe(false)
    const fetcher = mockFetch(ok([{ id: 1, name: 'Monthly' }]))
    const app = createGatewayApp(disabled, fetcher)
    const res = await app.request('/txapi/healthz')
    expect(res.status).toBe(404)
    expect((await bodyOf(res)).error.code).toBe('NOT_FOUND')
    // ...while v1 keeps working on the same app instance.
    expect((await app.request('/healthz')).status).toBe(200)
    expect((await app.request('/gateway/v1/plans')).status).toBe(200)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('defaults the flag to true and rejects an unparseable value', () => {
    expect(loadConfig(baseEnv).enableV2).toBe(true)
    expect(() => loadConfig({ ...baseEnv, GATEWAY_ENABLE_V2: 'yes' })).toThrow()
    expect(loadConfig({ ...baseEnv, GATEWAY_ENABLE_V2: 'true ' }).enableV2).toBe(true)
    expect(loadConfig({ ...baseEnv, GATEWAY_ENABLE_V2: ' FALSE ' }).enableV2).toBe(false)
    expect(() => loadConfig({ ...baseEnv, GATEWAY_V2_FEATURES: 'agent,agent' })).toThrow()
    expect(() => loadConfig({ ...baseEnv, GATEWAY_V2_FEATURES: 'bad flag!' })).toThrow()
  })

  it('registers no /txapi route at all when v2 is disabled', () => {
    const app = createGatewayApp(loadConfig({ ...baseEnv, GATEWAY_ENABLE_V2: 'false' }), mockFetch(ok({})))
    // The CORS middleware still mounts on the prefix (so an Origin check
    // behaves identically either way), but NO handler route is registered.
    expect(app.routes.filter(route => route.method !== 'ALL' && route.path.startsWith('/txapi')))
      .toEqual([])
    const enabled = createGatewayApp(config, mockFetch(ok({})))
    expect(enabled.routes.filter(route => route.method !== 'ALL' && route.path.startsWith('/txapi'))
      .map(route => `${route.method} ${route.path}`)).toEqual(['GET /txapi/healthz'])
  })
})

describe('v2 infrastructure — policy table', () => {
  it('declares GET /txapi/healthz as publicRead with no upstream operation', () => {
    expect(v2RouteDefinitions).toHaveLength(1)
    const [definition] = v2RouteDefinitions
    expect(definition).toEqual({
      method: 'GET', path: `${PREFIX_V2}/healthz`, policy: {
        name: 'publicRead', auth: 'none', body: 'none', limiter: 'public', cache: 'public-short',
      },
    })
    expect(() => validateV2Policies()).not.toThrow()
    expect(activeV2RouteDefinitions()).toEqual(v2RouteDefinitions)
  })

  it('keeps the v1 table untouched by the v2 addition', () => {
    // The v1 snapshot tests pin these; a v2 entry leaking into the v1 table
    // (or vice versa) would change the v1 contract.
    expect(v2RouteDefinitions.every(d => d.path.startsWith('/txapi/'))).toBe(true)
  })
})

describe('v2 infrastructure — scope resolution', () => {
  it('parses user and agent scopes and rejects everything else', () => {
    expect(parseScopeValue('user')).toEqual({ kind: 'user' })
    expect(parseScopeValue('agent:node-1')).toEqual({ kind: 'agent', agentId: 'node-1' })
    for (const bad of ['', 'machine', 'agent', 'agent:', 'admin', 'user extra', 'agent:bad/id']) {
      expect(parseScopeValue(bad).kind).toBe('unknown')
    }
  })

  it('reads the scope claim from a bearer payload, shape only', () => {
    const payload = Buffer.from(JSON.stringify({ scope: 'agent:node-9', sub: 'u1' })).toString('base64url')
    const bearer = `Bearer aaa.${payload}.sig`
    expect(scopeFromClaims(decodeBearerClaims(bearer))).toEqual({ kind: 'agent', agentId: 'node-9' })
    expect(decodeBearerClaims('Bearer onlyone')).toEqual({})
    expect(decodeBearerClaims('not-a-bearer')).toEqual({})
    expect(decodeBearerClaims(undefined)).toEqual({})
  })

  it('prefers an explicit scope header over the token claim', () => {
    const headers = { header: (name: string) => (name.toLowerCase() === 'x-txboard-scope' ? 'user' : undefined) }
    expect(resolveScope(headers, `Bearer aaa.${Buffer.from('{"scope":"agent:x"}').toString('base64url')}.s`))
      .toEqual({ kind: 'user' })
    const noHeader = { header: () => undefined }
    expect(resolveScope(noHeader, 'Bearer no-scope-here').kind).toBe('unknown')
  })
})

describe('v2 infrastructure — DTO layer', () => {
  it('builds the v2 pagination body and rejects out-of-range values', () => {
    expect(v2Page(['a', 'b'], 42, 2, 10)).toEqual({
      items: ['a', 'b'], total: 42, current: 2, pageSize: 10,
    })
    expect(() => v2Page([], 0, 0, 10)).toThrow('PAGINATION_INVALID')
    expect(() => v2Page([], 0, 1, 0)).toThrow('PAGINATION_INVALID')
    expect(() => v2Page([], 0, 1, 101)).toThrow('PAGINATION_INVALID')
    expect(() => v2Page([], -1, 1, 10)).toThrow('PAGINATION_INVALID')
  })
})

describe('v2 infrastructure — key spaces and AAD binding', () => {
  it('separates the Redis key spaces per contract surface', () => {
    expect(keyPrefix('v1')).toBe('txbgw:v1')
    expect(keyPrefix('v2')).toBe('txbgw:v2')
  })

  it('binds HPKE AAD to the surface so v1 ciphertext never opens on v2', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const crypto = await CryptoService.create(privateKey.export({ format: 'jwk' }), fakeReplay(), true)
    const discovery = crypto.publicKey()
    const sealed = await encryptForOperation(
      { ...discovery, suite: 'DHKEM(P-256,HKDF-SHA256)+HKDF-SHA256+AES-256-GCM' },
      { email: 'u@example.test', password: 'pass12345' },
      'login',
    )
    // v1 surface: opens.
    await expect(crypto.open(sealed, 'login', 'v1')).resolves.toEqual({
      email: 'u@example.test', password: 'pass12345',
    })
    // Same envelope on the v2 surface: the AAD differs, so it must fail closed.
    await expect(crypto.open(sealed, 'login', 'v2')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(AAD_PREFIXES.v1).not.toBe(AAD_PREFIXES.v2)
  })
})

describe('v2 infrastructure — capabilities', () => {
  it('always publishes the health capability and never duplicates', () => {
    expect(v2Capabilities([])).toEqual(['txboard.health.check'])
    expect(v2Capabilities(['AGENT'])).toEqual(['txboard.health.check', 'txboard.agent.whoami', 'txboard.agent.fleet.health'])
    expect(v2Capabilities(['agent', 'agent'])).toEqual(v2Capabilities(['agent']))
  })
})
