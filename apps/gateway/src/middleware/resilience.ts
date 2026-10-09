/**
 * middleware/resilience.ts — GW-206 fault tolerance: Redis outage policy,
 * gateway overload protection, upstream slow/broken handling.
 *
 * Design rules:
 *  - Login / register / email-code / HPKE replay fail closed on Redis loss.
 *  - Health and public reads degrade to a strict per-instance local quota and
 *    emit a log warning + metric; limits are never silently widened.
 *  - Overload is shed at the queue edge (503) instead of queueing forever.
 *  - Upstream failures open a circuit breaker; only idempotent public reads are
 *    retried, so a broken upstream can never cause a retry storm on writes.
 *
 * Observability (metrics/logger types, redaction) is shared with GW-205 /
 * GW-214 via ./observability.js; this module only emits canonical metric names
 * and closed-vocabulary log events.
 */

import { GatewayFailure, upstreamRequest, type UpstreamFetcher, type UpstreamOperation } from '../services/upstream.js'
import type { GatewayConfig } from '../config/env.js'
import type { Logger } from './observability.js'
import type { MetricsRegistry } from '../services/metrics.js'

/**
 * Canonical metric names emitted by the resilience layer. These are the exact
 * Prometheus family names published in /metrics, so an alert rule and this
 * table can never drift apart.
 */
export const RESILIENCE_METRICS = {
  breakerState: 'txboard_gateway_circuit_breaker_state',
  breakerTransitions: 'txboard_gateway_circuit_breaker_transitions_total',
  overloadRejections: 'txboard_gateway_overload_rejections_total',
  queueWait: 'txboard_gateway_queue_wait_seconds',
  upstreamRetries: 'txboard_gateway_upstream_retries_total',
  staleServed: 'txboard_gateway_stale_served_total',
  localQuotaRejections: 'txboard_gateway_local_quota_rejections_total',
  redisDegraded: 'txboard_gateway_redis_degraded_total',
} as const

/** Log events emitted on every degradation path (alert on these). */
export const RESILIENCE_EVENTS = {
  redisFailClosed: 'resilience.redis_fail_closed',
  redisLocalQuota: 'resilience.redis_local_quota',
  overloadShed: 'resilience.overload_shed',
  breakerOpen: 'resilience.circuit_breaker_open',
  breakerHalfOpen: 'resilience.circuit_breaker_half_open',
  breakerClose: 'resilience.circuit_breaker_close',
  upstreamRetry: 'resilience.upstream_retry',
  staleServed: 'resilience.stale_served',
  upstreamExhausted: 'resilience.upstream_exhausted',
} as const

/* ------------------------------------------------------ local fallback quota */

/** Conservative per-instance fixed-window counter used only when the
 * distributed safety store is unreachable. Never a global limit substitute. */
export class LocalQuota {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>()
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 4096,
  ) {}
  allow(key: string): boolean {
    const now = this.now()
    const bucket = this.buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      if (this.buckets.size >= this.maxKeys) {
        for (const [k, v] of this.buckets) if (v.resetAt <= now) this.buckets.delete(k)
        if (this.buckets.size >= this.maxKeys) this.buckets.clear()
      }
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs })
      return true
    }
    if (bucket.count >= this.limit) return false
    bucket.count += 1
    return true
  }
  reset(): void { this.buckets.clear() }
}

/* ------------------------------------------------------------ circuit breaker */

export type BreakerState = 'closed' | 'open' | 'half-open'

