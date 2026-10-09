/**
 * middleware/observability.ts — structured redacted logging, metrics and the
 * internal readiness probe (GW-214 / PR-D).
 *
 * HARD RULE (docs/middleware-architecture.md §2.1 / §6, GW-205 / GW-214):
 * only bounded, non-user-data fields may be emitted — requestId, route
 * TEMPLATE, HTTP status, duration, error code and closed enum labels. NEVER
 * Authorization headers, passwords, tokens, CAPTCHA values, emails, request or
 * response bodies, raw query strings or full IP addresses.
 *
 * The implementation is allowlist-first: `redact()` keeps only keys that are
 * explicitly safe, so a new log call site cannot accidentally widen the
 * surface. Anything unrecognized is dropped rather than guessed.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { timingSafeEqual } from 'node:crypto'
import { createMetricsRegistry, type MetricsRegistry } from '../services/metrics.js'

/* ------------------------------------------------------------------ *
 * Structured logger with allowlist redaction
 * ------------------------------------------------------------------ */

/** Log severities, ordered from most to least verbose. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 }

/** A single captured log entry as it reached the sink. */
export type LogEntry = {
  level: Exclude<LogLevel, 'silent'>
  msg: string
  /** Redacted, allowlisted structured fields. */
  fields: Record<string, string | number | boolean>
}

export type LoggerSink = (line: string) => void

export type LoggerOptions = {
  /** Minimum severity emitted. Defaults to `info`. */
  level?: LogLevel
  /** Receives the serialized JSON line. Defaults to the level-mapped console. */
  sink?: LoggerSink
}

/**
 * Keys that may survive redaction, with their permitted value shape.
 * Everything not listed here is dropped — this list is the whole contract.
 */
const SAFE_FIELDS: Readonly<Record<string, 'string' | 'number' | 'boolean'>> = {
  requestId: 'string',
  // Route template with path params collapsed, e.g. /gateway/v1/orders/:id.
  route: 'string',
  method: 'string',
  status: 'number',
  durationMs: 'number',
  errorCode: 'string',
  // Bounded enum labels.
  event: 'string',
  dependency: 'string',
  reason: 'string',
  outcome: 'string',
  contractVersion: 'string',
  upstreamDurationMs: 'number',
  // Bounded enumerations emitted by the resilience layer (GW-206): upstream
  // operation names, safety-store actions, breaker states. All are closed
  // vocabularies, so they can never widen into user data.
  operation: 'string',
  action: 'string',
  policy: 'string',
  state: 'string',
  from: 'string',
  to: 'string',
  // Bounded numeric details of a degradation event.
  attempt: 'number',
  limit: 'number',
  ageMs: 'number',
}

/**
 * Value-level deny patterns. A string value matching any of these is dropped
 * even when its key is allowlisted, so a mis-keyed secret can never reach the
 * sink.
 */
const VALUE_DENY: readonly RegExp[] = [
  /^authorization\b/i,
  /^bearer\s+/i,
  /^basic\s+/i,
  /^[^@\s]+@[^@\s]+\.[^@\s]+$/,              // email addresses
  /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,     // full IPv4
  /^[0-9a-f]{0,4}:[0-9a-f]{0,4}:/i,           // full IPv6
  /^\$2[aby]\$\d{2}\$/,                       // bcrypt
  /^(?:[A-Za-z0-9_-]{20,})\.(?:[A-Za-z0-9_-]{20,})\.(?:[A-Za-z0-9_-]{20,})$/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]

function valueIsForbidden(value: string): boolean {
  return VALUE_DENY.some(pattern => pattern.test(value.trim()))
}

function sanitizeValue(
  shape: 'string' | 'number' | 'boolean', value: unknown,
): string | number | boolean | undefined {
  if (shape === 'number') {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }
  if (shape === 'boolean') {
    return typeof value === 'boolean' ? value : undefined
  }
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 256) return undefined
  if (valueIsForbidden(trimmed)) return undefined
  return trimmed
}

/**
 * Allowlist redaction.
 *
 * Accepts arbitrary input (a header map, a query object, an error, a body
 * fragment) and returns ONLY the explicitly safe fields. Objects are never
 * passed through wholesale, so a nested credential cannot survive inside an
 * `extra` bucket.
 */
export function redact(input: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out
  for (const [rawKey, value] of Object.entries(input as Record<string, unknown>)) {
    const shape = SAFE_FIELDS[rawKey]
    if (!shape) continue
    const safe = sanitizeValue(shape, value)
    if (safe !== undefined) out[rawKey] = safe
  }
  return out
}

/** Whether an arbitrary string would be dropped by redaction (test helper). */
export function wouldRedact(value: string): boolean {
  return valueIsForbidden(value)
}

const DEFAULT_SINKS: Record<Exclude<LogLevel, 'silent'>, LoggerSink> = {
  debug: line => console.debug(line),
  info: line => console.info(line),
  warn: line => console.warn(line),
  error: line => console.error(line),
}

