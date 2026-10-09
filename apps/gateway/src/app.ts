import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { GatewayConfig } from './config/env.js'
import type { CryptoService } from './services/crypto.js'
import { GatewayFailure, type UpstreamFetcher } from './services/upstream.js'
import type { AccountLimiter } from './services/redis-security.js'
import type { LoginProtection } from './middleware/login-protection.js'
import {
  extractSubject,
  RedisRateLimiter,
  resolveRoutePolicy,
} from './middleware/rate-limit.js'
import {
  compileIpAllowlist,
  evaluateRequest,
  forgedHeaderNames,
  hostMatchesAllowlist,
  requiresCredentialProof,
  type CompiledIpAllowlist,
} from './middleware/security.js'
import {
  CONTRACT_VERSION,
  PREFIX,
  PRESERVED_STATUSES,
  failureEnvelope,
  successEnvelope,
  BEARER_PATTERN,
  type ErrorStatus,
} from './middleware/request-context.js'
// PR-D hook — imports
import {
  checkReadiness,
  configureObservability,
  currentRequestTemplate,
  failureReason,
  isLoopbackAddress,
  metricsTokenMatches,
  bearerFrom,
  observabilityState,
  peerAddressOf,
  readinessVerdict,
  routeTemplate,
  statusClass,
  withRequestScope,
  type ObservabilityState,
} from './middleware/observability.js'
import { registerPublicRoutes } from './routes/public.js'
import { registerAccountRoutes } from './routes/account.js'
import { registerUserRoutes } from './routes/user.js'
import { registerOrdersRoutes } from './routes/orders.js'
import type { RouteContext } from './routes/shared.js'
import {
  ROUTE_OPERATIONS,
  activeRouteDefinitions,
  validatePolicies,
  type PolicyEnvironment,
} from './config/policies.js'
import { policyEnforcementMiddleware } from './middleware/policy.js'

/**
 * app.ts — the single Hono instance and the composition root.
 *
 * This file wires middleware and routes together and owns the global error
 * handler. It deliberately holds no business logic: request/response contracts
 * live in contracts/, upstream DTO conversion in adapters/, security policy in
 * middleware/ and HTTP handlers in routes/.
 */

type Bindings = { Bindings: Record<string, never>; Variables: { requestId: string } }
type GatewayContext = RouteContext

export type GatewayPolicy = {
  accountWorkflows?: boolean
  limiter?: AccountLimiter
  /** GW-204: comma-delimited ingress IPs/CIDRs whose proxy headers may be trusted. */
  trustedIngress?: string
  /** GW-204: comma-delimited exact Host values (or *.suffix wildcards). Empty = no check. */
  allowedHosts?: string
  /** GW-202: Redis sliding-window route limiter (IP + account dual dimension). */
  rateLimiter?: RedisRateLimiter
  /** GW-202: Receives limiter decisions (429s, degraded runs) for metrics/alerts. */
  onRateEvent?: (event: {
    policyId: string
    requestId: string
    limited: boolean
    degraded: boolean
    retryAfterHeader: number
    ipCount: number
    subjectCount: number
    /** GW-215: which dimension rejected, when limited. */
    limitedBy?: 'ip' | 'subject' | 'missing_subject'
  }) => void
  /** GW-203: login anti-credential-stuffing (account + IP dual dimension). */
  loginProtection?: LoginProtection
}

export type GatewayRateObserver = NonNullable<GatewayPolicy['onRateEvent']>

/** PR-D hook — observability configuration accepted by createGatewayApp. */
export type GatewayObservability = Partial<ObservabilityState>

/**
 * PR-D hook — install the observability middleware, /metrics and /readyz.
 *
 * This is the ONLY place in the app that knows about metrics and readiness:
 * route handlers stay free of instrumentation, and the endpoints are
 * deliberately mounted OUTSIDE the `/gateway/v1` contract surface so they can
 * never be reached by a theme SDK.
 */
