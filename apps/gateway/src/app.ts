import { randomUUID } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { GatewayConfig } from './env.js'
import { asRecord, boundedJson, GatewayFailure, upstreamRequest, type UpstreamFetcher } from './upstream.js'
import type { CryptoService, SealedRequest, CryptoOperation } from './crypto.js'
import type { AccountLimiter } from './redis-security.js'
import { normalizeLoginEmail, type LoginAdmission, type LoginProtection } from './login-protection.js'
import {
  extractSubject,
  resolveRoutePolicy,
  RedisRateLimiter,
  type RateLimiterStats,
} from './rate-limiter.js'
import {
  compileIpAllowlist,
  evaluateRequest,
  hostMatchesAllowlist,
  sanitizeForwardedHeaders,
  type CompiledIpAllowlist,
} from './trusted-proxy.js'

type Bindings = { Bindings: Record<string, never>; Variables: { requestId: string } }
type GatewayContext = Context<Bindings, any, any>

const VERSION = '1'
const PREFIX = '/gateway/v1'

const loginSchema = z.strictObject({
  email: z.email().max(254),
  password: z.string().min(8).max(1024),
  turnstile_token: z.string().max(4096).optional(),
  recaptcha_v3_token: z.string().max(4096).optional(),
  recaptcha_data: z.string().max(4096).optional(),
  email_code: z.string().max(128).optional(),
})
const statuses = new Set(['0', '1', '2', '3'])

// Source-aligned minimum runtime contracts. Unknown TXBoard extension fields remain
// compatible, but missing core fields fail closed instead of reaching a theme.
const planListSchema = z.array(z.looseObject({ id: z.number().int(), name: z.string() }))
const userProfileSchema = z.looseObject({ email: z.email() })
const orderListSchema = z.array(z.looseObject({ trade_no: z.string(), status: z.number().int() }))
const orderDetailSchema = z.looseObject({ trade_no: z.string(), status: z.number().int() })
const paymentMethodsSchema = z.array(z.looseObject({ id: z.number().int(), name: z.string() }))
const noticePageSchema = z.object({
  data: z.array(z.looseObject({ id: z.number().int() })),
  total: z.number().int().nonnegative(),
})
const sealedRequestSchema = z.strictObject({
  kid: z.string().min(1).max(100),
  ts: z.number().int(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  enc: z.string().min(40).max(500),
  ct: z.string().min(24).max(20000),
})
const captchaFields = {
  turnstile_token: z.string().max(4096).optional(),
  recaptcha_v3_token: z.string().max(4096).optional(),
  recaptcha_data: z.string().max(4096).optional(),
}
const registerSchema = z.strictObject({
  email: z.email().max(254),
  password: z.string().min(8).max(1024),
  invite_code: z.string().max(128).optional(),
  email_code: z.string().regex(/^\d{6}$/).optional(),
  ...captchaFields,
})
const emailCodeSchema = z.strictObject({ email: z.email().max(254), ...captchaFields })
const statsSchema = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative(), z.number().int().nonnegative()])
const orderStatusSchema = z.number().int().min(0).max(3)
const loginResultSchema = z.object({
  auth_data: z.string().regex(/^Bearer \S{8,}$/),
  is_admin: z.union([z.boolean(), z.number().int()]).optional(),
})

function validated<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new GatewayFailure('UPSTREAM_ERROR', 502, 'Unexpected upstream response shape')
  }
  return parsed.data
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayFailure('UPSTREAM_ERROR', 502, 'Unexpected upstream response shape')
  }
  return value as Record<string, unknown>
}

// Only TXBoard guest/comm/config public CAPTCHA metadata may reach theme clients.
// CaptchaService in Laravel remains responsible for checking submitted tokens.
function publicCaptcha(data: Record<string, unknown>) {
  const enabled = data.is_captcha === true || data.is_captcha === 1 || data.is_captcha === '1'
  if (!enabled) return { enabled: false, type: null, siteKey: null }
  const candidate = data.captcha_type
  const type = candidate === 'turnstile' || candidate === 'recaptcha' || candidate === 'recaptcha-v3'
    ? candidate : null
  const key = type === 'turnstile' ? data.turnstile_site_key
    : type === 'recaptcha-v3' ? data.recaptcha_v3_site_key
    : type === 'recaptcha' ? data.recaptcha_site_key : null
  return {
    enabled: true,
    type,
    siteKey: typeof key === 'string' && key.trim() ? key : null,
  }
}


