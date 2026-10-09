/**
 * test/observability.test.ts — GW-214 / PR-D.
 *
 * The contract under test is docs/middleware-architecture.md §2.1 / §6
 * (GW-205 / GW-214): the gateway may only ever emit structured, redacted
 * fields. These tests are written as adversarial probes — they drive real
 * traffic carrying credentials and then grep the captured log sink and the
 * rendered metrics for any trace of the values that were sent.
 */

import { describe, expect, it, vi } from 'vitest'
import { createGatewayApp } from '../src/app.js'
import { loadConfig } from '../src/config/env.js'
import {
  checkReadiness,
  configureObservability,
  createLogger,
  isLoopbackAddress,
  nullLogger,
  observabilityState,
  redact,
  routeTemplate,
  statusClass,
  wouldRedact,
  type LogEntry,
} from '../src/middleware/observability.js'
import { createMetricsRegistry } from '../src/services/metrics.js'
import { GatewayFailure } from '../src/services/upstream.js'

const config = loadConfig({
  TXBOARD_UPSTREAM_URL: 'https://txboard.example/',
  GATEWAY_ALLOWED_ORIGINS: 'https://theme.example',
})

/** Raw values a client sent that must never appear in a log or a metric. */
const SECRETS = {
  email: 'alice.secret@example.test',
  password: 'SuperSecret123!',
  bearer: 'Bearer usertoken_longer_than_eight_chars',
  bearerToken: 'usertoken_longer_than_eight_chars',
  captcha: 'CAPTCHA-TOKEN-VALUE-XYZ',
  emailCode: '654321',
  orderId: '2025-ORDER-SECRET-0001',
  querySecret: 'QUERY-SECRET-VALUE',
}

const LOGIN_BODY = {
  email: SECRETS.email,
  password: SECRETS.password,
  turnstile_token: SECRETS.captcha,
  email_code: SECRETS.emailCode,
}

/** Capture every structured log line the gateway emits during a scenario. */
function captureLogs(): { lines: string[]; entries: () => LogEntry[]; text: () => string } {
  const lines: string[] = []
  return {
    lines,
    entries: () => lines.map(line => JSON.parse(line) as LogEntry),
    text: () => lines.join('\n'),
  }
}

function loggerFor(sink: (line: string) => void) {
  return createLogger({ level: 'debug', sink })
}

/** Upstream answer that satisfies the login adapter. */
const loginPayload = () => ({ status: 'success', data: { auth_data: 'Bearer upstream-token-value-123' } })
/** Upstream answer that satisfies the order-detail adapter. */
const orderPayload = () => ({ status: 'success', data: { trade_no: 'T-1', status: 1 } })

