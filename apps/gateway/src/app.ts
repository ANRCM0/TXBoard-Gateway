import { randomUUID } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { GatewayConfig } from './env.js'
import { asRecord, boundedJson, GatewayFailure, upstreamRequest, type UpstreamFetcher } from './upstream.js'
import type { CryptoService, SealedRequest } from './crypto.js'

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


function success(c: GatewayContext, data: unknown, status: 200 | 201 = 200) {
  return c.json({ ok: true, data, meta: { version: VERSION, requestId: c.get('requestId') } }, status)
}

type ErrorStatus = 400 | 401 | 409 | 403 | 404 | 405 | 413 | 422 | 429 | 500 | 502 | 503 | 504

function failure(c: GatewayContext, code: string, message: string, status: ErrorStatus) {
  return c.json({ ok: false, error: { code, message }, meta: { version: VERSION, requestId: c.get('requestId') } }, status)
}

function authBearer(c: GatewayContext): string | null {
  const value = c.req.header('Authorization') || ''
  if (!/^Bearer [^\s]{8,4096}$/.test(value)) return null
  return value
}

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

export function createGatewayApp(config: GatewayConfig, fetcher: UpstreamFetcher = fetch, crypto?: CryptoService) {
  const app = new Hono<Bindings>()

  app.use('*', async (c, next) => {
    c.set('requestId', randomUUID())
    c.header('X-Request-Id', c.get('requestId'))
    c.header('Cache-Control', 'no-store')
    await next()
  })

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
        ...(crypto ? ['auth.login.encrypted'] : []),
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
    // Laravel is the authority for CAPTCHA, credentials and user session.
    return success(c, validated(loginResultSchema, await upstreamRequest(config, fetcher, 'login', { body: checked.data })))
  }
  app.post(`${PREFIX}/auth/login`, async c =>
    runLogin(c, await readLoginRequest(c.req.raw, config.maxRequestBytes)))

  // Experimental opt-in encrypted login: cannot be used without a persisted
  // Docker secret. Not a replacement for TLS or distributed anti-replay.
  if (crypto) {
    app.get(`${PREFIX}/crypto/key`, c => success(c, crypto.publicKey()))
    app.post(`${PREFIX}/secure/auth/login`, async c => {
      const raw = await readLoginRequest(c.req.raw, config.maxRequestBytes)
      const checked = sealedRequestSchema.safeParse(raw)
      if (!checked.success) return failure(c, 'VALIDATION_ERROR', 'Invalid encrypted request', 400)
      const data = await crypto.open(checked.data as SealedRequest)
      return runLogin(c, data)
    })
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

  app.post(`${PREFIX}/orders`, c =>
    failure(c, 'METHOD_NOT_ALLOWED', 'Order creation is not available in Gateway v1 Phase 1', 405))

  app.notFound(c => failure(c, 'NOT_FOUND', 'Gateway route does not exist', 404))
  app.onError((error, c) => {
    if (error instanceof GatewayFailure) {
      // Preserve meaningful upstream 4xx/429 statuses; never turn backend
      // rate-limit or validation errors into misleading gateway 502s.
      const status = ([400, 401, 403, 404, 405, 409, 413, 422, 429, 500, 502, 503, 504]
        .includes(error.status) ? error.status : 502) as ErrorStatus
      return failure(c, error.code, error.message, status)
    }
    // Intentionally do not log request bodies, Authorization or upstream errors.
    return failure(c, 'INTERNAL_ERROR', 'Gateway request failed', 500)
  })
  return app
}
