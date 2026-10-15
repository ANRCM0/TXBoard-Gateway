import { serve } from '@hono/node-server'
import { watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createGatewayApp } from './app.js'
import { loadConfig } from './config/env.js'
import { loadCryptoService } from './services/crypto.js'
import { loadRedisSecurity } from './services/redis-security.js'
import { loadLoginProtection } from './middleware/login-protection.js'
import { RedisCaptchaChallenge, type CaptchaChallenge } from './services/captcha-challenge.js'
import { compileIpAllowlist } from './middleware/security.js'
import { configureObservability, observabilityState, type ReadinessProbes } from './middleware/observability.js'
import { parseRateLimitConfig, setRuntimePolicies, RedisRateLimiter } from './middleware/rate-limit.js'

const config = loadConfig()
// GW-204: fail closed at boot on a malformed ingress allowlist rather than at request time.
compileIpAllowlist(config.trustedIngress.join(','))
const redis = await loadRedisSecurity(process.env)
const routeRateLimiter = process.env.GATEWAY_REDIS_URL
  ? await RedisRateLimiter.connect(process.env.GATEWAY_REDIS_URL)
  : undefined
const loginProtection = await loadLoginProtection(process.env)
const crypto = await loadCryptoService(process.env, redis)
const accountWorkflows = process.env.GATEWAY_ACCOUNT_WORKFLOWS_ENABLED === 'true'
if (config.internalLoginEnabled === true && accountWorkflows) {
  throw new Error('Isolated Internal login cannot enable account workflows')
}
if (config.internalEmailCodeEnabled === true && (accountWorkflows || !redis || !crypto)) {
  throw new Error('Isolated Internal email requires HPKE and Redis with account workflows disabled')
}
if (accountWorkflows && (!redis || !crypto)) {
  throw new Error('Account workflows require both Redis and HPKE')
}
// GW-209: the one-time CAPTCHA challenge store. Opt-in
// (GATEWAY_CAPTCHA_CHALLENGE_ENABLED) because a deployment without Redis, or
// one that delegates challenges entirely to Laravel, must keep the legacy
// verbatim-token behaviour untouched. Redis-backed, atomic GET+DEL, so a
// challenge succeeds exactly once across every replica.
let captchaChallenge: CaptchaChallenge | undefined
if (process.env.GATEWAY_CAPTCHA_CHALLENGE_ENABLED === 'true' && process.env.GATEWAY_REDIS_URL) {
  captchaChallenge = await RedisCaptchaChallenge.connect(process.env.GATEWAY_REDIS_URL)
  console.info('Gateway CAPTCHA challenge store enabled (Redis)')
}

// GW-214 / PR-D: observability wiring. /metrics is reachable only with a bearer
// token when GATEWAY_METRICS_TOKEN is set, otherwise from loopback only.
// Readiness probes report dependency REACHABILITY only — never a URL,
// credential, key or configuration value.
const metricsToken = process.env.GATEWAY_METRICS_TOKEN?.trim() || undefined
const probes: ReadinessProbes = {
  // Redis powers replay protection, login protection and the rate limiter.
  // The node-redis client exposes its live state through `isReady`.
  redis: () => (redis ? (redis.isReady ? 'up' : 'down') : 'unknown'),
  // HPKE sealed-envelope decryption; absent when the mode is disabled.
  hpke: () => (crypto ? 'up' : 'unknown'),
  // GW-209: the one-time CAPTCHA challenge store (Redis). 'unknown' when the
  // feature is disabled, so readiness never reports a missing dependency for
  // a deployment that never wired it.
  captchaChallenge: () => (captchaChallenge
    ? ((captchaChallenge as unknown as { client?: { isReady: boolean } }).client?.isReady ? 'up' : 'down')
    : 'unknown'),
  // Laravel is not contacted on the readiness path; the gateway can serve
  // traffic whenever its own hard dependencies are healthy.
  upstream: () => 'up',
}
configureObservability({ metricsToken, probes })
console.info(metricsToken
  ? 'Gateway /metrics is token-guarded'
  : 'Gateway /metrics is loopback-only')

const app = createGatewayApp(config, fetch, crypto, {
  accountWorkflows,
  limiter: redis ?? undefined,
  rateLimiter: routeRateLimiter,
  loginProtection: loginProtection ?? undefined,
  captchaChallenge,
  trustedIngress: config.trustedIngress.join(','),
  allowedHosts: config.allowedHosts.join(','),
}, {
  metricsToken,
  probes,
})
serve({ fetch: app.fetch, hostname: config.host, port: config.port }, info => {
  // GW-204: expose the peer address the trust decision reads. With @hono/node-server
  // the socket peer arrives as info.remoteAddress; the middleware also reads the
  // Request-level __peerIp seam so tests and raw servers behave identically.
  console.info(`TXBoard Gateway v1 listening on ${config.host}:${config.port}`)
})

// GW-208: hot-reload rate-limit configuration from a JSON file.
// The watcher checks every 30s; a successful parse atomically replaces the
// runtime policy table. A failed parse keeps the old table and records a metric.
const rateLimitConfigPath = process.env.GATEWAY_RATE_LIMIT_CONFIG?.trim() || undefined
if (rateLimitConfigPath) {
  const { metrics } = observabilityState()
  let lastContent: string | undefined
  const reload = async () => {
    try {
      const raw = await readFile(rateLimitConfigPath!, 'utf8')
      if (raw === lastContent) return // no change
      const policies = parseRateLimitConfig(raw)
      if (!policies) {
        metrics.rateLimitConfigReloads.inc({ outcome: 'parse_failed' })
        console.warn(`Rate-limit config parse failed, keeping previous policies: ${rateLimitConfigPath}`)
        return
      }
      if (!setRuntimePolicies(policies)) {
        metrics.rateLimitConfigReloads.inc({ outcome: 'invalid' })
        console.warn(`Rate-limit config invalid, keeping previous policies: ${rateLimitConfigPath}`)
        return
      }
      lastContent = raw
      metrics.rateLimitConfigReloads.inc({ outcome: 'success' })
      console.info(`Rate-limit config reloaded: ${rateLimitConfigPath} (${policies.length} policies)`)
    } catch (err) {
      metrics.rateLimitConfigReloads.inc({ outcome: 'read_failed' })
      console.warn(`Rate-limit config read failed: ${rateLimitConfigPath}`, err)
    }
  }
  // Initial load, then watch for changes.
  reload().catch(() => {})
  watch(rateLimitConfigPath, { persistent: true }, () => { reload().catch(() => {}) })
  // Periodic check as a fallback if fs.watch misses events (e.g. on some filesystems).
  setInterval(() => { reload().catch(() => {}) }, 30_000)
  console.info(`Rate-limit hot-reload enabled: ${rateLimitConfigPath}`)
} else {
  console.info('Rate-limit hot-reload disabled (GATEWAY_RATE_LIMIT_CONFIG not set)')
}