describe('GW-214 structured log redaction', () => {
  it('never logs the password, bearer, captcha, email, codes or request body', async () => {
    const logs = captureLogs()
    const app = createGatewayApp(
      config,
      vi.fn(async () => Response.json(loginPayload())),
      undefined,
      {},
      { logger: loggerFor(logs.lines.push.bind(logs.lines)) },
    )

    const res = await app.request('/gateway/v1/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: SECRETS.bearer,
      },
      body: JSON.stringify(LOGIN_BODY),
    })

    expect(res.status).toBe(200)
    expect(logs.lines.length).toBeGreaterThan(0)

    const blob = logs.text()
    // Every raw credential the client submitted must be absent from the sink.
    for (const secret of [
      SECRETS.email,
      SECRETS.password,
      SECRETS.bearer,
      SECRETS.bearerToken,
      SECRETS.captcha,
      SECRETS.emailCode,
      'turnstile_token',
      'password',
    ]) {
      expect(blob).not.toContain(secret)
    }
    // The request body itself must never be echoed, not even in part.
    expect(blob).not.toContain(JSON.stringify(LOGIN_BODY))
    expect(blob).not.toContain('auth_data')
  })

  it('logs only the allowlisted structured fields, with the requestId present', async () => {
    const logs = captureLogs()
    const app = createGatewayApp(
      config,
      vi.fn(async () => Response.json(loginPayload())),
      undefined,
      {},
      { logger: loggerFor(logs.lines.push.bind(logs.lines)) },
    )

    const res = await app.request('/gateway/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(LOGIN_BODY),
    })

    const entry = logs.entries().find((e: LogEntry) => e.msg === 'request.completed')!
    expect(entry).toBeDefined()
    expect(entry.fields.requestId).toBe(res.headers.get('x-request-id'))
    expect(entry.fields.route).toBe('/gateway/v1/auth/login')
    expect(entry.fields.method).toBe('POST')
    expect(entry.fields.status).toBe(200)
    expect(typeof entry.fields.durationMs).toBe('number')
    // No key outside the allowlist may survive, whatever a call site passes.
    expect(Object.keys(entry.fields).every(key =>
      ['requestId', 'route', 'method', 'status', 'durationMs', 'errorCode', 'event',
        'dependency', 'reason', 'outcome', 'contractVersion', 'upstreamDurationMs',
        'operation', 'action', 'policy', 'state', 'from', 'to', 'attempt', 'limit', 'ageMs',
      ].includes(key),
    )).toBe(true)
  })

  it('records the frozen error code for a failed request without the message', async () => {
    const logs = captureLogs()
    const app = createGatewayApp(
      config,
      vi.fn(async () => Response.json({ status: 'fail' }, { status: 502 })),
      undefined,
      {},
      { logger: loggerFor(logs.lines.push.bind(logs.lines)) },
    )

    await app.request('/gateway/v1/plans')

    const entry = logs.entries().find((e: LogEntry) => e.msg === 'request.completed')!
    expect(entry.fields.errorCode).toBe('UPSTREAM_ERROR')
    expect(logs.text()).not.toContain('Upstream request failed')
  })

  it('redact() drops unknown keys, secrets under safe names and over-long values', () => {
    const out = redact({
      requestId: 'req-123',
      route: '/gateway/v1/orders/:id',
      status: 200,
      durationMs: 12.5,
      errorCode: 'UPSTREAM_ERROR',
      // Unknown keys are dropped outright.
      password: 'SuperSecret123!',
      authorization: 'Bearer usertoken_longer_than_eight',
      body: JSON.stringify(LOGIN_BODY),
      email: SECRETS.email,
      ip: '203.0.113.9',
      // An allowlisted key carrying a secret value is still dropped.
      routeOverride: undefined,
      reason: SECRETS.bearer,
      outcome: SECRETS.email,
      dependency: '203.0.113.9',
      // A bounded number outside the finite range is dropped.
      durationBad: Number.NaN,
    })
    expect(out).toEqual({ requestId: 'req-123', route: '/gateway/v1/orders/:id', status: 200, durationMs: 12.5, errorCode: 'UPSTREAM_ERROR' })
  })

  it('value-level deny patterns catch credentials mis-keyed under safe fields', () => {
    expect(wouldRedact('Bearer usertoken_longer_than_eight')).toBe(true)
    expect(wouldRedact('alice.secret@example.test')).toBe(true)
    expect(wouldRedact('203.0.113.9')).toBe(true)
    expect(wouldRedact('$2b$12$abcdefghijklmnopqrstuv')).toBe(true)
    expect(wouldRedact('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c')).toBe(true)
    expect(wouldRedact('-----BEGIN RSA PRIVATE KEY-----')).toBe(true)
    // Bounded enum labels are fine.
    expect(wouldRedact('timeout')).toBe(false)
    expect(wouldRedact('/gateway/v1/orders/:id')).toBe(false)
  })
})

