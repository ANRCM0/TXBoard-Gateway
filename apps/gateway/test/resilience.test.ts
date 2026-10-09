import { describe, expect, it, vi } from 'vitest'
import {
  CircuitBreaker, LocalQuota, OverloadGuard, PublicReadGuard, SafetyGuard,
  UpstreamClient, withRetry, createResilienceStack,
  RESILIENCE_METRICS, RESILIENCE_EVENTS,
} from '../src/middleware/resilience.js'
import { GatewayFailure } from '../src/services/upstream.js'
import { loadConfig } from '../src/config/env.js'
import { nullLogger, createLogger, type Logger } from '../src/middleware/observability.js'
import { createMetricsRegistry, MetricsRegistry } from '../src/services/metrics.js'

const config = loadConfig({ TXBOARD_UPSTREAM_URL: 'https://txboard.example/' })

/** Build a logger that captures the event name of every emitted line. */
function capturingLogger(events: string[]): Logger {
  return createLogger({ level: 'debug', sink: line => {
    try { events.push(JSON.parse(line).msg ?? line) } catch { events.push(line) }
  } })
}

function up(status: number, message = 'x'): GatewayFailure {
  return new GatewayFailure('UPSTREAM_ERROR', status, message)
}

/** Fake upstream fetcher with per-call behaviour and virtual clock. */
function scriptedFetcher(script: Array<() => Response | Promise<Response> | never>) {
  let i = 0
  return vi.fn(async () => {
    const step = script[Math.min(i, script.length - 1)]!
    i += 1
    return step()
  })
}

describe('GW-206 Redis outage policy', () => {
  it('fails closed for account actions when the safety store is unreachable', async () => {
    const metrics = new MetricsRegistry()
    const events: string[] = []
    const logger = capturingLogger(events)
    const store = {
      check: vi.fn(async () => { throw new Error('ECONNREFUSED redis://gateway-redis:6379') }),
      reserve: vi.fn(async () => true),
    }
    const guard = new SafetyGuard(store as never, metrics, logger)
    await expect(guard.checkAccount('login', 'victim@example.test')).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE', status: 503,
    })
    // Redis 429 must pass through unchanged, never become 503.
    store.check = vi.fn(async () => { throw new GatewayFailure('RATE_LIMITED', 429, 'Too many requests') })
    await expect(guard.checkAccount('login', 'k')).rejects.toMatchObject({ status: 429 })
    expect(metrics.redisDegraded.get({ operation: 'login', policy: 'fail-closed' })).toBe(1)
    expect(events).toContain(RESILIENCE_EVENTS.redisFailClosed)
  })

  it('fails closed for HPKE replay reservation when Redis is unreachable', async () => {
    const metrics = new MetricsRegistry()
    const guard = new SafetyGuard({
      check: vi.fn(),
      reserve: vi.fn(async () => { throw new Error('connection lost') }),
    } as never, metrics, nullLogger())
    await expect(guard.reserve('kid', 'nonce', 120_000)).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE', status: 503,
    })
    expect(metrics.redisDegraded.get({ operation: 'replay', policy: 'fail-closed' })).toBe(1)
  })

  it('degrades public reads to a strict local quota and meters the degradation', async () => {
    const metrics = new MetricsRegistry()
    const events: string[] = []
    const logger = capturingLogger(events)
    let clock = 0
    const guard = new PublicReadGuard({
      distributed: {
        check: vi.fn(async () => { throw new Error('redis down') }),
      },
      fallbackLimit: 3,
      fallbackWindowMs: 60_000,
      now: () => clock,
      failThreshold: 1,
    }, metrics, logger)
    for (let i = 0; i < 3; i += 1) await guard.allow('ip:1.2.3.4')
    await expect(guard.allow('ip:1.2.3.4')).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 })
    expect(metrics.localQuotaRejections.get()).toBe(1)
    expect(events.filter(e => e === RESILIENCE_EVENTS.redisLocalQuota).length).toBeGreaterThan(0)
    // A different key has its own conservative budget (per-key, not global).
    await guard.allow('ip:5.6.7.8')
    // After the window elapses the same key is served again.
    clock += 60_001
    await guard.allow('ip:1.2.3.4')
  })

  it('preserves a genuine distributed 429 instead of silently widening limits', async () => {
    const guard = new PublicReadGuard({
      distributed: {
        check: vi.fn(async () => { throw new GatewayFailure('RATE_LIMITED', 429, 'Too many requests') }),
      },
      fallbackLimit: 100, fallbackWindowMs: 60_000,
    }, new MetricsRegistry(), nullLogger())
    await expect(guard.allow('ip:9.9.9.9')).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 })
  })

  it('keeps the local fallback memory bounded under many keys', () => {
    const quota = new LocalQuota(5, 1000, () => 0, 16)
    for (let i = 0; i < 10_000; i += 1) quota.allow('key-' + i)
    // Internally pruned/cleared; still correct afterwards.
    expect(quota.allow('key-0')).toBe(true)
  })
})