/** Structured JSON logger. Only redacted, allowlisted fields are ever emitted. */
export class Logger {
  private readonly level: LogLevel
  private readonly sink: LoggerSink

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? 'info'
    this.sink = options.sink ?? DEFAULT_SINKS[this.level === 'silent' ? 'info' : this.level]
  }

  private emit(level: Exclude<LogLevel, 'silent'>, msg: string, fields: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return
    const entry: LogEntry = { level, msg, fields: redact(fields) }
    this.sink(JSON.stringify(entry))
  }

  debug(msg: string, fields?: unknown): void { this.emit('debug', msg, fields) }
  info(msg: string, fields?: unknown): void { this.emit('info', msg, fields) }
  warn(msg: string, fields?: unknown): void { this.emit('warn', msg, fields) }
  error(msg: string, fields?: unknown): void { this.emit('error', msg, fields) }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new Logger(options)
}

/** A logger that discards everything — for embedders and unit tests. */
export function nullLogger(): Logger {
  return new Logger({ level: 'silent' })
}

/* ------------------------------------------------------------------ *
 * Route templates
 * ------------------------------------------------------------------ */

/**
 * Collapse a request path into its route template. Dynamic segments become
 * `:id` so an order id, a user id or any other client-chosen value can never
 * appear in a metric label or a log line.
 *
 * The table is static and bounded: an unknown path is reported as
 * `/unmatched` rather than echoed, which keeps label cardinality fixed and
 * stops a scanner from minting series with arbitrary paths.
 */
const ROUTE_TEMPLATES: ReadonlyArray<readonly [string, string]> = [
  ['GET', '/gateway/v1/plans'],
  ['GET', '/gateway/v1/bootstrap'],
  ['GET', '/gateway/v1/theme/config'],
  ['GET', '/gateway/v1/crypto/key'],
  ['GET', '/gateway/v1/user/profile'],
  ['GET', '/gateway/v1/user/subscription/summary'],
  ['GET', '/gateway/v1/notices'],
  ['GET', '/gateway/v1/dashboard/stats'],
  ['GET', '/gateway/v1/payments'],
  ['GET', '/gateway/v1/orders'],
  ['GET', '/gateway/v1/orders/:id'],
  ['GET', '/gateway/v1/orders/:id/status'],
  ['POST', '/gateway/v1/orders'],
  ['POST', '/gateway/v1/auth/login'],
  ['POST', '/gateway/v1/secure/auth/login'],
  ['POST', '/gateway/v1/secure/auth/register'],
  ['POST', '/gateway/v1/secure/auth/email-code'],
  ['GET', '/metrics'],
  ['GET', '/readyz'],
  ['GET', '/healthz'],
]

const TEMPLATE_CANDIDATES = ROUTE_TEMPLATES
  .map(([method, template]) => ({ method, template, segments: template.split('/') }))
  .sort((a, b) => b.segments.length - a.segments.length)

export function routeTemplate(path: string, method = 'GET'): string {
  const clean = path.split('?')[0]!.replace(/\/+$/, '') || '/'
  const segments = clean.split('/')
  const upper = method.toUpperCase()
  for (const candidate of TEMPLATE_CANDIDATES) {
    if (candidate.method !== upper) continue
    if (candidate.segments.length !== segments.length) continue
    let matched = true
    for (let i = 0; i < segments.length; i++) {
      const pattern = candidate.segments[i]!
      const actual = segments[i]!
      if (pattern.startsWith(':')) continue
      if (pattern !== actual) { matched = false; break }
    }
    if (matched) return candidate.template
  }
  return '/unmatched'
}

/* ------------------------------------------------------------------ *
 * Status classes
 * ------------------------------------------------------------------ */

export function statusClass(status: number): string {
  if (status >= 200 && status < 300) return '2xx'
  if (status >= 300 && status < 400) return '3xx'
  if (status >= 400 && status < 500) return '4xx'
  if (status >= 500 && status < 600) return '5xx'
  return 'unknown'
}

/**
 * Closed vocabulary of failure reasons derived from the frozen error codes.
 * Used as the `reason` label of upstream failure metrics and log lines.
 */
export type FailureReason =
  | 'timeout' | 'connection' | 'dependency_unavailable'
  | 'upstream_error' | 'payload_too_large' | 'other'

export function failureReason(errorCode: string | undefined, status: number): FailureReason | undefined {
  if (!errorCode) return undefined
  if (errorCode === 'UPSTREAM_UNAVAILABLE') {
    if (status === 504) return 'timeout'
    if (status === 503) return 'dependency_unavailable'
    if (status === 502) return 'connection'
    return 'other'
  }
  if (errorCode === 'PAYLOAD_TOO_LARGE') return 'payload_too_large'
  if (errorCode === 'UPSTREAM_ERROR') return 'upstream_error'
  return 'other'
}

/* ------------------------------------------------------------------ *
 * Request scope (upstream latency labelling)
 * ------------------------------------------------------------------ */

type RequestScope = { template: string }
const requestScope = new AsyncLocalStorage<RequestScope>()