describe('GW-214 metrics', () => {
  it('counts 2xx, 4xx, 5xx and 429 and records request durations', async () => {
    const metrics = createMetricsRegistry()
    // Scripted in the exact order the upstream is reached: login, order
    // detail, then three public-read outcomes. The invalid-order request is
    // rejected by validation and never consumes a mock.
    const app = createGatewayApp(
      config,
      vi.fn()
        .mockResolvedValueOnce(Response.json(loginPayload()))
        .mockResolvedValueOnce(Response.json(orderPayload()))
        .mockResolvedValueOnce(Response.json({ status: 'fail' }, { status: 502 }))
        .mockResolvedValueOnce(Response.json({ status: 'fail', message: 'Too many attempts' }, { status: 429 }))
        .mockResolvedValueOnce(Response.json({ status: 'fail' }, { status: 500 })),
      undefined,
      {},
      { metrics },
    )

    // 2xx — login
    expect((await app.request('/gateway/v1/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(LOGIN_BODY),
    })).status).toBe(200)
    // 2xx — authenticated order read with a client-chosen order id
    expect((await app.request(`/gateway/v1/orders/${SECRETS.orderId}`, {
      headers: { Authorization: SECRETS.bearer },
    })).status).toBe(200)
    // 4xx — validation failure, never reaches upstream
    expect((await app.request('/gateway/v1/orders/!!bad-id!!', {
      headers: { Authorization: SECRETS.bearer },
    })).status).toBe(400)
    // 5xx — upstream 502 is preserved verbatim
    expect((await app.request('/gateway/v1/plans')).status).toBe(502)
    // 429 — upstream rate limit is preserved verbatim
    expect((await app.request('/gateway/v1/plans')).status).toBe(429)
    // 5xx — an upstream 500 is preserved verbatim (never collapsed to a 4xx)
    expect((await app.request('/gateway/v1/plans')).status).toBe(500)

    const rendered = metrics.render()
    expect(rendered).toContain('txboard_gateway_requests_total{operation="/gateway/v1/auth/login",method="POST",status_class="2xx"} 1')
    expect(rendered).toContain('txboard_gateway_requests_total{operation="/gateway/v1/orders/:id",method="GET",status_class="2xx"} 1')
    expect(rendered).toContain('txboard_gateway_requests_total{operation="/gateway/v1/plans",method="GET",status_class="4xx"} 1')
    expect(rendered).toContain('txboard_gateway_requests_total{operation="/gateway/v1/plans",method="GET",status_class="5xx"} 2')
    // 429 is metered under its own counter in addition to the status class.
    expect(metrics.rateLimited.get({ operation: '/gateway/v1/plans' })).toBe(1)
    // Server errors are counted separately for alerting.
    expect(metrics.serverErrors.get({ operation: '/gateway/v1/plans', status_class: '5xx' })).toBe(2)
    // Histograms carry a sample for every request.
    expect(rendered).toContain('txboard_gateway_request_duration_seconds_count')
    expect(rendered).toContain('txboard_gateway_request_duration_seconds_sum')
    // The upstream-only histogram is recorded for the public reads too.
    expect(rendered).toContain('txboard_gateway_upstream_duration_seconds_count{operation="/gateway/v1/plans"}')
  })

  it('labels the operation with the route TEMPLATE, never the raw path', async () => {
    const metrics = createMetricsRegistry()
    // The status route returns a bare integer, the detail route an object.
    const app = createGatewayApp(
      config,
      vi.fn()
        .mockResolvedValueOnce(Response.json(orderPayload()))
        .mockResolvedValueOnce(Response.json(orderPayload()))
        .mockResolvedValueOnce(Response.json(orderPayload()))
        .mockResolvedValueOnce(Response.json({ status: 'success', data: 1 })),
      undefined,
      {},
      { metrics },
    )

    for (const id of [SECRETS.orderId, 'ANOTHER-ORDER-ID', 'third-order-id-3']) {
      expect((await app.request(`/gateway/v1/orders/${id}`, {
        headers: { Authorization: SECRETS.bearer },
      })).status).toBe(200)
    }

    const rendered = metrics.render()
    // A single series, not one per identifier.
    expect(rendered).toContain('txboard_gateway_requests_total{operation="/gateway/v1/orders/:id",method="GET",status_class="2xx"} 3')
    for (const id of [SECRETS.orderId, 'ANOTHER-ORDER-ID', 'third-order-id-3']) {
      expect(rendered).not.toContain(id)
    }
    // The status route collapses the same way.
    expect((await app.request(`/gateway/v1/orders/${SECRETS.orderId}/status`, {
      headers: { Authorization: SECRETS.bearer },
    })).status).toBe(200)
    expect(metrics.render()).toContain('operation="/gateway/v1/orders/:id/status"')
  })

  it('routeTemplate collapses dynamic segments and bounds unknown paths', () => {
    expect(routeTemplate('/gateway/v1/orders/2025-ORDER-0001', 'GET')).toBe('/gateway/v1/orders/:id')
    expect(routeTemplate('/gateway/v1/orders/2025-ORDER-0001/status', 'GET')).toBe('/gateway/v1/orders/:id/status')
    expect(routeTemplate('/gateway/v1/plans', 'GET')).toBe('/gateway/v1/plans')
    expect(routeTemplate('/gateway/v1/plans/', 'GET')).toBe('/gateway/v1/plans')
    // A scanner cannot mint arbitrary series: unknown paths collapse.
    expect(routeTemplate('/etc/passwd', 'GET')).toBe('/unmatched')
    expect(routeTemplate('/gateway/v1/orders/a/b/c/d', 'GET')).toBe('/unmatched')
    // Method is part of the identity.
    expect(routeTemplate('/gateway/v1/orders', 'POST')).toBe('/gateway/v1/orders')
    expect(routeTemplate('/gateway/v1/orders', 'GET')).toBe('/gateway/v1/orders')
  })

  it('classifies statuses into a bounded enum', () => {
    expect(statusClass(200)).toBe('2xx')
    expect(statusClass(204)).toBe('2xx')
    expect(statusClass(301)).toBe('3xx')
    expect(statusClass(404)).toBe('4xx')
    expect(statusClass(429)).toBe('4xx')
    expect(statusClass(500)).toBe('5xx')
    expect(statusClass(503)).toBe('5xx')
  })

  it('renders valid Prometheus text with no user-data labels', async () => {
    const metrics = createMetricsRegistry()
    const app = createGatewayApp(
      config,
      vi.fn(async () => Response.json(orderPayload())),
      undefined,
      {},
      { metrics },
    )
    await app.request(`/gateway/v1/orders/${SECRETS.orderId}`, {
      headers: { Authorization: SECRETS.bearer },
    })
    await app.request(`/gateway/v1/orders/${SECRETS.orderId}?secret=${SECRETS.querySecret}`, {
      headers: { Authorization: SECRETS.bearer },
    })

    const text = metrics.render()
    expect(text.endsWith('\n')).toBe(true)
    for (const line of text.split('\n')) {
      if (!line || line.startsWith('#')) continue
      // Every sample is `name{labels} value` or `name value`.
      expect(line).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})?\s+-?[\d.]+(e[+-]?\d+)?$/)
    }
    expect(text).toContain('# HELP ')
    expect(text).toContain('# TYPE txboard_gateway_requests_total counter')
    // No raw path, query string or credential may reach a label.
    for (const forbidden of [SECRETS.orderId, SECRETS.querySecret, SECRETS.bearerToken, 'secret=']) {
      expect(text).not.toContain(forbidden)
    }
  })
})

