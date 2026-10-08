import { randomUUID } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import type { GatewayConfig } from './env.js'
import { asRecord, boundedJson, GatewayFailure, upstreamRequest, type UpstreamFetcher } from './upstream.js'

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

function success(c: GatewayContext, data: unknown, status: 200 | 201 = 200) {
  return c.json({ ok: true, data, meta: { version: VERSION, requestId: c.get('requestId') } }, status)
}

type ErrorStatus = 400 | 401 | 403 | 404 | 405 | 413 | 422 | 429 | 500 | 502 | 503 | 504

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

export function createGatewayApp(config: GatewayConfig, fetcher: UpstreamFetcher = fetch) {
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
    const data = asRecord(await upstreamRequest(config, fetcher, 'guestConfig'))
    const theme = publicTheme(data)
    return success(c, {
      site: {
        name: typeof data.app_name === 'string' ? data.app_name : 'TXBoard',
        description: typeof data.app_description === 'string' ? data.app_description : '',
        url: typeof data.app_url === 'string' ? data.app_url : '',
        logo: typeof data.logo === 'string' ? data.logo : '',
      },
      theme,
      capabilities: ['auth.login', 'user.profile', 'plans.list', 'orders.list', 'theme.config'],
    })
  })
  app.get(`${PREFIX}/theme/config`, async c =>
    success(c, publicTheme(await upstreamRequest(config, fetcher, 'guestConfig'))))
  app.get(`${PREFIX}/plans`, async c =>
    success(c, await upstreamRequest(config, fetcher, 'guestPlans')))

  app.post(`${PREFIX}/auth/login`, async c => {
    const raw = await readLoginRequest(c.req.raw, config.maxRequestBytes)
    const checked = loginSchema.safeParse(raw)
    if (!checked.success) return failure(c, 'VALIDATION_ERROR', 'Invalid login data', 400)
    // CAPTCHA is passed to Laravel, which remains its only decision maker.
    return success(c, await upstreamRequest(config, fetcher, 'login', { body: checked.data }))
  })

  app.get(`${PREFIX}/user/profile`, async c => {
    const auth = authBearer(c)
    if (!auth) return failure(c, 'UNAUTHORIZED', 'Bearer token required', 401)
    return success(c, await upstreamRequest(config, fetcher, 'userProfile', { auth }))
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
    return success(c, await upstreamRequest(config, fetcher, 'userOrders', {
      auth, status: status === undefined ? undefined : Number(status),
    }))
  })
  app.post(`${PREFIX}/orders`, c =>
    failure(c, 'METHOD_NOT_ALLOWED', 'Order creation is not available in Gateway v1 Phase 1', 405))

  app.notFound(c => failure(c, 'NOT_FOUND', 'Gateway route does not exist', 404))
  app.onError((error, c) => {
    if (error instanceof GatewayFailure) {
      // Preserve meaningful upstream 4xx/429 statuses; never turn backend
      // rate-limit or validation errors into misleading gateway 502s.
      const status = ([400, 401, 403, 404, 405, 413, 422, 429, 500, 502, 503, 504]
        .includes(error.status) ? error.status : 502) as ErrorStatus
      return failure(c, error.code, error.message, status)
    }
    // Intentionally do not log request bodies, Authorization or upstream errors.
    return failure(c, 'INTERNAL_ERROR', 'Gateway request failed', 500)
  })
  return app
}