/** GW-203: the Gateway never validates CAPTCHA tokens — it only checks whether
 * a standard challenge field was submitted, then forwards it verbatim for
 * Laravel CaptchaService to verify. An empty or whitespace-only token does not
 * satisfy the challenge. */
function hasCaptchaField(data: Record<string, unknown>): boolean {
  for (const key of ['turnstile_token', 'recaptcha_v3_token', 'recaptcha_data']) {
    const value = data[key]
    if (typeof value === 'string' && value.trim()) return true
  }
  return false
}

function success(c: GatewayContext, data: unknown, status: 200 | 201 = 200) {
  return c.json({ ok: true, data, meta: { version: VERSION, requestId: c.get('requestId') } }, status)
}

type ErrorStatus = 400 | 401 | 409 | 403 | 404 | 405 | 413 | 422 | 428 | 429 | 500 | 502 | 503 | 504

function failure(c: GatewayContext, code: string, message: string, status: ErrorStatus) {
  return c.json({ ok: false, error: { code, message }, meta: { version: VERSION, requestId: c.get('requestId') } }, status)
}

function authBearer(c: GatewayContext): string | null {
  const value = c.req.header('Authorization') || ''
  if (!/^Bearer [^\s]{8,4096}$/.test(value)) return null
  return value
}

/**
 * GW-204 Host validation. Only a bare hostname (optionally with port) is
 * accepted; CR/LF, spaces, credentials, slashes, query and fragment are
 * rejected so the value can never smuggle a second virtual host upstream.
 */
export function safeHostHeader(value: string): string | null {
  const v = value.trim().toLowerCase()
  if (!v || v.length > 253) return null
  // Only host characters may appear; CR/LF/space/credentials/query/fragment are rejected.
  if (!/^[a-z0-9.[\]:-]+$/.test(v)) return null
  const host = v.replace(/:\d{1,5}$/, '')
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host) && !/^\[[0-9a-f:]+\]$/.test(host)) return null
  if (host.startsWith('.') || host.endsWith('.') || host.includes('..')) return null
  if (host.split('.').some(label => label.length > 63)) return null
  return host
}

export type GatewayPolicy = {
  accountWorkflows?: boolean
  limiter?: AccountLimiter
  /** GW-204: comma-delimited ingress IPs/CIDRs whose proxy headers may be trusted. */
  trustedIngress?: string
  /** GW-204: comma-delimited exact Host values (or *.suffix wildcards). Empty = no check. */
  allowedHosts?: string
  /** GW-202: Redis sliding-window route limiter (IP + account dual dimension). */
  rateLimiter?: RedisRateLimiter
  /** GW-202: receives limiter decisions (429s, degraded runs) for metrics/alerts. */
  onRateEvent?: (event: {
    policyId: string
    requestId: string
    limited: boolean
    degraded: boolean
    retryAfterHeader: number
    ipCount: number
    subjectCount: number
  }) => void
  /** GW-203: login anti-credential-stuffing (account + IP dual dimension). */
  loginProtection?: LoginProtection
}

export type GatewayRateObserver = NonNullable<GatewayPolicy['onRateEvent']>


function publicTheme(data: unknown) {
  const config = asRecord(data)
  return {
    name: typeof config.frontend_theme === 'string' && config.frontend_theme ? config.frontend_theme : 'TXBoard',
    config: asRecord(config.theme_config),
  }
}

async function readLoginRequest(request: Request, maxBytes: number): Promise<unknown> {
  const type = request.headers.get('content-type') || ''
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new GatewayFailure('VALIDATION_ERROR', 400, 'Content-Type must be application/json')
  }
  const len = request.headers.get('content-length')
  if (len && Number(len) > maxBytes) {
    throw new GatewayFailure('PAYLOAD_TOO_LARGE', 413, 'Request body too large')
  }
  try {
    return await boundedJson(request.body, maxBytes)
  } catch (e) {
    if (e instanceof GatewayFailure && e.code === 'PAYLOAD_TOO_LARGE') throw e
    throw new GatewayFailure('VALIDATION_ERROR', 400, 'Invalid JSON request')
  }
}