describe('GW-214 /metrics access control', () => {
  it('rejects a non-loopback remote without a token and serves with the token', async () => {
    const metrics = createMetricsRegistry()
    const lines: string[] = []
    const app = createGatewayApp(
      config,
      vi.fn(),
      undefined,
      {},
      { metrics, metricsToken: 'metrics-secret-token', logger: loggerFor(l => lines.push(l)) },
    )

    // A remote peer address, injected by the @hono/node-server trust hook.
    const remote = new Request('http://gateway.internal/metrics')
    Object.defineProperty(remote, '__peerIp', { value: '203.0.113.9', enumerable: false })

    const denied = await app.fetch(remote)
    expect(denied.status).toBe(403)
    expect(denied.headers.get('cache-control')).toBe('no-store')

    // The same request, presented with the correct bearer token, is served.
    const ok = await app.request('http://gateway.internal/metrics', {
      headers: { Authorization: 'Bearer metrics-secret-token' },
    })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toContain('text/plain')
    expect(await ok.text()).toContain('txboard_gateway_contract_version')
  })

  it('never serves metrics to a remote peer, whatever the header claims', async () => {
    const app = createGatewayApp(
      config,
      vi.fn(),
      undefined,
      {},
      { metrics: createMetricsRegistry(), metricsToken: 'metrics-secret-token' },
    )
    // A forged loopback claim must not unlock the endpoint: the guard reads the
    // real peer address, never a client-controlled header. A remote peer that
    // DOES hold the valid token is still served — the token is the credential,
    // not the address — but the address claim itself is ignored.
    const forged = new Request('http://gateway.internal/metrics', {
      headers: { Authorization: 'Bearer metrics-secret-token', 'x-forwarded-for': '127.0.0.1' },
    })
    Object.defineProperty(forged, '__peerIp', { value: '203.0.113.9', enumerable: false })
    expect((await app.fetch(forged)).status).toBe(200)

    // A remote peer without the token is denied.
    const remote = new Request('http://gateway.internal/metrics')
    Object.defineProperty(remote, '__peerIp', { value: '203.0.113.9', enumerable: false })
    expect((await app.fetch(remote)).status).toBe(403)

    // A wrong token is denied.
    const wrong = new Request('http://gateway.internal/metrics', {
      headers: { Authorization: 'Bearer wrong-token' },
    })
    Object.defineProperty(wrong, '__peerIp', { value: '203.0.113.9', enumerable: false })
    expect((await app.fetch(wrong)).status).toBe(403)

    // A remote peer that presents the valid token is served: in token mode the
    // token is the credential and the peer address is irrelevant.
    const tokenRemote = new Request('http://gateway.internal/metrics', {
      headers: { Authorization: 'Bearer metrics-secret-token' },
    })
    Object.defineProperty(tokenRemote, '__peerIp', { value: '203.0.113.9', enumerable: false })
    expect((await app.fetch(tokenRemote)).status).toBe(200)

    // A forged proxy header from an untrusted peer is dropped by GW-204 before
    // it can ever reach the metrics guard, so it cannot confuse the verdict.
    const spoofedXff = new Request('http://gateway.internal/metrics')
    spoofedXff.headers.set('x-forwarded-for', '127.0.0.1')
    Object.defineProperty(spoofedXff, '__peerIp', { value: '203.0.113.9', enumerable: false })
    expect((await app.fetch(spoofedXff)).status).toBe(403)
  })

  it('loopback-only mode serves loopback and rejects everything else', async () => {
    const app = createGatewayApp(
      config,
      vi.fn(),
      undefined,
      {},
      { metrics: createMetricsRegistry() },
    )
    // A genuine loopback peer is served in token-less mode.
    const loopback = new Request('http://gateway.internal/metrics')
    Object.defineProperty(loopback, '__peerIp', { value: '127.0.0.1', enumerable: false })
    const res = await app.fetch(loopback)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('txboard_gateway_requests_total')

    // A remote peer is denied, and a request with no peer address fails closed.
    const remote = new Request('http://gateway.internal/metrics')
    Object.defineProperty(remote, '__peerIp', { value: '203.0.113.9', enumerable: false })
    expect((await app.fetch(remote)).status).toBe(403)
    expect((await app.request('http://gateway.internal/metrics')).status).toBe(403)
  })

  it('a wrong token, an empty token and a missing header are all denied', async () => {
    const app = createGatewayApp(
      config,
      vi.fn(),
      undefined,
      {},
      { metrics: createMetricsRegistry(), metricsToken: 'metrics-secret-token' },
    )
    const remote = 'http://gateway.internal/metrics'
    expect((await app.request(remote)).status).toBe(403)
    expect((await app.request(remote, { headers: { Authorization: '' } })).status).toBe(403)
    expect((await app.request(remote, { headers: { Authorization: 'Bearer ' } })).status).toBe(403)
    expect((await app.request(remote, { headers: { Authorization: 'Bearer wrong-token' } })).status).toBe(403)
  })

  it('isLoopbackAddress handles IPv4, IPv6 and mapped forms and rejects spoofs', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('127.0.0.53')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('localhost')).toBe(true)
    expect(isLoopbackAddress('203.0.113.9')).toBe(false)
    expect(isLoopbackAddress('0.0.0.0')).toBe(false)
    expect(isLoopbackAddress('::')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
    // A mapped remote address must not pass as loopback.
    expect(isLoopbackAddress('::ffff:203.0.113.9')).toBe(false)
  })

  it('an unset token is never satisfied by an empty bearer header', async () => {
    const { metricsTokenMatches } = await import('../src/middleware/observability.js')
    expect(metricsTokenMatches(undefined, undefined)).toBe(false)
    expect(metricsTokenMatches(undefined, '')).toBe(false)
    expect(metricsTokenMatches('', 'anything')).toBe(false)
    expect(metricsTokenMatches('tok', undefined)).toBe(false)
    expect(metricsTokenMatches('tok', 'tok')).toBe(true)
    expect(metricsTokenMatches('tok', 'TOK')).toBe(false)
    expect(metricsTokenMatches('tok', 'tok-longer')).toBe(false)
  })
})

