import { serve } from '@hono/node-server'
import { createGatewayApp } from './app.js'
import { loadConfig } from './env.js'
import { loadCryptoService } from './crypto.js'

const config = loadConfig()
const crypto = await loadCryptoService(process.env)
const app = createGatewayApp(config, fetch, crypto)
serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
  // Safe startup metadata only; never output tokens, request bodies or secrets.
  console.info(`TXBoard Gateway v1 listening on ${config.host}:${config.port}`)
})
