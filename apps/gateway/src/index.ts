import { serve } from '@hono/node-server'
import { createGatewayApp } from './app.js'
import { loadConfig } from './config/env.js'
import { loadCryptoService } from './services/crypto.js'
import { loadRedisSecurity } from './services/redis-security.js'
import { loadLoginProtection } from './middleware/login-protection.js'
import { compileIpAllowlist } from './middleware/security.js'
import { configureObservability, type ReadinessProbes } from './middleware/observability.js'

const config = loadConfig()
// GW-204: fail closed at boot on a malformed ingress allowlist rather than at request time.
compileIpAllowlist(config.trustedIngress.join(','))
const redis = await loadRedisSecurity(process.env)
const loginProtection = await loadLoginProtection(process.env)
const crypto = await loadCryptoService(process.env, redis)
const accountWorkflows = process.env.GATEWAY_ACCOUNT_WORKFLOWS_ENABLED === 'true'
if (accountWorkflows && (!redis || !crypto)) {
  throw new Error('Account workflows require both Redis and HPKE')
}

// GW-214 / PR-D: observability wiring. /metrics is reachable only with a bearer
// token when GATEWAY_METRICS_TOKEN is set, otherwise from loopback only.
// Readiness probes report dependency REACHABILITY only — never a URL,
// credential, key or configuration value.
const metricsToken = process.env.GATEWAY_METRICS_TOKEN?.trim() || undefined
const probes: ReadinessProbes = {
  // Redis powers replay protection, login protection and the rate limiter.
  // The node-redis client exposes its live state through `isReady`.
  redis: () => (redis ? ((redis as unknown as { isReady: boolean }).isReady ? 'up' : 'down') : 'unknown'),
  // HPKE sealed-envelope decryption; absent when the mode is disabled.
  hpke: () => (crypto ? 'up' : 'unknown'),
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
  loginProtection: loginProtection ?? undefined,
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
