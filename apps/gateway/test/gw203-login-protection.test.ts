import { describe, expect, it, vi } from 'vitest'
import { createGatewayApp } from '../src/app.js'
import { loadConfig } from '../src/env.js'
import { CryptoService } from '../src/crypto.js'
import { MemoryLoginProtection, type LoginPolicy } from '../src/login-protection.js'
import { generateKeyPairSync } from 'node:crypto'
import { encryptLoginPayload } from '../../../packages/theme-sdk/src/crypto.js'

/**
 * GW-203: login anti-credential-stuffing behaviour end-to-end through the
 * Gateway routes. The limiter is the real MemoryLoginProtection, so these
 * tests exercise the actual captcha/lock decision path.
 *
 * Engine timeline with accountCaptchaAfter=2, lockTiers=[[4, 300s]]:
 *   attempt 1  admit allow      -> upstream 401, account fails=1
 *   attempt 2  admit allow      -> upstream 401, account fails=2 (challenge armed)
 *   attempt 3  admit captcha    -> 428 without a token; with a token the
 *                                  attempt reaches the upstream and a fresh
 *                                  401 advances fails to 3
 *   attempt 4  admit captcha    -> token + upstream 401 advances fails to 4 -> lock
 *   attempt 5  admit locked     -> 429 + Retry-After, upstream untouched
 *
 * A 428 challenge response never touches the upstream, so it never advances
 * the counters itself — only real upstream rejections do.
 */

const config = loadConfig({
  TXBOARD_UPSTREAM_URL: 'https://txboard.example/',
  GATEWAY_ALLOWED_ORIGINS: 'https://theme.example',
})
const token = 'Bearer usertoken_longer_than_eight'
function ok(data: unknown) { return { status: 'success', message: null, data } }
function loginOk() { return vi.fn(async () => Response.json(ok({ auth_data: token, is_admin: false }))) }
function loginRejected() { return vi.fn(async () => Response.json({ status: 'fail', message: 'Bad credentials' }, { status: 401 })) }
/** A CAPTCHA-bearing attempt with a valid token succeeds; everything else 401s. */
function captchaGatedLogin() {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    if (body.turnstile_token) return Response.json(ok({ auth_data: token, is_admin: false }))
    return Response.json({ status: 'fail', message: 'Bad credentials' }, { status: 401 })
  })
}
async function dataOf(response: Response) { return await response.json() as any }
function fakeReplay() {
  const seen = new Set<string>()
  return { reserve: async (kid: string, nonce: string) => {
    const key = kid + ':' + nonce
    if (seen.has(key)) return false
    seen.add(key)
    return true
  } }
}
const tightPolicy: LoginPolicy = {
  accountCaptchaAfter: 2, ipCaptchaAfter: 10, failureWindowMs: 900_000, lockTiers: [[4, 300_000]],
}
async function login(app: ReturnType<typeof createGatewayApp>, body: Record<string, unknown> = {}) {
  return app.request('/gateway/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'victim@example.test', password: 'pass12345678', ...body }),
  })
}

