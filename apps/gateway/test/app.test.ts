import { describe, expect, it, vi } from 'vitest'
import { createGatewayApp } from '../src/app.js'
import { loadConfig } from '../src/env.js'
import { CryptoService, loadCryptoService } from '../src/crypto.js'
import { generateKeyPairSync } from 'node:crypto'
import { encryptLoginPayload, encryptForOperation } from '../../../packages/theme-sdk/src/crypto.js'

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
function fakeReplay() {
  const seen = new Set<string>()
  return { reserve: async (kid: string, nonce: string) => {
    const key = kid + ':' + nonce
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }}
}

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
      security: { captcha: { enabled: false, type: null, siteKey: null } },
      capabilities: [
        'auth.login', 'user.profile', 'plans.list', 'orders.list', 'theme.config',
        'user.subscription.summary', 'orders.detail', 'payments.methods', 'notices.list',
        'dashboard.stats', 'orders.status',
      ],
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

  it('maps CAPTCHA metadata from public Laravel config without revealing secret keys', async () => {
    for (const [type, field] of [
      ['turnstile', 'turnstile_site_key'],
      ['recaptcha', 'recaptcha_site_key'],
      ['recaptcha-v3', 'recaptcha_v3_site_key'],
    ] as const) {
      const fetcher = mockFetch(ok({
        is_captcha: 1, captcha_type: type, [field]: 'public-site-key',
        turnstile_secret_key: 'never-expose', recaptcha_key: 'never-expose',
        theme_config: { accent: 'blue' },
      }))
      const res = await createGatewayApp(config, fetcher).request('/gateway/v1/bootstrap')
      const data = (await dataOf(res)).data
      expect(data.security.captcha).toEqual({ enabled: true, type, siteKey: 'public-site-key' })
      expect(JSON.stringify(data)).not.toContain('never-expose')
    }
  })

  it('does not silently disable CAPTCHA on missing or unsupported public configuration', async () => {
    const fetcher = mockFetch(ok({ is_captcha: 1, captcha_type: 'new-plugin-captcha', turnstile_secret_key: 'private' }))
    const res = await createGatewayApp(config, fetcher).request('/gateway/v1/bootstrap')
    expect((await dataOf(res)).data.security.captcha).toEqual({
      enabled: true, type: null, siteKey: null,
    })
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

  it('never forwards admin secure_path or unrelated legacy tokens to a user theme', async () => {
    const fetcher = mockFetch(ok({
      auth_data: token, is_admin: true, secure_path: 'hidden-admin-route',
      token: 'legacy-token',
    }))
    const res = await createGatewayApp(config, fetcher).request('/gateway/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.test', password: 'pass12345678' }),
    })
    expect((await dataOf(res)).data).toEqual({ auth_data: token, is_admin: true })
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
    expect(payload.error.message).toBe('Upstream request rejected')
  })

  it('does not echo credential-shaped data from upstream error messages', async () => {
    const fetcher = mockFetch({ status: 'fail', message: 'password=secret admin_key=private' }, 422)
    const res = await createGatewayApp(config, fetcher).request('/gateway/v1/plans')
    expect(res.status).toBe(422)
    expect((await dataOf(res)).error.message).toBe('Invalid request data')
  })

  it('rejects malformed successful envelopes and invalid core business fields', async () => {
    for (const payload of [
      { status: 1, data: [{ id: 1, name: 'Plan' }] },
      { data: [{ id: 1, name: 'Plan' }] },
      ok({ invalid: true }),
      ok([{ id: 'not-numeric', name: 'Plan' }]),
    ]) {
      const fetcher = mockFetch(payload)
      const res = await createGatewayApp(config, fetcher).request('/gateway/v1/plans')
      expect(res.status).toBe(502)
      expect((await dataOf(res)).ok).toBe(false)
    }
  })

  it('preserves backend rate limiting and validation errors as distinct statuses', async () => {
    const limited = mockFetch({ status: 'fail', message: 'Too many attempts' }, 429)
    const result = await createGatewayApp(config, limited).request('/gateway/v1/plans')
    expect(result.status).toBe(429)
    expect((await dataOf(result)).error.message).toBe('Too many requests')

    const validation = mockFetch({ status: 'fail', message: 'Invalid input' }, 422)
    const rejected = await createGatewayApp(config, validation).request('/gateway/v1/plans')
    expect(rejected.status).toBe(422)
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
    expect(res.status).toBe(502)
    expect((await dataOf(res)).ok).toBe(false)
  })
})