export function createGatewayApp(
  config: GatewayConfig, fetcher: UpstreamFetcher = fetch, crypto?: CryptoService,
  policy: GatewayPolicy = {},
) {
  if (policy.accountWorkflows && (!crypto || !policy.limiter)) {
    throw new Error('Account workflows require both encryption and Redis rate limiter')
  }
  const allowlist: CompiledIpAllowlist = compileIpAllowlist(policy.trustedIngress || '')
  const allowedHosts = (policy.allowedHosts || '').split(',').map(s => s.trim()).filter(Boolean)
  const app = new Hono<Bindings>()

  // GW-204 layer 1: forge-proof client identity and hardened boundary headers.
  // A request that claims to be proxied but comes from a peer outside the
  // ingress allowlist is rejected here, before any route handler can read the
  // spoofed X-Forwarded-For / X-Real-IP values.
  app.use('*', async (c, next) => {
    c.set('requestId', randomUUID())
    c.header('X-Request-Id', c.get('requestId'))
    c.header('Cache-Control', 'no-store')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'no-referrer')
    c.header('Cross-Origin-Resource-Policy', 'same-origin')
    c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')

    const raw = c.req.raw as Request & { __peerIp?: string }
    const peer = raw.__peerIp ?? '0.0.0.0'
    const verdict = evaluateRequest(peer, raw.headers, allowlist)
    if (verdict.reason === 'forged_headers') {
      return failure(c, 'FORBIDDEN', 'Proxy headers are not accepted from this source', 403)
    }
    // Downstream code (rate limiting, audit logs) reads only this sanitized value.
    Object.defineProperty(raw, '__clientIp', { value: verdict.clientIp, enumerable: false })

    const hostHeader = c.req.header('Host')
    if (hostHeader !== undefined) {
      const host = safeHostHeader(hostHeader)
      if (!host || (allowedHosts.length > 0 && !(await hostMatchesAllowlist(host, allowedHosts)))) {
        return failure(c, 'BAD_HOST', 'Host header is not allowed', 403)
      }
    }
    await next()
  })

  // GW-202 layer: route-level sliding-window limiter (Redis, IP + subject).
  // Runs after the GW-204 trust verdict so the client IP can never be forged,
  // and before route handlers so a limited request never reaches upstream.
  if (policy.rateLimiter) {
    const limiter = policy.rateLimiter
    const observer = policy.onRateEvent
    app.use(`${PREFIX}/*`, async (c, next) => {
      const route = resolveRoutePolicy(c.req.path, c.req.method)
      if (!route) return next()
      const clientIp = (c.req.raw as Request & { __clientIp?: string }).__clientIp ?? '0.0.0.0'
      const requestId = c.get('requestId')

      // Body is only needed for email-subject routes; clone to avoid consuming.
      let bodyEmail: string | undefined
      if (route.subjectFrom === 'email' && c.req.method === 'POST') {
        try {
          const text = await c.req.raw.clone().text()
          const parsed = JSON.parse(text) as unknown
          if (parsed && typeof parsed === 'object') {
            // For encrypted envelopes the subject is inside the sealed payload;
            // the plaintext is unavailable pre-crypto, so fall back to IP-only.
            bodyEmail = typeof (parsed as { email?: unknown }).email === 'string'
              ? (parsed as { email: string }).email : undefined
          }
        } catch {
          // Unparseable body: validation errors later; limit by IP only.
        }
      }
      const subject = extractSubject(route, {
        authorization: c.req.header('Authorization'),
        bodyEmail,
      })

      try {
        const decision = await limiter.check({ policy: route, ip: clientIp, subject })
        if (!decision.allowed) {
          c.header('Retry-After', String(decision.retryAfterHeader))
          observer?.({ policyId: route.id, requestId, limited: true, degraded: false,
            retryAfterHeader: decision.retryAfterHeader,
            ipCount: decision.ipCount, subjectCount: decision.subjectCount })
          return failure(c, 'RATE_LIMITED', 'Too many requests', 429)
        }
        if (decision.degraded) {
          observer?.({ policyId: route.id, requestId, limited: false, degraded: true,
            retryAfterHeader: 0,
            ipCount: decision.ipCount, subjectCount: decision.subjectCount })
        }
      } catch (error) {
        if (error instanceof GatewayFailure) {
          // Fail-closed routes surface 503 (never silently unlimited).
          return failure(c, error.code, error.message, error.status as ErrorStatus)
        }
        return failure(c, 'INTERNAL_ERROR', 'Gateway request failed', 500)
      }
      return next()
    })
  }

  // Exact-origin CORS; never reflect arbitrary origins or issue credential cookies.
  app.use(`${PREFIX}/*`, async (c, next) => {
    const origin = c.req.header('Origin')
    if (origin) {
      if (!config.allowedOrigins.has(origin)) {
        return failure(c, 'ORIGIN_DENIED', 'Origin is not allowed', 403)
      }
      c.header('Access-Control-Allow-Origin', origin)
      c.header('Vary', 'Origin')
      c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
      c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      c.header('Access-Control-Allow-Credentials', 'false')
      c.header('Access-Control-Expose-Headers', 'X-Request-Id')
      c.header('Access-Control-Max-Age', '600')
    }
    if (c.req.method === 'OPTIONS') return c.body(null, 204)
    await next()
  })

  app.get('/healthz', c => c.json({ status: 'ok', contract: VERSION }))
  app.get(`${PREFIX}/bootstrap`, async c => {
    const data = requiredRecord(await upstreamRequest(config, fetcher, 'guestConfig'))
    const theme = publicTheme(data)
    return success(c, {
      site: {
        name: typeof data.app_name === 'string' ? data.app_name : 'TXBoard',
        description: typeof data.app_description === 'string' ? data.app_description : '',
        url: typeof data.app_url === 'string' ? data.app_url : '',
        logo: typeof data.logo === 'string' ? data.logo : '',
      },
      theme,
      security: { captcha: publicCaptcha(data) },
      capabilities: [
        'auth.login', 'user.profile', 'plans.list', 'orders.list', 'theme.config',
        'user.subscription.summary', 'orders.detail', 'payments.methods', 'notices.list',
        'dashboard.stats', 'orders.status',
        ...(crypto ? ['auth.login.encrypted'] : []),
        ...(policy.accountWorkflows ? ['auth.register.encrypted', 'auth.email-code.encrypted'] : []),
      ],
    })
  })
  app.get(`${PREFIX}/theme/config`, async c =>
    success(c, publicTheme(requiredRecord(await upstreamRequest(config, fetcher, 'guestConfig')))))
  app.get(`${PREFIX}/plans`, async c =>
    success(c, validated(planListSchema, await upstreamRequest(config, fetcher, 'guestPlans'))))

  async function runLogin(c: GatewayContext, raw: unknown) {
    const checked = loginSchema.safeParse(raw)
    if (!checked.success) return failure(c, 'VALIDATION_ERROR', 'Invalid login data', 400)
    // Redis account-level throttle protects the Gateway entry point. Laravel
    // remains the authority for password and CAPTCHA and also needs own limits.
    // clientIp is the GW-204 sanitized address, never a client-supplied header.
    const clientIp = (c.req.raw as Request & { __clientIp?: string }).__clientIp
    if (policy.limiter) await policy.limiter.check('login', checked.data.email, clientIp)

    // GW-203: outcome-driven anti-credential-stuffing. The verdict is decided
    // on the SUBMITTED email and the sanitized source IP only — never on
    // whether the account exists — so existing and unknown accounts receive
    // byte-identical statuses, codes and Retry-After headers at every step.
    const protection = policy.loginProtection
    const email = normalizeLoginEmail(checked.data.email)
    if (protection) {
      let verdict: LoginAdmission
      try {
        verdict = await protection.admit(email, clientIp)
      } catch {
        // Fail closed: without the safety store, no login attempt may reach
        // Laravel. This mirrors the replay/rate-limit failure posture.
        return failure(c, 'UPSTREAM_UNAVAILABLE', 'Login protection unavailable', 503)
      }
      if (verdict.verdict === 'locked') {
        c.header('Retry-After', String(Math.ceil(verdict.retryAfterMs / 1000)))
        return failure(c, 'RATE_LIMITED', 'Too many requests', 429)
      }
      if (verdict.verdict === 'captcha' && !hasCaptchaField(checked.data)) {
        return failure(c, 'CAPTCHA_REQUIRED', 'Verification required to continue', 428)
      }
    }

    let result: unknown
    try {
      result = await upstreamRequest(config, fetcher, 'login', { body: checked.data })
    } catch (error) {
      // A genuine upstream rejection advances the stuffing counters. Token
      // validation failures (400/403/422) are not password attempts: they must
      // not burn the victim's account budget or lock a legitimate user out.
      if (protection && error instanceof GatewayFailure
        && (error.status === 401 || error.status === 429)) {
        try { await protection.recordFailure(email, clientIp) } catch { /* logged elsewhere */ }
      }
      throw error
    }
    // A real success clears the account dimension. The IP dimension is
    // intentionally kept: one legitimate login must not launder the stuffing
    // counters of a shared or rotating source address.
    if (protection) {
      try { await protection.recordSuccess(email) } catch { /* non-fatal */ }
    }
    return success(c, validated(loginResultSchema, result))
  }
  app.post(`${PREFIX}/auth/login`, async c =>
    runLogin(c, await readLoginRequest(c.req.raw, config.maxRequestBytes)))

  if (crypto) {
    app.get(`${PREFIX}/crypto/key`, c => success(c, crypto.publicKey()))
    const secure = (operation: CryptoOperation, process: (c: GatewayContext, data: unknown) => Promise<Response>) =>
      async (c: GatewayContext) => {
        const raw = await readLoginRequest(c.req.raw, config.maxRequestBytes)
        const checked = sealedRequestSchema.safeParse(raw)
        if (!checked.success) return failure(c, 'VALIDATION_ERROR', 'Invalid encrypted request', 400)
        // Operation-specific AEAD AAD: ciphertext cannot be replayed to
        // registration or email endpoints, even with the same key and nonce.
        const data = await crypto.open(checked.data as SealedRequest, operation)
        return process(c, data)
      }
    app.post(`${PREFIX}/secure/auth/login`, secure('login', runLogin))
    if (policy.accountWorkflows && policy.limiter) {
      const limiter = policy.limiter
      app.post(`${PREFIX}/secure/auth/register`, secure('register', async (c, data) => {
        const parsed = registerSchema.safeParse(data)
        if (!parsed.success) return failure(c, 'VALIDATION_ERROR', 'Invalid registration data', 400)
        await limiter.check('register', parsed.data.email, (c.req.raw as any).__clientIp)
        return success(c, validated(loginResultSchema,
          await upstreamRequest(config, fetcher, 'register', { body: parsed.data })))
      }))
      app.post(`${PREFIX}/secure/auth/email-code`, secure('email-code', async (c, data) => {
        const parsed = emailCodeSchema.safeParse(data)
        if (!parsed.success) return failure(c, 'VALIDATION_ERROR', 'Invalid verification request', 400)
        await limiter.check('email-code', parsed.data.email, (c.req.raw as any).__clientIp)
        const result = await upstreamRequest(config, fetcher, 'sendEmailCode', { body: parsed.data })
        if (result !== true) throw new GatewayFailure('UPSTREAM_ERROR', 502, 'Unexpected upstream response shape')
        return success(c, { sent: true })
      }))
    }
  }

  app.get(`${PREFIX}/user/profile`, async c => {
    const auth = authBearer(c)
    if (!auth) return failure(c, 'UNAUTHORIZED', 'Bearer token required', 401)
    return success(c, validated(userProfileSchema, await upstreamRequest(config, fetcher, 'userProfile', { auth })))
  })
  app.get(`${PREFIX}/orders`, async c => {
    const auth = authBearer(c)
    if (!auth) return failure(c, 'UNAUTHORIZED', 'Bearer token required', 401)
    const status = c.req.query('status')
    const keys = Object.keys(c.req.queries())
    if (keys.some(key => key !== 'status') || (status !== undefined && !statuses.has(status))
      || (status !== undefined && c.req.queries('status')?.length !== 1)) {
      return failure(c, 'VALIDATION_ERROR', 'Invalid order query', 400)
    }
    return success(c, validated(orderListSchema, await upstreamRequest(config, fetcher, 'userOrders', {
      auth, status: status === undefined ? undefined : Number(status),
    })))
  })
  app.get(`${PREFIX}/orders/:tradeNo`, async c => {
    const auth = authBearer(c)
    if (!auth) return failure(c, 'UNAUTHORIZED', 'Bearer token required', 401)
    const tradeNo = c.req.param('tradeNo')
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(tradeNo)) {
      return failure(c, 'VALIDATION_ERROR', 'Invalid order identifier', 400)
    }
    return success(c, validated(orderDetailSchema,
      await upstreamRequest(config, fetcher, 'userOrderDetail', { auth, tradeNo })))
  })

  app.get(`${PREFIX}/payments`, async c => {
    const auth = authBearer(c)
    if (!auth) return failure(c, 'UNAUTHORIZED', 'Bearer token required', 401)
    const methods = validated(paymentMethodsSchema,
      await upstreamRequest(config, fetcher, 'userPaymentMethods', { auth }))
    // Only display fields; no provider configs, credentials or payment URLs.
    return success(c, methods.map(m => ({
      id: m.id, name: m.name,
      icon: typeof m.icon === 'string' ? m.icon : null,
      payment: typeof m.payment === 'string' ? m.payment : null,
      handlingFeeFixed: typeof m.handling_fee_fixed === 'number' ? m.handling_fee_fixed : 0,
      handlingFeePercent: typeof m.handling_fee_percent === 'number' ? m.handling_fee_percent : 0,
    })))
  })

  app.get(`${PREFIX}/user/subscription/summary`, async c => {
    const auth = authBearer(c)
    if (!auth) return failure(c, 'UNAUTHORIZED', 'Bearer token required', 401)
    const data = requiredRecord(await upstreamRequest(config, fetcher, 'userSubscription', { auth }))
    // TXBoard getSubscribe includes user token, UUID and subscribe_url.
    // This endpoint is safe for an account overview, NOT full subscription export.
    const optionalNumber = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null
    const plan = asRecord(data.plan)
    return success(c, {
      planId: optionalNumber(data.plan_id), planName: typeof plan.name === 'string' ? plan.name : null,
      expiredAt: optionalNumber(data.expired_at), upload: optionalNumber(data.u),
      download: optionalNumber(data.d), transferEnable: optionalNumber(data.transfer_enable),
      resetDay: optionalNumber(data.reset_day), deviceLimit: optionalNumber(data.device_limit),
      speedLimit: optionalNumber(data.speed_limit),
    })
  })

  app.get(`${PREFIX}/notices`, async c => {
    const auth = authBearer(c)
    if (!auth) return failure(c, 'UNAUTHORIZED', 'Bearer token required', 401)
    const params = c.req.queries()
    if (Object.keys(params).some(k => !['current', 'pageSize'].includes(k))
      || Object.values(params).some(a => a.length !== 1)) {
      return failure(c, 'VALIDATION_ERROR', 'Invalid notice query', 400)
    }
    const current = c.req.query('current') ?? '1'
    const pageSize = c.req.query('pageSize') ?? '5'
    if (!/^[1-9][0-9]{0,3}$/.test(current) || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(pageSize)) {
      return failure(c, 'VALIDATION_ERROR', 'Invalid notice pagination', 400)
    }
    return success(c, validated(noticePageSchema, await upstreamRequest(config, fetcher, 'userNotices',
      { auth, current: Number(current), pageSize: Number(pageSize) })))
  })

  app.get(`${PREFIX}/dashboard/stats`, async c => {
    const auth = authBearer(c)
    if (!auth) return failure(c, 'UNAUTHORIZED', 'Bearer token required', 401)
    const counts = validated(statsSchema, await upstreamRequest(config, fetcher, 'userStats', { auth }))
    return success(c, { unpaidOrders: counts[0], openTickets: counts[1], invitedUsers: counts[2] })
  })
  app.get(`${PREFIX}/orders/:tradeNo/status`, async c => {
    const auth = authBearer(c)
    if (!auth) return failure(c, 'UNAUTHORIZED', 'Bearer token required', 401)
    const tradeNo = c.req.param('tradeNo')
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(tradeNo)) {
      return failure(c, 'VALIDATION_ERROR', 'Invalid order identifier', 400)
    }
    const status = validated(orderStatusSchema,
      await upstreamRequest(config, fetcher, 'userOrderStatus', { auth, tradeNo }))
    return success(c, { tradeNo, status })
  })

  app.post(`${PREFIX}/orders`, c =>
    failure(c, 'METHOD_NOT_ALLOWED', 'Order creation is not available in Gateway v1 Phase 1', 405))

  app.notFound(c => failure(c, 'NOT_FOUND', 'Gateway route does not exist', 404))
  app.onError((error, c) => {
    if (error instanceof GatewayFailure) {
      // Preserve meaningful upstream 4xx/429 statuses; never turn backend
      // rate-limit or validation errors into misleading gateway 502s.
      const status = ([400, 401, 403, 404, 405, 409, 413, 422, 428, 429, 500, 502, 503, 504]
        .includes(error.status) ? error.status : 502) as ErrorStatus
      return failure(c, error.code, error.message, status)
    }
    // Intentionally do not log request bodies, Authorization or upstream errors.
    return failure(c, 'INTERNAL_ERROR', 'Gateway request failed', 500)
  })
  return app
}