/** Run `fn` with the current route template visible to upstream timing wrappers. */
export function withRequestScope<T>(template: string, fn: () => T): T {
  return requestScope.run({ template }, fn)
}

/** The route template of the request currently in flight, if any. */
export function currentRequestTemplate(): string | undefined {
  return requestScope.getStore()?.template
}

/* ------------------------------------------------------------------ *
 * Readiness
 * ------------------------------------------------------------------ */

export type DependencyState = 'up' | 'down' | 'unknown'

export type DependencySnapshot = {
  redis: DependencyState
  hpke: DependencyState
  upstream: DependencyState
}

/**
 * Readiness dependency probes, supplied by the composition root. Each probe
 * returns only a bounded enum — never a URL, credential, key or config value.
 */
export type ReadinessProbes = {
  /** Redis-backed safety store reachability. */
  redis?: () => Promise<DependencyState> | DependencyState
  /** HPKE sealed-envelope service availability. */
  hpke?: () => Promise<DependencyState> | DependencyState
  /** Upstream (Laravel) reachability. */
  upstream?: () => Promise<DependencyState> | DependencyState
}

async function resolveState(
  probe: ReadinessProbes[keyof ReadinessProbes],
): Promise<DependencyState> {
  if (!probe) return 'unknown'
  try {
    const state = await probe()
    return state === 'up' || state === 'down' ? state : 'unknown'
  } catch {
    return 'down'
  }
}

/** Evaluate every readiness dependency concurrently, with a bounded timeout. */
export async function checkReadiness(
  probes: ReadinessProbes,
  timeoutMs = 1500,
): Promise<DependencySnapshot> {
  const withTimeout = (probe: ReadinessProbes[keyof ReadinessProbes]) =>
    Promise.race([
      resolveState(probe),
      new Promise<DependencyState>(resolve => setTimeout(() => resolve('unknown'), timeoutMs)),
    ])
  const [redis, hpke, upstream] = await Promise.all([
    withTimeout(probes.redis), withTimeout(probes.hpke), withTimeout(probes.upstream),
  ])
  return { redis, hpke, upstream }
}

/** Readiness verdict: only an explicitly `down` dependency blocks readiness. */
export function readinessVerdict(snapshot: DependencySnapshot): boolean {
  return snapshot.redis !== 'down' && snapshot.hpke !== 'down' && snapshot.upstream !== 'down'
}

/* ------------------------------------------------------------------ *
 * Shared observability state
 * ------------------------------------------------------------------ */

export type ObservabilityState = {
  metrics: MetricsRegistry
  logger: Logger
  /** Readiness dependency probes; /readyz reports only their enum states. */
  probes: ReadinessProbes
  /** Bearer token required for /metrics. Empty = loopback-only access. */
  metricsToken?: string
}

/**
 * Process-wide observability bundle. The object identity is stable and fields
 * are replaced in place, so an app created before a later
 * `configureObservability` call still observes the current configuration.
 */
const state: ObservabilityState = {
  metrics: createMetricsRegistry(),
  logger: createLogger(),
  probes: {},
}

export function observabilityState(): Readonly<ObservabilityState> {
  return state
}

/** Configure (or reconfigure) the shared observability bundle. */
export function configureObservability(partial: Partial<ObservabilityState>): ObservabilityState {
  Object.assign(state, partial)
  return state
}

/* ------------------------------------------------------------------ *
 * Endpoint guards
 * ------------------------------------------------------------------ */

/** Extract the raw peer address of a Request when the server exposes it. */
export function peerAddressOf(request: Request): string | undefined {
  const holder = request as unknown as {
    __peerIp?: string
    incoming?: { socket?: { remoteAddress?: string } }
    socket?: { remoteAddress?: string }
    info?: { remoteAddress?: string }
  }
  return holder.__peerIp ?? holder.incoming?.socket?.remoteAddress
    ?? holder.socket?.remoteAddress ?? holder.info?.remoteAddress
}

/** Loopback check for the /metrics guard (IPv4, IPv6 and mapped forms). */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  const normalized = address.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === '::1' || normalized === 'localhost' || normalized.endsWith('.localhost')) return true
  if (normalized === '::' || normalized === '0.0.0.0') return false
  if (normalized.startsWith('::ffff:')) return isLoopbackAddress(normalized.slice(7))
  const parts = normalized.split('.')
  if (parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p!))) {
    return parts[0] === '127'
  }
  return false
}

/**
 * Timing-safe bearer-token comparison. A missing configuration never matches,
 * so an unset GATEWAY_METRICS_TOKEN can never be satisfied by an empty header.
 */
export function metricsTokenMatches(configured: string | undefined, presented: string | undefined): boolean {
  if (!configured || !presented) return false
  const a = Buffer.from(configured, 'utf8')
  const b = Buffer.from(presented, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Extract a bearer token from an Authorization header value. */
export function bearerFrom(header: string | undefined): string | undefined {
  if (!header) return undefined
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim())
  return match?.[1]
}