describe('application read models and experimental HPKE login', () => {
  it('never leaks subscription credentials and applies user Bearer', async () => {
    const fetcher = mockFetch(ok({
      plan_id: 10, plan: { name: 'Pro', private_note: 'secret' },
      token: 'full-subscription-secret', subscribe_url: 'https://secret', uuid: 'secret-uuid',
      u: 5, d: 7, transfer_enable: 100, expired_at: 999, reset_day: 5,
    }))
    const app = createGatewayApp(config, fetcher)
    expect((await app.request('/gateway/v1/user/subscription/summary')).status).toBe(401)
    const res = await app.request('/gateway/v1/user/subscription/summary', { headers: { Authorization: token } })
    const payload = await dataOf(res)
    expect(payload.data.planName).toBe('Pro')
    expect(payload.data.upload).toBe(5)
    expect(JSON.stringify(payload)).not.toContain('full-subscription-secret')
    expect(JSON.stringify(payload)).not.toContain('secret-uuid')
    expect(JSON.stringify(payload)).not.toContain('https://secret')
    expect((fetcher.mock.calls[0] as any)[0]).toBe('https://txboard.example/api/v1/user/getSubscribe')
  })

  it('restricts order-detail query and display payment DTO', async () => {
    const detailFetcher = mockFetch(ok({ trade_no: 'T123', status: 0, total_amount: 500 }))
    const app = createGatewayApp(config, detailFetcher)
    const res = await app.request('/gateway/v1/orders/T123', { headers: { Authorization: token } })
    expect((await dataOf(res)).data.trade_no).toBe('T123')
    expect((detailFetcher.mock.calls[0] as any)[0]).toBe('https://txboard.example/api/v1/user/order/detail?trade_no=T123')
    expect((await app.request('/gateway/v1/orders/bad%2Furl', { headers: { Authorization: token } })).status).not.toBe(200)
    const payFetcher = mockFetch(ok([{ id: 3, name: 'Stripe', payment: 'StripeCredit', icon: 'icon',
      handling_fee_fixed: 20, handling_fee_percent: 1.5, config: { secret: 'never-allow' } }]))
    const paymentResponse = await createGatewayApp(config, payFetcher)
      .request('/gateway/v1/payments', { headers: { Authorization: token } })
    const payload = await dataOf(paymentResponse)
    expect(payload.data[0]).toEqual({
      id: 3, name: 'Stripe', payment: 'StripeCredit', icon: 'icon',
      handlingFeeFixed: 20, handlingFeePercent: 1.5,
    })
    expect(JSON.stringify(payload)).not.toContain('never-allow')
  })

  it('keeps legacy notice pagination and prevents unbounded queries', async () => {
    const fetcher = mockFetch({ data: [{ id: 12, title: 'Update' }], total: 1 })
    const app = createGatewayApp(config, fetcher)
    const res = await app.request('/gateway/v1/notices?current=2&pageSize=10', { headers: { Authorization: token } })
    expect((await dataOf(res)).data).toEqual({ data: [{ id: 12, title: 'Update' }], total: 1 })
    expect((fetcher.mock.calls[0] as any)[0]).toContain('current=2&pageSize=10')
    for (const q of ['?pageSize=500', '?current=0', '?current=1&current=2', '?key=unknown']) {
      expect((await app.request('/gateway/v1/notices' + q, { headers: { Authorization: token } })).status).toBe(400)
    }
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('keeps crypto disabled without explicit key file', async () => {
    await expect(loadCryptoService({ GATEWAY_HPKE_MODE: 'optional' })).rejects.toThrow()
    expect(await loadCryptoService({ GATEWAY_HPKE_MODE: 'disabled' })).toBeUndefined()
    const res = await createGatewayApp(config, mockFetch(ok({}))).request('/gateway/v1/crypto/key')
    expect(res.status).toBe(404)
  })

  it('roundtrips standard HPKE login and rejects replay, tamper and expiry', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const service = await CryptoService.create(privateKey.export({ format: 'jwk' }), fakeReplay())
    const discovery = service.publicKey()
    const fetcher = mockFetch(ok({ auth_data: token, is_admin: false, secure_path: 'never' }))
    const app = createGatewayApp(config, fetcher, service)
    const keyResponse = await app.request('/gateway/v1/crypto/key')
    expect((await dataOf(keyResponse)).data.kid).toBe(discovery.kid)
    expect(JSON.stringify(await dataOf(await app.request('/gateway/v1/crypto/key')))).not.toContain('"d":')
    const data = { email: 'user@example.test', password: 'pass12345678' }
    const encrypted = await encryptLoginPayload(discovery, data)
    const send = (payload: unknown) => app.request('/gateway/v1/secure/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const okRes = await send(encrypted)
    expect(okRes.status).toBe(200)
    expect((await dataOf(okRes)).data.auth_data).toBe(token)
    expect((await send(encrypted)).status).toBe(409)
    expect((await send({ ...encrypted, ts: encrypted.ts + 1 })).status).toBe(400)
    expect((await send({ ...encrypted, kid: 'aaaaaaaaaaaaaaaaaaaaaaaa' })).status).toBe(400)
    expect((await send({ ...encrypted, ct: encrypted.ct.slice(0, -2) + 'aa' })).status).toBe(400)
    expect((await send({ ...encrypted, ts: Date.now() - 120_000 })).status).toBe(400)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect((fetcher.mock.calls[0] as any)[1].headers.has('Authorization')).toBe(false)
  })
})

describe('account workflows and read-only dashboard models', () => {
  it('fetches account stats and order status only for the requesting Laravel user', async () => {
    const fetcher = mockFetch(ok([2, 1, 9]))
    const app = createGatewayApp(config, fetcher)
    expect((await app.request('/gateway/v1/dashboard/stats')).status).toBe(401)
    const res = await app.request('/gateway/v1/dashboard/stats', { headers: { Authorization: token } })
    expect((await dataOf(res)).data).toEqual({ unpaidOrders: 2, openTickets: 1, invitedUsers: 9 })
    expect((fetcher.mock.calls[0] as any)[0]).toBe('https://txboard.example/api/v1/user/getStat')
    const check = mockFetch(ok(0))
    const checked = await createGatewayApp(config, check).request('/gateway/v1/orders/O-7/status', { headers: { Authorization: token } })
    expect((await dataOf(checked)).data).toEqual({ tradeNo: 'O-7', status: 0 })
    expect((check.mock.calls[0] as any)[0]).toBe('https://txboard.example/api/v1/user/order/check?trade_no=O-7')
    expect((await createGatewayApp(config, check).request('/gateway/v1/orders/not%2Fallowed/status', {
      headers: { Authorization: token },
    })).status).not.toBe(200)
  })
  it('rejects malformed dashboard and order status upstream success', async () => {
    const bad = mockFetch(ok([1, 2, 'secret']))
    const res = await createGatewayApp(config, bad).request('/gateway/v1/dashboard/stats', { headers: { Authorization: token } })
    expect(res.status).toBe(502)
    const malformed = mockFetch(ok({ status: 0, admin: true }))
    const status = await createGatewayApp(config, malformed).request('/gateway/v1/orders/O-7/status', { headers: { Authorization: token } })
    expect(status.status).toBe(502)
  })
  it('keeps account writes off without both HPKE and a distributed limiter', async () => {
    const fetcher = mockFetch(ok({}))
    const app = createGatewayApp(config, fetcher)
    expect((await app.request('/gateway/v1/secure/auth/register', { method: 'POST' })).status).toBe(404)
    expect((await app.request('/gateway/v1/secure/auth/email-code', { method: 'POST' })).status).toBe(404)
    expect(() => createGatewayApp(config, fetcher, undefined, { accountWorkflows: true })).toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('executes encrypted registration and email verification while preserving Laravel policy', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const crypto = await CryptoService.create(privateKey.export({ format: 'jwk' }), fakeReplay(), true)
    const check = vi.fn(async () => {})
    const limiter = { check }
    const fetcher = vi.fn(async (url: string) => Response.json(ok(
      url.endsWith('/auth/register')
        ? { auth_data: token, token: 'private-token', secure_path: 'private-admin' }
        : true,
    )))
    const app = createGatewayApp(config, fetcher as typeof fetch, crypto, { accountWorkflows: true, limiter })
    const discovery = crypto.publicKey()
    expect(discovery.scope).toBe('account-workflows')
    const encryptAndSend = async (op: 'register' | 'email-code', value: unknown) => {
      const sealed = await encryptForOperation(discovery, value, op)
      return app.request('/gateway/v1/secure/auth/' + op, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sealed),
      })
    }
    const reg = await encryptAndSend('register', {
      email: 'new@example.test', password: 'long-password', email_code: '123456',
      invite_code: 'ref-1', turnstile_token: 'captcha-token',
    })
    expect(reg.status).toBe(200)
    expect((await dataOf(reg)).data).toEqual({ auth_data: token })
    const emailRes = await encryptAndSend('email-code', { email: 'new@example.test', turnstile_token: 'captcha-token' })
    expect((await dataOf(emailRes)).data).toEqual({ sent: true })
    expect(check.mock.calls.map(([kind]) => kind)).toEqual(['register', 'email-code'])
    expect((fetcher.mock.calls[0] as any)[0]).toContain('/passport/auth/register')
    expect((fetcher.mock.calls[1] as any)[0]).toContain('/passport/comm/sendEmailVerify')
    expect((fetcher.mock.calls[0] as any)[1].headers.has('Authorization')).toBe(false)
  })
  it('binds HPKE ciphertext to the registered operation route', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const crypto = await CryptoService.create(privateKey.export({ format: 'jwk' }), fakeReplay(), true)
    const fetcher = mockFetch(ok({ auth_data: token }))
    const limiter = { check: vi.fn(async () => {}) }
    const app = createGatewayApp(config, fetcher, crypto, { accountWorkflows: true, limiter })
    const sealed = await encryptForOperation(crypto.publicKey(), { email: 'u@example.test', password: 'pass12345' }, 'register')
    const res = await app.request('/gateway/v1/secure/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sealed),
    })
    expect(res.status).toBe(400)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
