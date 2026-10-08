import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
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
    } else if ([
      '/api/v1/passport/auth/login', '/api/v1/passport/auth/register',
      '/api/v1/passport/comm/sendEmailVerify',
    ].includes(path) && req.method === 'POST') {
      let data = ''
      for await (const chunk of req) data += chunk
      const submitted = JSON.parse(data)
      if (submitted.email !== email || submitted.turnstile_token !== 'fixture-captcha'
        || (path !== '/api/v1/passport/comm/sendEmailVerify' && submitted.password !== password)) {
        status = 422
        result = { status: 'fail', message: 'Invalid fixture test credentials' }
      } else {
        result = upstreamEnvelope(path === '/api/v1/passport/comm/sendEmailVerify' ? true
          : { auth_data: TEST_BEARER, is_admin: false, secure_path: 'private-admin-route', token: 'legacy-token' })
      }
    } else if ([
      '/api/v1/user/info', '/api/v1/user/order/fetch', '/api/v1/user/getSubscribe',
      '/api/v1/user/order/detail', '/api/v1/user/order/getPaymentMethod',
      '/api/v1/user/notice/fetch', '/api/v1/user/getStat', '/api/v1/user/order/check',
    ].includes(path)) {
      if (req.headers.authorization !== TEST_BEARER) {
        status = 401
        result = { status: 'fail', message: 'Expired fixture session' }
      } else if (path.endsWith('/info')) {
        result = upstreamEnvelope({ email, balance: 1000 })
      } else if (path.endsWith('/getStat')) {
        result = upstreamEnvelope([2, 1, 7])
      } else if (path.endsWith('/order/check')) {
        result = upstreamEnvelope(0)
      } else if (path.endsWith('/getSubscribe')) {
        result = upstreamEnvelope({
          plan_id: 1, plan: { name: 'Fixture Pro' }, u: 10, d: 20,
          transfer_enable: 100, token: 'must-never-leak', subscribe_url: 'https://private.test',
        })
      } else if (path.endsWith('/order/detail')) {
        result = upstreamEnvelope({ trade_no: 'fixture-order', status: 0, total_amount: 1200 })
      } else if (path.endsWith('/getPaymentMethod')) {
        result = upstreamEnvelope([{ id: 2, name: 'Fixture Card', config: { secret: 'private-payment-key' } }])
      } else if (path.endsWith('/notice/fetch')) {
        result = { data: [{ id: 7, title: 'Fixture Notice' }], total: 1 }
      } else {
        result = upstreamEnvelope([{ trade_no: 'fixture-order', status: 0, plan_id: 1, period: 'month_price', total_amount: 1200 }])
      }
    } else {
      status = 404
      result = { status: 'fail', message: 'Unknown upstream route' }
    }
    res.statusCode = status
    res.end(JSON.stringify(result))
  })
  t.after(() => upstream.close())

  const bundle = await build({
    entryPoints: ['packages/theme-sdk/dist/index.js'],
    bundle: true, platform: 'browser', format: 'esm', write: false,
  })
  const sdkSource = bundle.outputFiles[0].contents
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

  const keyDir = await mkdtemp(join(tmpdir(), 'txboard-gateway-hpke-'))
  const keyFile = join(keyDir, 'test-hpke.json')
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  await writeFile(keyFile, JSON.stringify(privateKey.export({ format: 'jwk' })), { mode: 0o600 })
  t.after(() => rm(keyDir, { recursive: true, force: true }))

  const gatewayPort = await choosePort()
  const gateway = spawn(process.execPath, ['apps/gateway/dist/index.js'], {
    env: {
      ...process.env,
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(gatewayPort),
      TXBOARD_UPSTREAM_URL: 'http://127.0.0.1:' + upstream.port,
      TXBOARD_ALLOW_PRIVATE_HTTP: 'true',
      GATEWAY_ALLOWED_ORIGINS: 'http://127.0.0.1:' + frontend.port,
      GATEWAY_HPKE_MODE: 'optional',
      GATEWAY_HPKE_KEY_FILE: keyFile,
      GATEWAY_REDIS_URL: process.env.GATEWAY_TEST_REDIS_URL || 'redis://127.0.0.1:16379',
      GATEWAY_ACCOUNT_WORKFLOWS_ENABLED: 'true',
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
  let encryptedRequestBody = ''
  page.on('request', req => {
    if (req.url().includes('/secure/auth/login')) encryptedRequestBody = req.postData() || ''
  })
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
    const subscription = await api.user.subscription()
    const detail = await api.orders.detail('fixture-order')
    const payments = await api.payments.list()
    const notices = await api.notices.list({ current: 1, pageSize: 5 })
    const encryptedApi = createTXBoardClient({
      baseURL: 'http://127.0.0.1:' + gatewayPort + '/gateway/v1',
      encryptedLogin: true,
    })
    const stats = await api.dashboard.stats()
    const orderStatus = await api.orders.status('fixture-order')
    const code = await encryptedApi.auth.sendEmailCode({ email, turnstile_token: 'fixture-captcha' })
    const registered = await encryptedApi.auth.register({ email, password, turnstile_token: 'fixture-captcha' })
    const protectedLogin = await encryptedApi.auth.login({
      email, password, turnstile_token: 'fixture-captcha',
    })
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
      subscriptionName: subscription.planName,
      leakedSubscriptionToken: JSON.stringify(subscription).includes('must-never-leak'),
      detailNumber: detail.trade_no,
      paymentName: payments[0]?.name,
      leakedPaymentKey: JSON.stringify(payments).includes('private-payment-key'),
      noticeTotal: notices.total,
      encryptedLoginKeys: Object.keys(protectedLogin).sort(),
      registrationKeys: Object.keys(registered).sort(),
      codeSent: code.sent,
      stats,
      orderStatus,
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
  assert.equal(result.subscriptionName, 'Fixture Pro')
  assert.equal(result.leakedSubscriptionToken, false)
  assert.equal(result.detailNumber, 'fixture-order')
  assert.equal(result.paymentName, 'Fixture Card')
  assert.equal(result.leakedPaymentKey, false)
  assert.equal(result.noticeTotal, 1)
  assert.deepEqual(result.encryptedLoginKeys, ['auth_data', 'is_admin'])
  assert.deepEqual(result.registrationKeys, ['auth_data', 'is_admin'])
  assert.equal(result.codeSent, true)
  assert.deepEqual(result.stats, { unpaidOrders: 2, openTickets: 1, invitedUsers: 7 })
  assert.deepEqual(result.orderStatus, { tradeNo: 'fixture-order', status: 0 })
  assert.ok(encryptedRequestBody.includes('"kid"'))
  assert.ok(encryptedRequestBody.includes('"ct"'))
  assert.ok(!encryptedRequestBody.includes(password))
  assert.ok(!encryptedRequestBody.includes(email))
  assert.equal(result.expiredStatus, 401)
  assert.equal(result.rejectedStatus, 422)
  assert.equal(result.persistedAuth, false)
  assert.ok(upstreamRequests.includes('/api/v1/user/order/fetch'))
  assert.ok(!upstreamRequests.some(path => path.startsWith('/api/v2/')))
  assert.ok(!childOutput.join('').includes(password))
})