export class CircuitBreaker {
  private failures = 0
  private halfOpenSuccesses = 0
  private probeInFlight = false
  private state: BreakerState = 'closed'
  private openedAt = 0
  constructor(
    private readonly options: {
      failureThreshold: number
      cooldownMs: number
      halfOpenSuccesses?: number
      now?: () => number
      onTransition?: (from: BreakerState, to: BreakerState) => void
    },
  ) {}
  get currentState(): BreakerState { return this.state }
  /** 5xx / transport failures count; 4xx is the upstream's own answer. */
  static isFailure(error: unknown): boolean {
    return error instanceof GatewayFailure && error.status >= 500
  }
  async exec<T>(fn: () => Promise<T>, isFailure: (e: unknown) => boolean = CircuitBreaker.isFailure): Promise<T> {
    const now = (this.options.now ?? Date.now)()
    if (this.state === 'open') {
      if (now - this.openedAt < this.options.cooldownMs) {
        throw new GatewayFailure('UPSTREAM_UNAVAILABLE', 503, 'Upstream temporarily unavailable')
      }
      // Cooldown elapsed: this call becomes the first half-open probe.
      this.transition('half-open')
      this.halfOpenSuccesses = 0
      this.probeInFlight = false
    }
    if (this.state === 'half-open' && this.probeInFlight) {
      // Exactly one probe in flight while half-open: no thundering herd.
      throw new GatewayFailure('UPSTREAM_UNAVAILABLE', 503, 'Upstream temporarily unavailable')
    }
    const isProbe = this.state === 'half-open'
    if (isProbe) this.probeInFlight = true
    try {
      const result = await fn()
      if (isProbe) {
        this.probeInFlight = false
        this.halfOpenSuccesses += 1
        if (this.halfOpenSuccesses >= (this.options.halfOpenSuccesses ?? 2)) this.transition('closed')
      }
      this.failures = 0
      return result
    } catch (error) {
      if (isProbe) this.probeInFlight = false
      if (isFailure(error)) {
        if (this.state === 'half-open') {
          this.open(now)
        } else {
          this.failures += 1
          if (this.failures >= this.options.failureThreshold) this.open(now)
        }
      } else {
        this.failures = 0
      }
      throw error
    }
  }
  private transition(to: BreakerState): void {
    if (this.state === to) return
    this.options.onTransition?.(this.state, to)
    this.state = to
  }
  private open(now: number): void {
    this.probeInFlight = false
    this.failures = 0
    this.openedAt = now
    this.transition('open')
  }
}

/* ------------------------------------------------------------- overload guard */

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** Bounded queue + concurrency semaphore. Excess load is rejected with 503
 * instead of being buffered without limit (no unbounded memory growth, no
 * timeout amplification in front of a slow upstream). */
export class OverloadGuard {
  inFlight = 0
  queued = 0
  constructor(
    private readonly options: {
      maxConcurrent: number
      maxQueue: number
      queueWaitMs: number
      tickMs?: number
      sleep?: (ms: number) => Promise<void>
      now?: () => number
    },
  ) {}
  /** Run fn with a concurrency slot; acquire returns immediately so the
   * caller can meter queue rejection before awaiting. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.options.maxConcurrent) {
      if (this.queued >= this.options.maxQueue) {
        this.rejections += 1
        throw this.overloaded()
      }
      this.queued += 1
      const now = this.options.now ?? Date.now
      const sleep = this.options.sleep ?? defaultSleep
      const deadline = now() + this.options.queueWaitMs
      const waitStartedAt = now()
      try {
        while (this.inFlight >= this.options.maxConcurrent && now() < deadline) {
          await sleep(Math.max(1, Math.min(this.options.tickMs ?? 10, deadline - now())))
        }
      } finally {
        this.queued -= 1
        // Queue wait is metered even when the wait ends in a rejection, so a
        // saturated gateway is visible before it starts shedding.
        this.queueWaitMsObserved = now() - waitStartedAt
      }
      if (this.inFlight >= this.options.maxConcurrent) {
        this.rejections += 1
        throw this.overloaded()
      }
    }
    this.inFlight += 1
    try {
      return await fn()
    } finally {
      this.inFlight -= 1
    }
  }

  /** Number of requests shed with 503 by this guard. */
  rejections = 0

  /** Duration of the most recent queue wait, in milliseconds. */
  queueWaitMsObserved = 0

  private overloaded(): GatewayFailure {
    // Shedding is a 503 with the upstream-unavailable code: the gateway is
    // temporarily unable to serve, never a client fault.
    return new GatewayFailure('UPSTREAM_UNAVAILABLE', 503, 'Gateway is overloaded, retry later')
  }
}

/* -------------------------------------------------------------- retry policy */

export type RetryPolicy = {
  maxAttempts: number
  baseDelayMs: number
  jitterRatio?: number
  random?: () => number
  sleep?: (ms: number) => Promise<void>
  onRetry?: (attempt: number, error: unknown) => void
}

/** Retry only idempotent (GET) upstream operations, only on transport/5xx
 * failures, with capped attempts and jittered backoff. Never on writes. */