function installObservability(app: Hono<Bindings>, configured: GatewayObservability): void {
  // An explicitly `undefined` field must fall back to the shared default, so an
  // embedder can pass a partial configuration object without crashing.
  const clean: GatewayObservability = {}
  if (configured.metrics) clean.metrics = configured.metrics
  if (configured.logger) clean.logger = configured.logger
  if (configured.probes) clean.probes = configured.probes
  if (configured.metricsToken !== undefined) clean.metricsToken = configured.metricsToken
  const { metrics, logger, probes, metricsToken } = configureObservability(clean)
  // The frozen contract version, published once as a gauge with a bounded label.
  metrics.contractVersion.set({ version: CONTRACT_VERSION }, 1)

  // ---- request/response instrumentation (global, runs for every path) ----
  app.use('*', async (c, next) => {
    const startedAt = process.hrtime.bigint()
    const template = routeTemplate(c.req.path, c.req.method)
    const method = c.req.method.toUpperCase()

    try {
      await withRequestScope(template, next)
    } finally {
      // The response path runs on success, on a handled failure and on an
      // error that reached the global handler: metrics must never be skipped.
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
      const response = c.res as unknown as Response | undefined
      const status = response?.status ?? 500
      const labels = { operation: template, method, status_class: statusClass(status) }
      metrics.requests.inc(labels)
      metrics.requestDuration.observe(labels, durationMs / 1000)
      if (status >= 500) {
        metrics.serverErrors.inc({ operation: template, status_class: statusClass(status) })
      }
      if (status === 429) metrics.rateLimited.inc({ operation: template })
      // Read the id AFTER the dispatch: this middleware is registered before
      // the identity middleware, so the value is only available once the
      // downstream chain has run.
      logger.info('request.completed', {
        requestId: c.get('requestId'), route: template, method, status, durationMs,
        errorCode: errorCodeOf(c),
      })
    }
  })

  // ---- internal endpoints (never part of the public contract surface) ----
  // The /metrics credential is captured per app instance, NOT read from the
  // process-wide observability state on each request: a token-configured
  // deployment and a loopback-only deployment in the same process must not
  // inherit each other's access policy.
  const metricsTokenForThisApp = configured.metricsToken
  app.get('/metrics', async c => {
    const peer = peerAddressOf(c.req.raw)
    const presented = bearerFrom(c.req.header('Authorization'))
    const token = metricsTokenForThisApp
    const denied = token
      ? !metricsTokenMatches(token, presented)
      : !isLoopbackAddress(peer)
    if (denied) {
      // The denial never reveals whether a token is configured, nor anything
      // about the deployment: status and body are identical in both modes.
      logger.warn('metrics.denied', {
        requestId: c.get('requestId'), route: '/metrics', method: 'GET', status: 403,
        reason: token ? 'token' : 'not_loopback',
      })
      return new Response('Forbidden', {
        status: 403,
        headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
      })
    }
    const body = metrics.render()
    logger.info('metrics.served', {
      requestId: c.get('requestId'), route: '/metrics', method: 'GET', status: 200,
    })
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  })

  app.get('/readyz', async c => {
    const snapshot = await checkReadiness(probes)
    // Dependency reachability only: no URLs, ports, versions, keys or config.
    const payload = {
      status: readinessVerdict(snapshot) ? 'ready' : 'degraded',
      dependencies: snapshot,
    }
    logger.info('readiness.reported', {
      requestId: c.get('requestId'), route: '/readyz', method: 'GET', status: 200,
      outcome: payload.status,
    })
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  })
}

/**
 * PR-D hook — associate a gateway error code with the request that produced
 * it. The key is the Hono Context, not the Response: Hono re-wraps the
 * response in `set res`, so a WeakMap keyed on Response would look up a
 * different object than the one `fail()` stored into.
 */
const errorCodes = new WeakMap<object, string>()

function errorCodeOf(holder: object | undefined): string | undefined {
  return holder ? errorCodes.get(holder) : undefined
}

/**
 * PR-D hook — wrap the upstream fetcher with duration, failure and timeout
 * metrics. The failure classification is the frozen error code, never the
 * upstream message: no URL, header or credential is recorded.
 */
