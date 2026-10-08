import { describe, expect, it, vi } from 'vitest'
import { createGatewayApp } from '../src/app.js'
import { loadConfig } from '../src/env.js'

const config = loadConfig({
  TXBOARD_UPSTREAM_URL: 'https://txboard.example/',
  GATEWAY_ALLOWED_ORIGINS: 'https://theme.example',
})
function mockFetch(payload: unknown, status = 200) {
  return vi.fn(async () => Response.json(payload, { status }))
}
function ok(data: unknown) { return { status: 'success', message: null, data } }
async function dataOf(response: Response) { return await response.json() as any }
const token = 'Bearer usertoken_longer_than_eight'

describe('gateway security and TXBoard v1 adapters', () => {
  it('has a minimal local health endpoint with no upstream secrets', async () => {
    const fetcher = mockFetch(ok({}))
    const res = await createGatewayApp(config, fetcher).request('/healthz')
    expect(res.status).toBe(200)
    expect(await dataOf(res)).toEqual({ status: 'ok', contract: '1' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('normalizes public bootstrap, filters unknown config fields and never sends tokens', async () => {
    const fetcher = mockFetch(ok({
      app_name: 'TXBoard Site',
      logo: 'https://cdn.example/logo.svg',
      frontend_theme: 'Nova',
      theme_config: { theme_color: 'blue' },
      secure_path: 'must-not-leak',
      turnstile_secret_key: 'never',
    }))
    const app = createGatewayApp(config, fetcher)
    const res = await app.request('/gateway/v1/bootstrap', {
      headers: { Origin: 'https://theme.example', Authorization: token },
    })
    const json = await dataOf(res)
    expect(json.ok).toBe(true)
    expect(json.meta.version).toBe('1')
    expect(json.meta.requestId).toBeTruthy()
    expect(json.data).toEqual({
      site: { name: 'TXBoard Site', description: '', url: '', logo: 'https://cdn.example/logo.svg' },
      theme: { name: 'Nova', config: { theme_color: 'blue' } },
      capabilities: ['auth.login', 'user.profile', 'plans.list', 'orders.list', 'theme.config'],
    })
    expect(res.headers.get('access-control-allow-origin')).toBe('https://theme.example')
    expect((fetcher.mock.calls[0] as any)[0]).toBe('https://txboard.example/api/v1/guest/comm/config')
    expect((fetcher.mock.calls[0] as any)[1].headers.has('Authorization')).toBe(false)
  })

  it('exposes only current theme configuration through public endpoint', async () => {
    const fetcher = mockFetch(ok({ frontend_theme: 'TXBoard', theme_config: { background_url: 'https://cdn.example/x.png' } }))
    const res = await createGatewayApp(config, fetcher).request('/gateway/v1/theme/config')
    expect((await dataOf(res)).data).toEqual({ name: 'TXBoard', config: { background_url: 'https://cdn.example/x.png' } })
  })

  it('keeps plan prices as upstream cents and never unwraps arbitrary data structures', async () => {
    const fetcher = mockFetch(ok([{ id: 1, name: 'Monthly', month_price: 1200 }]))
    const res = await createGatewayApp(config, fetcher).request('/gateway/v1/plans')
    expect((await dataOf(res)).data).toEqual([{ id: 1, name: 'Monthly', month_price: 1200 }])
    expect((fetcher.mock.calls[0] as any)[0]).toContain('/api/v1/guest/plan/fetch')
  })

  it('translates login and allowed CAPTCHA fields without sending an admin token', async () => {
    const fetcher = mockFetch(ok({ auth_data: token, is_admin: false }))
    const res = await createGatewayApp(config, fetcher).request('/gateway/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.test', password: 'pass12345678', turnstile_token: 'captcha-token' }),
    })
    expect((await dataOf(res)).data.auth_data).toBe(token)
    const [url, init] = fetcher.mock.calls[0] as any[]
    expect(url).toContain('/api/v1/passport/auth/login')
    expect(init.headers.has('Authorization')).toBe(false)
    expect(JSON.parse(init.body)).toEqual({ email: 'user@example.test', password: 'pass12345678', turnstile_token: 'captcha-token' })
  })

  it('blocks unknown login properties and invalid JSON before reaching upstream', async () => {
    const fetcher = mockFetch(ok({}))
    const app = createGatewayApp(config, fetcher)
    const invalid = await app.request('/gateway/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.test', password: 'pass12345678', is_admin: true }),
    })
    expect(invalid.status).toBe(400)
    expect((await dataOf(invalid)).error.code).toBe('VALIDATION_ERROR')
    const badJson = await app.request('/gateway/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad',
    })
    expect(badJson.status).toBe(400)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('blocks oversized login payloads', async () => {
    const fetcher = mockFetch(ok({}))
    const smallConfig = { ...config, maxRequestBytes: 24 }
    const res = await createGatewayApp(smallConfig, fetcher).request('/gateway/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'user@example.test', password: 'pass12345678' }),
    })
    expect(res.status).toBe(413)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('requires user bearer and forwards it only to known protected endpoints', async () => {
    const fetcher = mockFetch(ok({ email: 'alice@example.test' }))
    const app = createGatewayApp(config, fetcher)
    expect((await app.request('/gateway/v1/user/profile')).status).toBe(401)
    expect(fetcher).not.toHaveBeenCalled()
    const res = await app.request('/gateway/v1/user/profile', { headers: { Authorization: token } })
    expect(res.status).toBe(200)
    expect((await dataOf(res)).data.email).toBe('alice@example.test')
    const [url, init] = fetcher.mock.calls[0] as any[]
    expect(url).toBe('https://txboard.example/api/v1/user/info')
    expect(init.headers.get('Authorization')).toBe(token)
  })

  it('passes only validated order status and rejects arbitrary query parameters', async () => {
    const fetcher = mockFetch(ok([{ trade_no: 'abc', status: 0 }]))
    const app = createGatewayApp(config, fetcher)
    const res = await app.request('/gateway/v1/orders?status=0', { headers: { Authorization: token } })
    expect((await dataOf(res)).data[0].trade_no).toBe('abc')
    expect((fetcher.mock.calls[0] as any)[0]).toBe('https://txboard.example/api/v1/user/order/fetch?status=0')
    expect((await app.request('/gateway/v1/orders?status=4', { headers: { Authorization: token } })).status).toBe(400)
    expect((await app.request('/gateway/v1/orders?admin_path=secret', { headers: { Authorization: token } })).status).toBe(400)
    expect((await app.request('/gateway/v1/orders?status=0&status=1', { headers: { Authorization: token } })).status).toBe(400)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('blocks other routes, admin routes and order writes rather than proxying them', async () => {
    const fetcher = mockFetch(ok([]))
    const app = createGatewayApp(config, fetcher)
    expect((await app.request('/gateway/v1/api/v2/secret/config/fetch')).status).toBe(404)
    expect((await app.request('/api/v2/secret/config/fetch')).status).toBe(404)
    expect((await app.request('/gateway/v1/orders', { method: 'POST', headers: { Authorization: token } })).status).toBe(405)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects untrusted browser origins and allows only exact-origin preflight', async () => {
    const fetcher = mockFetch(ok([]))
    const app = createGatewayApp(config, fetcher)
    const rejected = await app.request('/gateway/v1/plans', { headers: { Origin: 'https://evil.example' } })
    expect(rejected.status).toBe(403)
    expect(rejected.headers.has('access-control-allow-origin')).toBe(false)
    const preflight = await app.request('/gateway/v1/auth/login', {
      method: 'OPTIONS', headers: { Origin: 'https://theme.example', 'Access-Control-Request-Method': 'POST' },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://theme.example')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('never auto-follows upstream redirect (prevents bearer forwarding elsewhere)', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://attacker.example/token' } }))
    const res = await createGatewayApp(config, fetcher).request('/gateway/v1/user/profile', { headers: { Authorization: token } })
    expect(res.status).toBe(502)
    expect((fetcher.mock.calls[0] as any)[1].redirect).toBe('manual')
  })

  it('converts app-level and HTTP upstream errors rather than treating them as success', async () => {
    const fetcher = mockFetch({ status: 'fail', message: 'Invalid credentials', data: null })
    const res = await createGatewayApp(config, fetcher).request('/gateway/v1/plans')
    expect(res.status).toBe(400)
    const payload = await dataOf(res)
    expect(payload.ok).toBe(false)
    expect(payload.error.message).toBe('Invalid credentials')
  })

  it('returns a stable unavailable code when the upstream connection fails', async () => {
    const fetcher = vi.fn(async () => { throw new Error('network address with secrets') })
    const res = await createGatewayApp(config, fetcher).request('/gateway/v1/plans')
    expect(res.status).toBe(502)
    expect((await dataOf(res)).error).toEqual({ code: 'UPSTREAM_UNAVAILABLE', message: 'Upstream connection failed' })
  })

  it('rejects unbounded responses even without Content-Length', async () => {
    const fetcher = mockFetch(ok({ text: 'x'.repeat(2000) }))
    const res = await createGatewayApp({ ...config, maxResponseBytes: 500 }, fetcher).request('/gateway/v1/plans')
    expect([413, 502]).toContain(res.status)
    expect((await dataOf(res)).ok).toBe(false)
  })
})