describe('GW-206 gateway overload protection', () => {
  it('sheds excess load with 503 instead of queueing without bound', async () => {
    const guard = new OverloadGuard({
      maxConcurrent: 1, maxQueue: 1, queueWaitMs: 50, tickMs: 1,
      sleep: (ms: number) => new Promise(r => setTimeout(r, ms)),
      now: () => Date.now(),
    })
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const first = guard.run(async () => { await gate; return 'first' })
    const second = guard.run(async () => 'second')
    // Second is queued; third finds the queue full and is shed.
    await expect(guard.run(async () => 'third')).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE', status: 503,
    })
    release()
    expect(await first).toBe('first')
    expect(await second).toBe('second')
  })

  it('times queued requests out rather than holding them indefinitely', async () => {
    let clock = 0
    const guard = new OverloadGuard({
      maxConcurrent: 1, maxQueue: 4, queueWaitMs: 20, tickMs: 5,
      now: () => clock,
      sleep: async () => { clock += 10 },
    })
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const held = guard.run(async () => { await gate; return 1 })
    const waiting = guard.run(async () => 2)
    await expect(waiting).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', status: 503 })
    release()
    await held
  })

  it('never exceeds the concurrency limit under a burst', async () => {
    const guard = new OverloadGuard({ maxConcurrent: 4, maxQueue: 64, queueWaitMs: 1000, tickMs: 1 })
    let active = 0
    let peak = 0
    await Promise.all(Array.from({ length: 40 }, () => guard.run(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(r => setTimeout(r, 1))
      active -= 1
    })))
    expect(peak).toBeLessThanOrEqual(4)
    expect(guard.inFlight).toBe(0)
    expect(guard.queued).toBe(0)
  })
})