export async function withRetry<T>(
  policy: RetryPolicy,
  fn: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
): Promise<T> {
  const sleep = policy.sleep ?? defaultSleep
  const random = policy.random ?? Math.random
  let lastError: unknown
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt >= policy.maxAttempts || !shouldRetry(error)) throw error
      policy.onRetry?.(attempt, error)
      const backoff = policy.baseDelayMs * 2 ** (attempt - 1)
      const jitter = backoff * (policy.jitterRatio ?? 0.5) * random()
      await sleep(backoff + jitter)
    }
  }
  throw lastError
}

/* ------------------------------------------------------- safety store policy */

export interface DistributedLimiter {
  check(action: string, key: string): Promise<void>
}

/** Fail-closed wrapper around the Redis safety store with observability.
 * Account-level failures (login/register/email-code) and HPKE replay MUST
 * reject when the store is unreachable — never degrade to allow. */
export class SafetyGuard {
  constructor(
    private readonly store: DistributedLimiter & { reserve(kid: string, nonce: string, ttlMs: number): Promise<boolean> },
    private readonly metrics: MetricsRegistry,
    private readonly logger: Logger,
  ) {}
  async checkAccount(action: string, key: string): Promise<void> {
    try {
      await this.store.check(action, key)
    } catch (error) {
      if (error instanceof GatewayFailure && error.status === 429) throw error
      this.metrics.redisDegraded.inc({ operation: action, policy: 'fail-closed' })
      this.logger.warn(RESILIENCE_EVENTS.redisFailClosed, { operation: action, policy: 'fail-closed' })
      throw new GatewayFailure('UPSTREAM_UNAVAILABLE', 503, 'Redis safety store unavailable')
    }
  }
  async reserve(kid: string, nonce: string, ttlMs: number): Promise<boolean> {
    try {
      return await this.store.reserve(kid, nonce, ttlMs)
    } catch (error) {
      this.metrics.redisDegraded.inc({ operation: 'replay', policy: 'fail-closed' })
      this.logger.warn(RESILIENCE_EVENTS.redisFailClosed, { operation: 'replay', policy: 'fail-closed' })
      throw new GatewayFailure('UPSTREAM_UNAVAILABLE', 503, 'Replay protection unavailable')
    }
  }
}

/* --------------------------------------------------- public read fallback */

/** Health / public reads may degrade to a strict per-instance local quota when
 * Redis is unreachable, but the degradation must be logged and metered, and a
 * real distributed 429 is always preserved. */
export class PublicReadGuard {
  private consecutiveFailures = 0
  private readonly fallback: LocalQuota
  constructor(
    private readonly options: {
      distributed?: DistributedLimiter
      fallbackLimit: number
      fallbackWindowMs: number
      now?: () => number
      failThreshold?: number
    },
    private readonly metrics: MetricsRegistry,
    private readonly logger: Logger,
  ) {
    this.fallback = new LocalQuota(options.fallbackLimit, options.fallbackWindowMs, options.now)
  }
  async allow(key: string): Promise<void> {
    const { distributed } = this.options
    const failThreshold = this.options.failThreshold ?? 2
    if (distributed && this.consecutiveFailures < failThreshold) {
      try {
        await distributed.check('public-read', key)
        this.consecutiveFailures = 0
        return
      } catch (error) {
        if (error instanceof GatewayFailure && error.status === 429) throw error
        this.consecutiveFailures += 1
        this.metrics.redisDegraded.inc({ operation: 'public-read', policy: 'local-quota' })
      }
    }
    this.logger.warn(RESILIENCE_EVENTS.redisLocalQuota, { policy: 'local-quota', limit: this.options.fallbackLimit })
    if (!this.fallback.allow(key)) {
      this.metrics.localQuotaRejections.inc()
      throw new GatewayFailure('RATE_LIMITED', 429, 'Too many requests')
    }
  }
}

/* ------------------------------------------------------------ upstream client */

const PUBLIC_READ_OPERATIONS = new Set<UpstreamOperation>(['guestConfig', 'guestPlans'])

/** Upstream access with circuit breaker, capped idempotent retry and
 * stale-while-error degradation for public reads only. */