describe('GW-214 /readyz', () => {
  it('reports dependency state with no config, secret or URL', async () => {
    const metrics = createMetricsRegistry()
    const lines: string[] = []
    const app = createGatewayApp(
      config,
      vi.fn(),
      undefined,
      {},
      {
        metrics,
        logger: loggerFor(l => lines.push(l)),
        probes: { redis: () => 'up', hpke: () => 'up', upstream: () => 'up' },
      },
    )

    const res = await app.request('http://gateway.internal/readyz')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const payload = await res.json() as { status: string; dependencies: Record<string, string> }
    expect(payload.status).toBe('ready')
    expect(payload.dependencies).toEqual({ redis: 'up', hpke: 'up', upstream: 'up' })

    const blob = JSON.stringify(payload) + lines.join('\n')
    for (const forbidden of [
      'txboard.example', 'https://', 'redis://', '6379', 'localhost',
      SECRETS.bearerToken, 'password', 'GATEWAY_', 'metricsToken', 'REDIS_URL', 'UPSTREAM_URL',
    ]) {
      expect(blob).not.toContain(forbidden)
    }
    // The only strings in the payload are the readiness verdict and the three
    // closed dependency states — nothing else may appear.
    expect(Object.keys(payload.dependencies).sort()).toEqual(['hpke', 'redis', 'upstream'])
    for (const state of Object.values(payload.dependencies)) {
      expect(['up', 'down', 'unknown']).toContain(state)
    }
  })

  it('degrades when a dependency is down and stays silent about the cause', async () => {
    const app = createGatewayApp(
      config,
      vi.fn(),
      undefined,
      {},
      {
        metrics: createMetricsRegistry(),
        probes: {
          redis: () => 'down',
          hpke: () => 'up',
          // A probe that throws is treated as down, never as an exception.
          upstream: () => { throw new Error('redis://gateway-redis:6379 ECONNREFUSED') },
        },
      },
    )

    const res = await app.request('http://gateway.internal/readyz')
    const payload = await res.json() as { status: string; dependencies: Record<string, string> }
    expect(payload.status).toBe('degraded')
    expect(payload.dependencies).toEqual({ redis: 'down', hpke: 'up', upstream: 'down' })
    expect(JSON.stringify(payload)).not.toContain('ECONNREFUSED')
    expect(JSON.stringify(payload)).not.toContain('6379')
  })

  it('checkReadiness bounds probe time and reports unknown for absent probes', async () => {
    const snapshot = await checkReadiness({})
    expect(snapshot).toEqual({ redis: 'unknown', hpke: 'unknown', upstream: 'unknown' })

    const hanging = await checkReadiness(
      { redis: () => new Promise(() => {}) },
      20,
    )
    expect(hanging.redis).toBe('unknown')
  })

  it('readinessVerdict only blocks on an explicit down', async () => {
    const { readinessVerdict } = await import('../src/middleware/observability.js')
    expect(readinessVerdict({ redis: 'up', hpke: 'up', upstream: 'up' })).toBe(true)
    expect(readinessVerdict({ redis: 'unknown', hpke: 'unknown', upstream: 'unknown' })).toBe(true)
    expect(readinessVerdict({ redis: 'down', hpke: 'up', upstream: 'up' })).toBe(false)
    expect(readinessVerdict({ redis: 'up', hpke: 'down', upstream: 'up' })).toBe(false)
    expect(readinessVerdict({ redis: 'up', hpke: 'up', upstream: 'down' })).toBe(false)
  })
})