describe('GW-206 upstream slow / broken handling', () => {
  it('opens the circuit after the failure threshold and rejects fast', async () => {
    let clock = 0
    const breaker = new CircuitBreaker({
      failureThreshold: 3, cooldownMs: 10_000, halfOpenSuccesses: 1, now: () => clock,
    })
    const failing = async () => { throw up(500) }
    for (let i = 0; i < 3; i += 1) await expect(breaker.exec(failing)).rejects.toThrow()
    expect(breaker.currentState).toBe('open')
    // Open circuit short-circuits without invoking the function.
    const spy = vi.fn(async () => 1)
    await expect(breaker.exec(spy)).rejects.toMatchObject({ status: 503 })
    expect(spy).not.toHaveBeenCalled()
  })

  it('does not open on upstream 4xx (the upstream is answering, just refusing)', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 })
    for (let i = 0; i < 10; i += 1) {
      await expect(breaker.exec(async () => { throw up(422) })).rejects.toMatchObject({ status: 422 })
    }
    expect(breaker.currentState).toBe('closed')
  })

  it('half-opens after cooldown, probes, and re-opens on probe failure', async () => {
    let clock = 0
    const breaker = new CircuitBreaker({
      failureThreshold: 1, cooldownMs: 5_000, halfOpenSuccesses: 2, now: () => clock,
    })
    await expect(breaker.exec(async () => { throw up(500) })).rejects.toThrow()
    expect(breaker.currentState).toBe('open')
    clock += 5_001
    // First call after cooldown is the single allowed probe; it fails again.
    await expect(breaker.exec(async () => { throw up(503) })).rejects.toThrow()
    expect(breaker.currentState).toBe('open')
    clock += 5_001
    // Now the upstream is healthy: two successful probes close the breaker.
    await expect(breaker.exec(async () => 'ok')).resolves.toBe('ok')
    expect(breaker.currentState).toBe('half-open')
    await expect(breaker.exec(async () => 'ok')).resolves.toBe('ok')
    expect(breaker.currentState).toBe('closed')
  })

  it('rejects concurrent probes while half-open (no thundering herd)', async () => {
    let clock = 0
    const breaker = new CircuitBreaker({
      failureThreshold: 1, cooldownMs: 100, halfOpenSuccesses: 1, now: () => clock,
    })
    await expect(breaker.exec(async () => { throw up(500) })).rejects.toThrow()
    clock += 101
    let resolveProbe!: (value: string) => void
    const probe = breaker.exec(() => new Promise<string>(r => { resolveProbe = r }))
    // The second call arrives while the probe is still in flight.
    await Promise.resolve()
    await expect(breaker.exec(async () => 'other')).rejects.toMatchObject({ status: 503 })
    resolveProbe('ok')
    await probe
    expect(breaker.currentState).toBe('closed')
  })

  it('retries only idempotent public reads, never writes', async () => {
    const metrics = new MetricsRegistry()
    const events: string[] = []
    const logger = capturingLogger(events)
    let clock = 0
    const breaker = new CircuitBreaker({ failureThreshold: 100, cooldownMs: 1000, now: () => clock })
    const client = new UpstreamClient(
      config,
      scriptedFetcher([
        () => Response.json({ status: 'success', data: [{ id: 1, name: 'Plan' }] }),
        () => { throw up(500) },
      ]),
      breaker,
      { maxAttempts: 2, baseDelayMs: 1, jitterRatio: 0, sleep: async () => {}, random: () => 0 },
      metrics, logger, 30_000, () => clock,
    )
    // First call succeeds and primes the last-good cache.
    await client.call('guestPlans')
    // Second call: upstream 500 then retry succeeds — no throw escapes.
    const result = await client.call('guestPlans')
    expect(result).toEqual([{ id: 1, name: 'Plan' }])
    expect(metrics.upstreamRetries.get({ operation: 'guestPlans' })).toBe(1)
    expect(events).toContain(RESILIENCE_EVENTS.upstreamRetry)
  })

  it('serves stale data for public reads when the upstream is exhausted', async () => {
    const metrics = new MetricsRegistry()
    const events: string[] = []
    const logger = capturingLogger(events)
    let clock = 0
    const breaker = new CircuitBreaker({ failureThreshold: 100, cooldownMs: 10_000, now: () => clock })
    const fetcher = scriptedFetcher([
      () => Response.json({ status: 'success', data: { frontend_theme: 'Nova', theme_config: {} } }),
      () => { throw up(500) },
      () => { throw up(500) },
    ])
    const client = new UpstreamClient(
      config, fetcher, breaker,
      { maxAttempts: 1, baseDelayMs: 1, sleep: async () => {} },
      metrics, logger, 30_000, () => clock,
    )
    await client.call('guestConfig')
    clock += 1_000
    const degraded = await client.call('guestConfig')
    expect(degraded).toEqual({ frontend_theme: 'Nova', theme_config: {} })
    expect(metrics.staleServed.get({ operation: 'guestConfig' })).toBe(1)
    expect(events).toContain(RESILIENCE_EVENTS.staleServed)
  })

  it('never serves stale data for authenticated user operations', async () => {
    const metrics = new MetricsRegistry()
    let clock = 0
    const breaker = new CircuitBreaker({ failureThreshold: 100, cooldownMs: 1000, now: () => clock })
    const fetcher = scriptedFetcher([
      () => Response.json({ status: 'success', data: { email: 'alice@example.test' } }),
      () => { throw up(500) },
      () => { throw up(500) },
    ])
    const client = new UpstreamClient(
      config, fetcher, breaker,
      { maxAttempts: 1, baseDelayMs: 1, sleep: async () => {} },
      metrics, nullLogger(), 30_000, () => clock,
    )
    await client.call('userProfile')
    clock += 1_000
    await expect(client.call('userProfile')).rejects.toMatchObject({ status: 500 })
    expect(metrics.staleServed.get({ operation: 'userProfile' })).toBe(0)
  })

  it('does not retry non-idempotent operations (no retry storm on writes)', async () => {
    const metrics = new MetricsRegistry()
    const fetcher = scriptedFetcher([() => { throw up(500) }])
    const client = new UpstreamClient(
      config, fetcher, new CircuitBreaker({ failureThreshold: 100, cooldownMs: 1000 }),
      { maxAttempts: 5, baseDelayMs: 1, sleep: async () => {} },
      metrics, nullLogger(), 30_000,
    )
    await expect(client.call('register', { body: {} })).rejects.toMatchObject({ status: 500 })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(metrics.upstreamRetries.get({ operation: 'register' })).toBe(0)
  })

  it('caps retries and applies jittered backoff', async () => {
    const sleeps: number[] = []
    const policy = {
      maxAttempts: 3, baseDelayMs: 10, jitterRatio: 0.5,
      random: () => 0.5, sleep: async (ms: number) => { sleeps.push(ms) },
    }
    const attempts = vi.fn(async () => { throw up(502) })
    await expect(withRetry(policy, attempts, CircuitBreaker.isFailure)).rejects.toThrow()
    expect(attempts).toHaveBeenCalledTimes(3)
    // backoff = base * 2^(attempt-1) + jitter(0.5 * backoff * random(0.5)) = 1.25x backoff
    expect(sleeps).toEqual([12.5, 25])
  })

  it('classifies timeouts as retriable upstream failures for idempotent reads', () => {
    expect(CircuitBreaker.isFailure(new GatewayFailure('UPSTREAM_UNAVAILABLE', 504, 'timeout'))).toBe(true)
    expect(CircuitBreaker.isFailure(new GatewayFailure('UPSTREAM_UNAVAILABLE', 502, 'conn'))).toBe(true)
    expect(CircuitBreaker.isFailure(new GatewayFailure('RATE_LIMITED', 429, 'slow down'))).toBe(false)
  })
})