export class UpstreamClient {
  private readonly cache = new Map<UpstreamOperation, { at: number; data: unknown }>()
  constructor(
    private readonly config: GatewayConfig,
    private readonly fetcher: UpstreamFetcher,
    private readonly breaker: CircuitBreaker,
    private readonly retry: RetryPolicy,
    private readonly metrics: MetricsRegistry,
    private readonly logger: Logger,
    private readonly staleTtlMs: number,
    private readonly now: () => number = Date.now,
  ) {}
  async call(
    operation: UpstreamOperation,
    options: Parameters<typeof upstreamRequest>[3] = {},
  ): Promise<unknown> {
    const idempotent = PUBLIC_READ_OPERATIONS.has(operation)
    const retryPolicy: RetryPolicy = {
      ...this.retry,
      onRetry: (attempt) => {
        this.metrics.upstreamRetries.inc({ operation })
        this.logger.warn(RESILIENCE_EVENTS.upstreamRetry, { operation, attempt })
      },
    }
    try {
      const data = await this.breaker.exec(
        () => withRetry(
          retryPolicy,
          () => upstreamRequest(this.config, this.fetcher, operation, options),
          error => idempotent && CircuitBreaker.isFailure(error),
        ),
      )
      if (idempotent) this.cache.set(operation, { at: this.now(), data })
      return data
    } catch (error) {
      const stale = idempotent ? this.cache.get(operation) : undefined
      if (stale && CircuitBreaker.isFailure(error)) {
        const ageMs = this.now() - stale.at
        if (ageMs <= this.staleTtlMs * 4) {
          this.metrics.staleServed.inc({ operation })
          this.logger.warn(RESILIENCE_EVENTS.staleServed, { operation, ageMs, policy: 'stale-cache' })
          return stale.data
        }
      }
      if (CircuitBreaker.isFailure(error)) {
        this.logger.warn(RESILIENCE_EVENTS.upstreamExhausted, { operation })
      }
      throw error
    }
  }
  breakerState(): BreakerState { return this.breaker.currentState }
}

/* ------------------------------------------------------------------- stack */

export type ResilienceOptions = {
  maxConcurrent?: number
  maxQueue?: number
  queueWaitMs?: number
  tickMs?: number
  breakerFailures?: number
  breakerCooldownMs?: number
  upstreamRetries?: number
  retryBaseDelayMs?: number
  staleTtlMs?: number
  publicReadFallbackLimit?: number
  publicReadWindowMs?: number
  metrics: MetricsRegistry
  logger: Logger
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export type ResilienceStack = {
  breaker: CircuitBreaker
  overload: OverloadGuard
  upstream: UpstreamClient
  safety?: SafetyGuard
  publicRead: PublicReadGuard
  shutdown(): void
}

export function createResilienceStack(
  config: GatewayConfig,
  fetcher: UpstreamFetcher,
  options: ResilienceOptions,
): ResilienceStack {
  const { metrics, logger } = options
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep

  const breaker = new CircuitBreaker({
    failureThreshold: options.breakerFailures ?? 5,
    cooldownMs: options.breakerCooldownMs ?? 15_000,
    halfOpenSuccesses: 2,
    now,
    onTransition: (from, to) => {
      metrics.breakerTransitions.inc({ from, to })
      metrics.breakerState.set({}, to === 'closed' ? 0 : to === 'open' ? 2 : 1)
      const event = to === 'open' ? RESILIENCE_EVENTS.breakerOpen
        : to === 'half-open' ? RESILIENCE_EVENTS.breakerHalfOpen
          : RESILIENCE_EVENTS.breakerClose
      logger.warn(event, { from, to })
    },
  })

  const overload = new OverloadGuard({
    maxConcurrent: options.maxConcurrent ?? 256,
    maxQueue: options.maxQueue ?? 512,
    queueWaitMs: options.queueWaitMs ?? 2_000,
    tickMs: options.tickMs ?? 10,
    sleep,
    now,
  })

  const upstream = new UpstreamClient(
    config, fetcher, breaker,
    {
      maxAttempts: (options.upstreamRetries ?? 1) + 1,
      baseDelayMs: options.retryBaseDelayMs ?? 50,
      sleep,
    },
    metrics, logger,
    options.staleTtlMs ?? 30_000,
    now,
  )

  const publicRead = new PublicReadGuard(
    {
      fallbackLimit: options.publicReadFallbackLimit ?? 60,
      fallbackWindowMs: options.publicReadWindowMs ?? 60_000,
      now,
    },
    metrics, logger,
  )

  return {
    breaker,
    overload,
    upstream,
    publicRead,
    shutdown(): void {
      // No timers are held; queues drain naturally as handlers complete.
      logger.info('resilience.stack_shutdown', {})
    },
  }
}
