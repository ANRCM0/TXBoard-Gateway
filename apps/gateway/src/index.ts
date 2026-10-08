import { serve } from '@hono/node-server'
import { createGatewayApp } from './app.js'
import { loadConfig } from './env.js'
import { loadCryptoService } from './crypto.js'
import { loadRedisSecurity } from './redis-security.js'

const config = loadConfig()
const redis = await loadRedisSecurity(process.env)
const crypto = await loadCryptoService(process.env, redis)
const accountWorkflows = process.env.GATEWAY_ACCOUNT_WORKFLOWS_ENABLED === 'true'
if (accountWorkflows && (!redis || !crypto)) {
  throw new Error('Account workflows require both Redis and HPKE')
}
const app = createGatewayApp(config, fetch, crypto, { accountWorkflows, limiter: redis })
serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
  // Safe startup metadata only; never output tokens, request bodies or secrets.
  console.info(`TXBoard Gateway v1 listening on ${config.host}:${config.port}`)
})