describe('GW-214 request identity', () => {
  it('echoes a server-generated X-Request-Id, ignoring any client-supplied value', async () => {
    const metrics = createMetricsRegistry()
    const lines: string[] = []
    const app = createGatewayApp(
      config,
      vi.fn(async () => Response.json(loginPayload())),
      undefined,
      {},
      { metrics, logger: loggerFor(l => lines.push(l)) },
    )

    const spoofed = 'client-supplied-request-id-1234567890'
    const res = await app.request('/gateway/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': spoofed },
      body: JSON.stringify(LOGIN_BODY),
    })

    const echoed = res.headers.get('x-request-id')
    expect(echoed).toBeTruthy()
    // The server id wins: the client cannot choose the correlation value.
    expect(echoed).not.toBe(spoofed)
    expect(echoed).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    // The envelope and the log line carry the same id, so support can correlate.
    const envelope = await res.json() as { meta: { requestId: string } }
    expect(envelope.meta.requestId).toBe(echoed)
    const entry = lines.map(l => JSON.parse(l) as LogEntry).find(e => e.msg === 'request.completed')!
    expect(entry.fields.requestId).toBe(echoed)
    // Two requests never share an id.
    const second = await app.request('/healthz')
    expect(second.headers.get('x-request-id')).not.toBe(echoed)
  })
})

