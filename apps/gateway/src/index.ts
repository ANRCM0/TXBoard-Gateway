import { serve } from '@hono/node-server'
import { createGatewayApp } from './app.js'
import { loadConfig } from './env.js'

const config = loadConfig()
const app = createGatewayApp(config)
serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
  // Safe startup metadata only; never output tokens, request bodies or secrets.
  console.info(`TXBoard Gateway v1 listening on ${config.host}:${config.port}`)
})