describe('GW-206 resilience stack wiring', () => {
  it('emits transition metrics and warning logs for every breaker state change', async () => {
    const metrics = new MetricsRegistry()
    const events: string[] = []
    const logger = capturingLogger(events)
    let clock = 0
    const stack = createResilienceStack(
      config, scriptedFetcher([() => { throw up(500) }]),
      { metrics, logger, now: () => clock, sleep: async () => {},
        breakerFailures: 2, breakerCooldownMs: 1000, upstreamRetries: 0 },
    )
    await expect(stack.upstream.call('guestConfig')).rejects.toThrow()
    await expect(stack.upstream.call('guestConfig')).rejects.toThrow()
    expect(stack.breaker.currentState).toBe('open')
    expect(metrics.breakerTransitions.get({ from: 'closed', to: 'open' })).toBe(1)
    expect(events).toContain(RESILIENCE_EVENTS.breakerOpen)
    clock += 1001
    await expect(stack.upstream.call('guestConfig')).rejects.toThrow()
    expect(events).toContain(RESILIENCE_EVENTS.breakerHalfOpen)
    expect(metrics.breakerTransitions.get({ from: 'open', to: 'half-open' })).toBe(1)
  })

  it('wires the overload guard around the whole request path', async () => {
    const stack = createResilienceStack(
      config, scriptedFetcher([() => Response.json({ status: 'success', data: [] })]),
      { metrics: new MetricsRegistry(), logger: nullLogger(),
        maxConcurrent: 1, maxQueue: 0, queueWaitMs: 1, tickMs: 1 },
    )
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const held = stack.overload.run(async () => { await gate })
    await expect(stack.overload.run(async () => 1)).rejects.toMatchObject({ status: 503 })
    release()
    await held
  })

  it('shuts down cleanly with no leaked state', () => {
    const stack = createResilienceStack(
      config, vi.fn(), { metrics: new MetricsRegistry(), logger: nullLogger() },
    )
    expect(() => stack.shutdown()).not.toThrow()
    expect(stack.breaker.currentState).toBe('closed')
  })
})

describe('GW-206 metrics exposition', () => {
  it('uses canonical, alertable metric names once resilience paths fire', async () => {
    const metrics = new MetricsRegistry()
    const fetcher = scriptedFetcher([() => Response.json({ status: 'success', data: [] })])
    const client = new UpstreamClient(
      config, fetcher, new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000 }),
      { maxAttempts: 2, baseDelayMs: 1, sleep: async () => {} },
      metrics, nullLogger(), 30_000,
    )
    await client.call('guestConfig')
    const rendered = metrics.render()
    // Prime the retry + stale paths with a scripted upstream failure.
    // The first guestPlans call fails once then succeeds (retry + cache prime);
    // the second call fails twice (exhausted retries) and serves stale.
    const failing = scriptedFetcher([
      () => { throw up(500) },
      () => Response.json({ status: 'success', data: [{ id: 1, name: 'Plan' }] }),
      () => { throw up(500) },
      () => { throw up(500) },
    ])
    const retryClient = new UpstreamClient(
      config, failing, new CircuitBreaker({ failureThreshold: 100, cooldownMs: 1000 }),
      { maxAttempts: 2, baseDelayMs: 1, sleep: async () => {} },
      metrics, nullLogger(), 30_000,
    )
    await retryClient.call('guestPlans')
    expect(await retryClient.call('guestPlans')).toEqual([{ id: 1, name: 'Plan' }])
    const after = metrics.render()
    expect(after).toContain(RESILIENCE_METRICS.upstreamRetries)
    expect(after).toContain(RESILIENCE_METRICS.staleServed)
    expect(rendered).not.toContain(RESILIENCE_METRICS.upstreamRetries + '{')
    // Names must be Prometheus-legal (no spaces, no quotes, lowercase snake).
    for (const name of Object.values(RESILIENCE_METRICS)) {
      expect(name).toMatch(/^[a-z_][a-z0-9_]*$/)
    }
  })

  it('exposes the circuit breaker state as a numeric gauge', async () => {
    const metrics = createMetricsRegistry()
    const logger = nullLogger()
    let clock = 0
    const breaker = new CircuitBreaker({
      failureThreshold: 1, cooldownMs: 1000, now: () => clock,
      onTransition: (from, to) => {
        metrics.breakerState.set({}, to === 'closed' ? 0 : to === 'open' ? 2 : 1)
      },
    })
    await expect(breaker.exec(async () => { throw up(500) })).rejects.toThrow()
    const rendered = metrics.render()
    expect(rendered).toContain(RESILIENCE_METRICS.breakerState)
    expect(rendered).toContain(`${RESILIENCE_METRICS.breakerState} 2`)
  })
})