describe('GW-214 upstream failure observability', () => {
  it('observes an upstream timeout in metrics and structured logs', async () => {
    const metrics = createMetricsRegistry()
    const lines: string[] = []
    const app = createGatewayApp(
      config,
      vi.fn(async () => { throw new GatewayFailure('UPSTREAM_UNAVAILABLE', 504, 'Upstream request timed out') }),
      undefined,
      {},
      { metrics, logger: loggerFor(l => lines.push(l)) },
    )

    const res = await app.request('/gateway/v1/plans')
    expect(res.status).toBe(504)

    const text = metrics.render()
    // 504 is classified as a timeout, a server error and an upstream failure.
    expect(metrics.upstreamTimeouts.get({ operation: '/gateway/v1/plans' })).toBe(1)
    expect(text).toContain('txboard_gateway_upstream_timeouts_total{operation="/gateway/v1/plans"} 1')
    expect(metrics.upstreamFailures.get({ operation: '/gateway/v1/plans', reason: 'timeout' })).toBe(1)
    expect(metrics.serverErrors.get({ operation: '/gateway/v1/plans', status_class: '5xx' })).toBe(1)
    expect(text).toContain('txboard_gateway_upstream_duration_seconds_count')

    const logText = lines.join('\n')
    expect(logText).toContain('upstream.failed')
    expect(logText).toContain('"reason":"timeout"')
    // The upstream message is never logged.
    expect(logText).not.toContain('Upstream request timed out')
  })

  it('observes an upstream connection failure as a distinct reason', async () => {
    const metrics = createMetricsRegistry()
    const app = createGatewayApp(
      config,
      vi.fn(async () => { throw new GatewayFailure('UPSTREAM_UNAVAILABLE', 502, 'Upstream connection failed') }),
      undefined,
      {},
      { metrics },
    )

    expect((await app.request('/gateway/v1/plans')).status).toBe(502)
    expect(metrics.upstreamFailures.get({ operation: '/gateway/v1/plans', reason: 'connection' })).toBe(1)
    expect(metrics.upstreamTimeouts.get({ operation: '/gateway/v1/plans' })).toBe(0)
  })

  it('observes a 503 dependency_unavailable, a 502 upstream_error and a 429 distinctly', async () => {
    const metrics = createMetricsRegistry()
    const app = createGatewayApp(
      config,
      vi.fn()
        // A dependency that is down surfaces as UPSTREAM_UNAVAILABLE 503.
        .mockImplementationOnce(async () => {
          throw new GatewayFailure('UPSTREAM_UNAVAILABLE', 503, 'Upstream temporarily unavailable')
        })
        // An upstream application failure surfaces as UPSTREAM_ERROR 502.
        .mockImplementationOnce(async () => {
          throw new GatewayFailure('UPSTREAM_ERROR', 502, 'Upstream request failed')
        })
        // A genuine upstream 429 is preserved verbatim.
        .mockResolvedValueOnce(Response.json({ status: 'fail', message: 'Too many attempts' }, { status: 429 })),
      undefined,
      {},
      { metrics },
    )

    expect((await app.request('/gateway/v1/plans')).status).toBe(503)
    expect(metrics.upstreamFailures.get({ operation: '/gateway/v1/plans', reason: 'dependency_unavailable' })).toBe(1)

    expect((await app.request('/gateway/v1/plans')).status).toBe(502)
    expect(metrics.upstreamFailures.get({ operation: '/gateway/v1/plans', reason: 'upstream_error' })).toBe(1)
    // A 502 upstream error is not counted as a timeout.
    expect(metrics.upstreamTimeouts.get({ operation: '/gateway/v1/plans' })).toBe(0)

    expect((await app.request('/gateway/v1/plans')).status).toBe(429)
    expect(metrics.rateLimited.get({ operation: '/gateway/v1/plans' })).toBe(1)
    expect(metrics.rateLimited.get({ operation: '/gateway/v1/plans' })).toBe(1)
  })

  it('observes a 429 raised by the route limiter with the resolved requestId', async () => {
    const metrics = createMetricsRegistry()
    const lines: string[] = []
    const limiter = {
      check: vi.fn(async () => { throw new GatewayFailure('RATE_LIMITED', 429, 'Too many requests') }),
    }
    const app = createGatewayApp(
      config,
      vi.fn(async () => Response.json(orderPayload())),
      undefined,
      { rateLimiter: limiter as never },
      { metrics, logger: loggerFor(l => lines.push(l)) },
    )

    const res = await app.request('/gateway/v1/plans')
    expect(res.status).toBe(429)
    expect(metrics.rateLimited.get({ operation: '/gateway/v1/plans' })).toBe(1)
    const entry = lines.map(l => JSON.parse(l) as LogEntry).find(e => e.msg === 'request.completed')!
    expect(entry.fields.errorCode).toBe('RATE_LIMITED')
    expect(entry.fields.requestId).toBe(res.headers.get('x-request-id'))
  })

  it('keeps the failureReason vocabulary closed and bounded', async () => {
    const { failureReason } = await import('../src/middleware/observability.js')
    expect(failureReason('UPSTREAM_UNAVAILABLE', 504)).toBe('timeout')
    expect(failureReason('UPSTREAM_UNAVAILABLE', 503)).toBe('dependency_unavailable')
    expect(failureReason('UPSTREAM_UNAVAILABLE', 502)).toBe('connection')
    expect(failureReason('UPSTREAM_ERROR', 502)).toBe('upstream_error')
    expect(failureReason('PAYLOAD_TOO_LARGE', 413)).toBe('payload_too_large')
    expect(failureReason(undefined, 200)).toBeUndefined()
    expect(failureReason('SOMETHING_NEW', 500)).toBe('other')
  })
})

describe('GW-214 contract surface is unchanged', () => {
  it('/healthz still returns the exact frozen body', async () => {
    const app = createGatewayApp(config, vi.fn())
    const res = await app.request('/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok', contract: '1' })
  })

  it('internal endpoints are not mounted under the /gateway/v1 contract prefix', async () => {
    const app = createGatewayApp(
      config,
      vi.fn(),
      undefined,
      {},
      { metrics: createMetricsRegistry() },
    )
    expect((await app.request('/gateway/v1/metrics')).status).toBe(404)
    expect((await app.request('/gateway/v1/readyz')).status).toBe(404)
  })

  it('observability state is a stable, reconfigurable singleton', () => {
    const registry = createMetricsRegistry()
    const before = observabilityState()
    const after = configureObservability({ metrics: registry, metricsToken: 'tok' })
    expect(after).toBe(before)
    expect(after.metrics).toBe(registry)
    expect(after.metricsToken).toBe('tok')
    // A logger is always present, so no call site can crash on a missing sink.
    expect(typeof after.logger.info).toBe('function')
    configureObservability({ metrics: createMetricsRegistry(), logger: nullLogger(), probes: {}, metricsToken: undefined })
  })
})
