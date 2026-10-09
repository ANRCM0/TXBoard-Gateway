import { serve } from '@hono/node-server'
import { createGatewayApp } from './app.js'
import { loadConfig } from './config/env.js'
import { loadCryptoService } from './services/crypto.js'
import { loadRedisSecurity } from './services/redis-security.js'
import { loadLoginProtection } from './middleware/login-protection.js'
import { compileIpAllowlist } from './middleware/security.js'

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
const app = createGatewayApp(config, fetch, crypto, {
  accountWorkflows,
  limiter: redis ?? undefined,
  loginProtection: loginProtection ?? undefined,
  trustedIngress: config.trustedIngress.join(','),
  allowedHosts: config.allowedHosts.join(','),
})
serve({ fetch: app.fetch, hostname: config.host, port: config.port }, info => {
  // GW-204: expose the peer address the trust decision reads. With @hono/node-server
  // the socket peer arrives as info.remoteAddress; the middleware also reads the
  // Request-level __peerIp seam so tests and raw servers behave identically.
  console.info(`TXBoard Gateway v1 listening on ${config.host}:${config.port}`)
})