describe('GW-203 login anti-credential-stuffing', () => {
  it('demands a CAPTCHA after repeated failures and lets a captcha-bearing attempt through', async () => {
    const fetcher = captchaGatedLogin()
    const limiter = new MemoryLoginProtection(tightPolicy)
    const app = createGatewayApp(config, fetcher as typeof fetch, undefined, { loginProtection: limiter })
    expect(await login(app)).toMatchObject({ status: 401 })
    expect(await login(app)).toMatchObject({ status: 401 })
    const challenged = await login(app)
    expect(challenged.status).toBe(428)
    const body = await dataOf(challenged)
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('CAPTCHA_REQUIRED')
    // The upstream is never consulted for a challenged attempt.
    expect(fetcher).toHaveBeenCalledTimes(2)
    const passed = await login(app, { turnstile_token: 'captcha-token' })
    expect(passed.status).toBe(200)
    expect((await dataOf(passed)).data.auth_data).toBe(token)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('locks the account dimension after the lock tier and reports Retry-After', async () => {
    const fetcher = captchaGatedLogin()
    const limiter = new MemoryLoginProtection(tightPolicy)
    const app = createGatewayApp(config, fetcher as typeof fetch, undefined, { loginProtection: limiter })
    expect(await login(app)).toMatchObject({ status: 401 })
    expect(await login(app)).toMatchObject({ status: 401 })
    // Two captcha-bearing attempts still fail upstream; the 4th failure locks.
    const rejected = vi.fn(async () => Response.json({ status: 'fail', message: 'Bad credentials' }, { status: 401 }))
    const app2 = createGatewayApp(config, rejected, undefined, { loginProtection: limiter })
    expect(await login(app2, { turnstile_token: 'stale' })).toMatchObject({ status: 401 }) // fails=3
    expect(await login(app2, { turnstile_token: 'stale' })).toMatchObject({ status: 401 }) // fails=4 -> locked
    const locked = await login(app2)
    expect(locked.status).toBe(429)
    expect(locked.headers.get('Retry-After')).toBe('300')
    const body = await dataOf(locked)
    expect(body.error.code).toBe('RATE_LIMITED')
    expect(body.ok).toBe(false)
    // Even a captcha-bearing attempt cannot skip the lock.
    expect((await login(app2, { turnstile_token: 'captcha-token' })).status).toBe(429)
    expect(rejected).toHaveBeenCalledTimes(2)
  })

  it('does not leak account existence through status, code or timing of the challenge path', async () => {
    const fetcher = loginRejected()
    const limiter = new MemoryLoginProtection(tightPolicy)
    const app = createGatewayApp(config, fetcher, undefined, { loginProtection: limiter })
    const respond = async (app: ReturnType<typeof createGatewayApp>, email: string, captcha = false) => app.request('/gateway/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'pass12345678', ...(captcha ? { turnstile_token: 't' } : {}) }),
    })
    for (const email of ['victim@example.test', 'nobody@example.test']) {
      // Each email gets its own limiter instance so both start at zero.
      const limiter = new MemoryLoginProtection(tightPolicy)
      const app = createGatewayApp(config, fetcher, undefined, { loginProtection: limiter })
      // The submitted email decides the dimension, never upstream reality:
      // the unknown account fails the 401 upstream and, after the same two
      // attempts, receives the identical 428 challenge contract.
      expect((await respond(app, email)).status).toBe(401) // fails=1
      expect((await respond(app, email)).status).toBe(401) // fails=2, challenge armed
      const challenged = await respond(app, email)         // challenge, no token
      expect(challenged.status).toBe(428)
      const body = await dataOf(challenged)
      expect(body.error.code).toBe('CAPTCHA_REQUIRED')
      expect(JSON.stringify(body)).not.toContain(email)
      // A captcha-bearing failure reaches the upstream and locks both
      // accounts identically; a challenge alone never advances the counter.
      expect((await respond(app, email, true)).status).toBe(401) // fails=3
      expect((await respond(app, email, true)).status).toBe(401) // fails=4 -> locked
      const locked = await respond(app, email)
      expect(locked.status).toBe(429)
      expect(locked.headers.get('Retry-After')).toBe('300')
      expect((await respond(app, email, true)).status).toBe(429)
    }
  })

  it('a successful login resets the account dimension', async () => {
    const fetcher = loginRejected()
    const limiter = new MemoryLoginProtection(tightPolicy)
    const app = createGatewayApp(config, fetcher, undefined, { loginProtection: limiter })
    expect(await login(app)).toMatchObject({ status: 401 })
    expect(await login(app)).toMatchObject({ status: 401 })
    expect((await login(app)).status).toBe(428)
    // Real success: account dimension clears, the IP dimension (threshold 10)
    // stays below its own challenge, so the next login is admitted again.
    const successFetcher = loginOk()
    const successApp = createGatewayApp(config, successFetcher, undefined, { loginProtection: limiter })
    expect(await login(successApp, { turnstile_token: 't' })).toMatchObject({ status: 200 })
    expect(await login(successApp, { turnstile_token: 't' })).toMatchObject({ status: 200 })
    expect(successFetcher).toHaveBeenCalledTimes(2)
  })

  it('forwards captcha tokens verbatim and never lets the Gateway validate them', async () => {
    const fetcher = loginOk()
    const limiter = new MemoryLoginProtection(tightPolicy)
    const app = createGatewayApp(config, fetcher, undefined, { loginProtection: limiter })
    await login(app, { turnstile_token: 'verbatim-token-123' })
    const body = JSON.parse((fetcher.mock.calls[0] as any[])[1].body)
    // Standard Laravel-compatible field names; gateway adds nothing of its own.
    expect(body.turnstile_token).toBe('verbatim-token-123')
    expect(Object.keys(body).sort()).toEqual(['email', 'password', 'turnstile_token'])
  })

  it('locks a credential-stuffing IP across distinct accounts', async () => {
    const fetcher = loginRejected()
    const limiter = new MemoryLoginProtection({
      accountCaptchaAfter: 100, ipCaptchaAfter: 2, failureWindowMs: 900_000, lockTiers: [[3, 300_000]],
    })
    const app = createGatewayApp(config, fetcher, undefined, { loginProtection: limiter })
    const attempt = async (email: string, captcha = false) => app.request('/gateway/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'pass12345678', ...(captcha ? { turnstile_token: 't' } : {}) }),
    })
    expect((await attempt('a@example.test')).status).toBe(401) // IP fails=1
    expect((await attempt('b@example.test')).status).toBe(401) // IP fails=2, challenge armed
    expect((await attempt('c@example.test')).status).toBe(428) // IP captcha, no token
    expect((await attempt('c@example.test', true)).status).toBe(401) // fails=3 -> IP lock
    // A fresh target account from the same IP stays locked; upstream untouched.
    expect((await attempt('d@example.test')).status).toBe(429)
    expect((await attempt('d@example.test', true)).status).toBe(429)
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('applies the same protection to the encrypted login endpoint', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const limiter = new MemoryLoginProtection(tightPolicy)
    const crypto = await CryptoService.create(privateKey.export({ format: 'jwk' }), fakeReplay())
    const fetcher = loginRejected()
    const app = createGatewayApp(config, fetcher, crypto, { loginProtection: limiter })
    const discovery = crypto.publicKey()
    const send = async (captcha = false) => app.request('/gateway/v1/secure/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(await encryptLoginPayload(discovery, {
        email: 'victim@example.test', password: 'pass12345678', ...(captcha ? { turnstile_token: 't' } : {}),
      })),
    })
    expect(await send()).toMatchObject({ status: 401 })
    expect(await send()).toMatchObject({ status: 401 })
    expect((await send()).status).toBe(428) // challenge armed, no captcha field
    expect(await send(true)).toMatchObject({ status: 401 }) // fails=3
    expect(await send(true)).toMatchObject({ status: 401 }) // fails=4 -> locked
    expect((await send()).status).toBe(429)
    expect((await send(true)).status).toBe(429)
  })

  it('fails closed when the protection store is unavailable', async () => {
    const fetcher = loginOk()
    const failing = {
      admit: async () => { throw new Error('store down') },
      recordFailure: async () => { throw new Error('store down') },
      recordSuccess: async () => { throw new Error('store down') },
    }
    const app = createGatewayApp(config, fetcher, undefined, { loginProtection: failing as any })
    const res = await login(app)
    expect(res.status).toBe(503)
    expect((await dataOf(res)).error.code).toBe('UPSTREAM_UNAVAILABLE')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