function observeFetcher(fetcher: UpstreamFetcher): UpstreamFetcher {
  const { metrics } = observabilityState()
  return async (input, init) => {
    const template = currentRequestTemplate() ?? 'unknown'
    const startedAt = process.hrtime.bigint()
    try {
      const response = await fetcher(input, init)
      metrics.upstreamDuration.observe(
        { operation: template }, Number(process.hrtime.bigint() - startedAt) / 1e9,
      )
      return response
    } catch (error) {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
      const code = error instanceof GatewayFailure ? error.code : undefined
      const status = error instanceof GatewayFailure ? error.status : 500
      const reason = failureReason(code, status)
      metrics.upstreamDuration.observe({ operation: template }, durationMs / 1000)
      metrics.upstreamFailures.inc({ operation: template, reason: reason ?? 'other' })
      if (reason === 'timeout') metrics.upstreamTimeouts.inc({ operation: template })
      observabilityState().logger.error('upstream.failed', {
        route: template, durationMs, errorCode: code, reason,
      })
      throw error
    }
  }
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

function ok(c: GatewayContext, data: unknown, status: 200 | 201 = 200) {
  return c.json(successEnvelope(c.get('requestId'), data, status), status)
}

function fail(c: GatewayContext, code: string, message: string, status: ErrorStatus) {
  const response = c.json(failureEnvelope(c.get('requestId'), code, message), status)
  // PR-D hook: the frozen error code is the ONLY classification that may be
  // logged; it is attached to the context so the observability middleware can
  // enrich the request log without touching the response body or headers.
  errorCodes.set(c, code)
  return response
}

export function createGatewayApp(
  config: GatewayConfig, fetcher: UpstreamFetcher = fetch, crypto?: CryptoService,
  policy: GatewayPolicy = {}, observability: GatewayObservability = {},
) {
  if (policy.accountWorkflows && (!crypto || !policy.limiter)) {
    throw new Error('Account workflows require both encryption and Redis rate limiter')
  }
  // GW-212 / PR-B: the compile-time route policy table is the single source of
  // truth for a route's posture. Validate it BEFORE any Hono instance exists
  // so an illegal combination fails the boot closed instead of silently
  // weakening one route. `secureRegister` / `secureEmailCode` are only live
  // when HPKE, Redis and GATEWAY_ACCOUNT_WORKFLOWS_ENABLED are all present.
  const policyEnvironment: PolicyEnvironment = {
    replayStore: Boolean(crypto),
    hpke: Boolean(crypto),
    redis: Boolean(policy.limiter),
    accountWorkflows: Boolean(policy.accountWorkflows),
  }
  validatePolicies(activeRouteDefinitions(policyEnvironment), policyEnvironment, ROUTE_OPERATIONS)
  const allowlist: CompiledIpAllowlist = compileIpAllowlist(policy.trustedIngress || '')
  const allowedHosts = (policy.allowedHosts || '').split(',').map(s => s.trim()).filter(Boolean)
  // PR-D hook: install the observability bundle (logger, metrics, probes, token)
  // before any middleware so the shared state is already configured.
  const app = new Hono<Bindings>()
  installObservability(app, observability)

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
    // GW-215: the client IP used for every later decision is derived from this
    // single verdict only; no downstream code reads a forwarded header again.
    const peer = raw.__peerIp ?? '0.0.0.0'
    const verdict = evaluateRequest(peer, raw.headers, allowlist)
    if (verdict.reason === 'forged_headers') {
      // Structured, name-only signal: header VALUES are never logged.
      Object.defineProperty(raw, '__clientIp', { value: verdict.clientIp, enumerable: false })
      return fail(c, 'FORBIDDEN', 'Proxy headers are not accepted from this source', 403)
    }
    // Downstream code (rate limiting, audit logs) reads only this sanitized value.
    Object.defineProperty(raw, '__clientIp', { value: verdict.clientIp, enumerable: false })

    const hostHeader = c.req.header('Host')
    if (hostHeader !== undefined) {
      const host = safeHostHeader(hostHeader)
      if (!host || (allowedHosts.length > 0 && !(await hostMatchesAllowlist(host, allowedHosts)))) {
        return fail(c, 'BAD_HOST', 'Host header is not allowed', 403)
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
            ipCount: decision.ipCount, subjectCount: decision.subjectCount,
            limitedBy: decision.limitedBy })
          return fail(c, 'RATE_LIMITED', 'Too many requests', 429)
        }
        if (decision.degraded) {
          // GW-215: a degraded (fail-open) decision must be observable to the
          // client and to alerting — never a silently unlimited request.
          c.header('X-Gateway-Rate-Limit', 'degraded')
          observer?.({ policyId: route.id, requestId, limited: false, degraded: true,
            retryAfterHeader: 0,
            ipCount: decision.ipCount, subjectCount: decision.subjectCount })
        }
      } catch (error) {
        if (error instanceof GatewayFailure) {
          // Fail-closed routes surface 503 (never silently unlimited).
          return fail(c, error.code, error.message, error.status as ErrorStatus)
        }
        return fail(c, 'INTERNAL_ERROR', 'Gateway request failed', 500)
      }
      return next()
    })
  }

  // Exact-origin CORS; never reflect arbitrary origins or issue credential cookies.
  app.use(`${PREFIX}/*`, async (c, next) => {
    const origin = c.req.header('Origin')
    if (origin) {
      if (!config.allowedOrigins.has(origin)) {
        return fail(c, 'ORIGIN_DENIED', 'Origin is not allowed', 403)
      }
      c.header('Access-Control-Allow-Origin', origin)
      c.header('Vary', 'Origin')
      c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
      c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      c.header('Access-Control-Allow-Credentials', 'false')
      c.header('Access-Control-Expose-Headers', 'X-Request-Id')
      c.header('Access-Control-Max-Age', '600')
    }

    // ===================== PR-C hook (GW-215) =====================
    // A MISSING Origin is NOT authorization. CORS only governs what a browser
    // may read cross-origin; it never grants access. On routes that serve
    // account data, an Origin-less request (curl, a script, a proxied replay)
    // must still present a credential, otherwise it is rejected here rather
    // than being treated as implicitly authorized by the absent header. The
    // Bearer *shape* check stays the route layer's job — this only refuses to
    // let "no Origin" stand in for it.
    if (!origin && requiresCredentialProof(c.req.path)) {
      const authorization = c.req.header('Authorization') || ''
      if (!BEARER_PATTERN.test(authorization)) {
        return fail(c, 'UNAUTHORIZED', 'Credential is required for this route', 401)
      }
    }
    // =================== end PR-C hook (GW-215) ===================
    if (c.req.method === 'OPTIONS') return c.body(null, 204)
    await next()
  })

  // ================================ PR-B hook ================================
  // GW-212: the declarative route policy layer. One middleware, registered once
  // between the global baseline above and the route handlers below, enforces
  // auth / request-envelope / limiter posture per the frozen table in
  // config/policies.ts. It is the ONLY place a route's policy is decided, and
  // it runs before every handler, so:
  //   - bearer routes 401 on a missing Authorization header, before any
  //     upstream call;
  //   - hpke routes require a sealed envelope before any upstream call;
  //   - disabledWrite (POST /gateway/v1/orders) answers 405 with zero upstream
  //     calls;
  //   - an unknown path or method is rejected here and can never fall through
  //     to an upstream call.
  // Nothing in this block may be disabled by a header, theme manifest, client
  // capability or database theme config: the table is compile-time readonly.
  // ===========================================================================
  app.use(`${PREFIX}/*`, policyEnforcementMiddleware({
    definitions: activeRouteDefinitions(policyEnvironment),
    maxRequestBytes: config.maxRequestBytes,
  }))

  app.get('/healthz', c => c.json({ status: 'ok', contract: CONTRACT_VERSION }))

  const accountWorkflows = Boolean(policy.accountWorkflows)
  // PR-D hook: wrap the upstream fetcher so every call records duration,
  // timeout and failure metrics under the current route template.
  const observed = observeFetcher(fetcher)
  registerPublicRoutes(app, { config, fetcher: observed, crypto, accountWorkflows })
  registerAccountRoutes(app, {
    config, fetcher: observed, crypto,
    limiter: policy.limiter,
    loginProtection: policy.loginProtection,
    accountWorkflows,
  })
  registerUserRoutes(app, { config, fetcher: observed })
  registerOrdersRoutes(app, { config, fetcher: observed })

  app.notFound(c => fail(c, 'NOT_FOUND', 'Gateway route does not exist', 404))
  app.onError((error, c) => {
    if (error instanceof GatewayFailure) {
      // Preserve meaningful upstream 4xx/429 statuses; never turn backend
      // rate-limit or validation errors into misleading gateway 502s.
      const status = (PRESERVED_STATUSES.includes(error.status) ? error.status : 502) as ErrorStatus
      return fail(c, error.code, error.message, status)
    }
    // Intentionally do not log request bodies, Authorization or upstream errors.
    return fail(c, 'INTERNAL_ERROR', 'Gateway request failed', 500)
  })
  return app
}

export { ok as okResponse, fail as failResponse }
