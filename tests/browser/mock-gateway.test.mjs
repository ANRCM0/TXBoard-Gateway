import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const TEST_BEARER = 'Bearer fixture-session-abc123'
const SITE = 'fixture-site-key'
const email = 'user@fixture.test'
const password = 'fixture-password-123'
const upstreamRequests = []
const upstreamEnvelope = data => ({ status: 'success', message: null, data, error: null })

async function startServer(handler) {
  const server = createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    server,
    port: server.address().port,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}
async function choosePort() {
  const { port, close } = await startServer((_req, res) => res.end())
  await close()
  return port
}
async function waitHealth(url, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('Gateway child exited before health')
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Gateway did not become ready')
}

test('Chromium theme SDK works through Gateway with strict fake Laravel contracts', { timeout: 120000 }, async t => {
  const upstream = await startServer(async (req, res) => {
    let path = req.url?.split('?')[0] || ''
    upstreamRequests.push(path)
    res.setHeader('Content-Type', 'application/json')
    let status = 200
    let result
    if (path === '/api/v1/guest/comm/config') {
      result = upstreamEnvelope({
        app_name: 'Fixture TXBoard', frontend_theme: 'TXBoard', theme_config: { accent: 'blue' },
        is_captcha: 1, captcha_type: 'turnstile', turnstile_site_key: SITE,
        turnstile_secret_key: 'not-public',
      })
    } else if (path === '/api/v1/guest/plan/fetch') {
      result = upstreamEnvelope([{ id: 1, name: 'Monthly', month_price: 1200 }])
    } else if (path === '/api/v1/passport/auth/login' && req.method === 'POST') {
      let data = ''
      for await (const chunk of req) data += chunk
      const submitted = JSON.parse(data)
      if (submitted.email !== email || submitted.password !== password || submitted.turnstile_token !== 'fixture-captcha') {
        status = 422
        result = { status: 'fail', message: 'Invalid fixture test credentials' }
      } else {
        result = upstreamEnvelope({ auth_data: TEST_BEARER, is_admin: false, secure_path: 'private-admin-route', token: 'legacy-token' })
      }
    } else if (path === '/api/v1/user/info' || path === '/api/v1/user/order/fetch') {
      if (req.headers.authorization !== TEST_BEARER) {
        status = 401
        result = { status: 'fail', message: 'Expired fixture session' }
      } else {
        result = upstreamEnvelope(path.endsWith('/info')
          ? { email, balance: 1000 }
          : [{ trade_no: 'fixture-order', status: 0, plan_id: 1, period: 'month_price', total_amount: 1200 }])
      }
    } else {
      status = 404
      result = { status: 'fail', message: 'Unknown upstream route' }
    }
    res.statusCode = status
    res.end(JSON.stringify(result))
  })
  t.after(() => upstream.close())

  const sdkSource = await readFile(new URL('../../packages/theme-sdk/dist/index.js', import.meta.url))
  const frontend = await startServer((req, res) => {
    if (req.url === '/sdk.js') {
      res.setHeader('Content-Type', 'text/javascript')
      res.end(sdkSource)
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end('<!doctype html><html><body><h1>Isolated TXBoard theme fixture</h1></body></html>')
    }
  })
  t.after(() => frontend.close())

  const gatewayPort = await choosePort()
  const gateway = spawn(process.execPath, ['apps/gateway/dist/index.js'], {
    env: {
      ...process.env,
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(gatewayPort),
      TXBOARD_UPSTREAM_URL: 'http://127.0.0.1:' + upstream.port,
      TXBOARD_ALLOW_PRIVATE_HTTP: 'true',
      GATEWAY_ALLOWED_ORIGINS: 'http://127.0.0.1:' + frontend.port,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const childOutput = []
  gateway.stdout.on('data', data => childOutput.push(data.toString()))
  gateway.stderr.on('data', data => childOutput.push(data.toString()))
  t.after(async () => {
    gateway.kill('SIGTERM')
    if (gateway.exitCode === null) {
      await Promise.race([
        new Promise(resolve => gateway.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 1500)),
      ])
      if (gateway.exitCode === null) gateway.kill('SIGKILL')
    }
  })
  await waitHealth('http://127.0.0.1:' + gatewayPort + '/healthz', gateway)

  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:' + frontend.port)
  const result = await page.evaluate(async ({ gatewayPort, email, password }) => {
    const { createTXBoardClient } = await import('/sdk.js')
    let session = null
    const api = createTXBoardClient({
      baseURL: 'http://127.0.0.1:' + gatewayPort + '/gateway/v1',
      getToken: () => session,
    })
    const bootstrap = await api.bootstrap()
    const plans = await api.plans.list()
    const login = await api.auth.login({ email, password, turnstile_token: 'fixture-captcha' })
    session = login.auth_data
    const profile = await api.user.profile()
    const orders = await api.orders.list({ status: 0 })
    session = 'invalid-session-123'
    let expiredStatus
    try {
      await api.user.profile()
    } catch (error) {
      expiredStatus = error.status
    }
    let rejectedStatus
    try {
      await api.auth.login({ email, password: 'wrong-password', turnstile_token: 'fixture-captcha' })
    } catch (error) {
      rejectedStatus = error.status
    }
    return {
      siteName: bootstrap.site.name,
      captcha: bootstrap.security.captcha,
      theme: bootstrap.theme,
      plans,
      loginKeys: Object.keys(login).sort(),
      profileEmail: profile.email,
      orderNumber: orders[0]?.trade_no,
      expiredStatus,
      rejectedStatus,
      persistedAuth: Object.keys(localStorage).some(k => /auth|token/i.test(k)),
    }
  }, { gatewayPort, email, password })
  assert.equal(result.siteName, 'Fixture TXBoard')
  assert.deepEqual(result.captcha, { enabled: true, type: 'turnstile', siteKey: SITE })
  assert.deepEqual(result.theme, { name: 'TXBoard', config: { accent: 'blue' } })
  assert.equal(result.plans[0].month_price, 1200)
  assert.deepEqual(result.loginKeys, ['auth_data', 'is_admin'])
  assert.equal(result.profileEmail, email)
  assert.equal(result.orderNumber, 'fixture-order')
  assert.equal(result.expiredStatus, 401)
  assert.equal(result.rejectedStatus, 422)
  assert.equal(result.persistedAuth, false)
  assert.ok(upstreamRequests.includes('/api/v1/user/order/fetch'))
  assert.ok(!upstreamRequests.some(path => path.startsWith('/api/v2/')))
  assert.ok(!childOutput.join('').includes(password))
})
