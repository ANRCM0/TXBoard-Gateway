#!/usr/bin/env node
// Read-only staging smoke for a pre-existing Gateway deployment. No credentials
// are logged or stored; do not use production admin tokens.
const entry = process.env.GATEWAY_SMOKE_URL
if (!entry) {
  console.error('Set GATEWAY_SMOKE_URL to an isolated Gateway HTTPS ingress')
  process.exit(2)
}
const base = new URL(entry)
const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
if (base.protocol !== 'https:' && !(base.protocol === 'http:' && isLocal)) {
  throw new Error('Only HTTPS or HTTP localhost smoke targets are allowed')
}
if (base.username || base.password || base.search || base.hash) {
  throw new Error('Smoke target URL must not contain credentials or query parameters')
}
const endpoint = new URL(base.toString().replace(/\/$/, '') + '/')
async function get(path, bearer) {
  const target = new URL(path.replace(/^\//, ''), endpoint)
  const response = await fetch(target, {
    headers: bearer ? { Authorization: bearer.startsWith('Bearer ') ? bearer : 'Bearer ' + bearer } : {},
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) throw new Error(path + ' returned HTTP ' + response.status)
  return response.json()
}
function requireEnvelope(path, response) {
  if (!response || response.ok !== true || response.meta?.version !== '1') {
    throw new Error(path + ' returned unexpected Gateway envelope')
  }
  return response.data
}
const health = await get('healthz')
if (health.status !== 'ok' || health.contract !== '1') throw new Error('healthz mismatch')
const bootstrap = requireEnvelope('bootstrap', await get('gateway/v1/bootstrap'))
if (typeof bootstrap.site?.name !== 'string'
  || typeof bootstrap.security?.captcha?.enabled !== 'boolean') {
  throw new Error('bootstrap core data mismatch')
}
const plans = requireEnvelope('plans', await get('gateway/v1/plans'))
if (!Array.isArray(plans)) throw new Error('plans must be an array')
const bearer = process.env.GATEWAY_SMOKE_USER_BEARER
if (bearer) {
  const user = requireEnvelope('profile', await get('gateway/v1/user/profile', bearer))
  if (typeof user.email !== 'string') throw new Error('profile missing email')
  const orders = requireEnvelope('orders', await get('gateway/v1/orders', bearer))
  if (!Array.isArray(orders)) throw new Error('orders must be an array')
}
console.log('Gateway staging read-only smoke passed: health/bootstrap/plans' +
  (bearer ? '/profile/orders' : '') + ' (no browser or payment E2E)')
