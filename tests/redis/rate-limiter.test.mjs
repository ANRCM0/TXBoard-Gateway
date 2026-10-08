/**
 * GW-202 live Redis integration test for the sliding-window rate limiter.
 * Run: GATEWAY_TEST_REDIS_URL=redis://user:pass@host:6379 \
 *      node --test tests/redis/rate-limiter.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { RedisRateLimiter } from '../../apps/gateway/dist/rate-limiter.js'

const url = process.env.GATEWAY_TEST_REDIS_URL
if (!url) throw new Error('Set GATEWAY_TEST_REDIS_URL for live Redis integration')
const rnd = () => Math.random().toString(36).slice(2)

function policy(overrides) {
  const base = { id: 'gw202test-' + rnd(), match: '/gateway/v1', ipLimit: 10, ipWindowMs: 1000, failClosed: false }
  const merged = { ...base, ...overrides }
  return { ...merged, subjectWindow: merged.subjectWindowMs ?? merged.ipWindowMs }
}

test('multi-replica sliding window admits exactly ipLimit requests across independent clients', async t => {
  const [a, b] = await Promise.all([RedisRateLimiter.connect(url), RedisRateLimiter.connect(url)])
  t.after(async () => { await Promise.all([a.close(), b.close()]) })
  const pol = policy({ ipLimit: 20, ipWindowMs: 5000 })
  const ip = '203.0.113.' + (1 + Math.floor(Math.random() * 200))
  const results = await Promise.all(Array.from({ length: 60 }, (_, i) =>
    (i % 2 === 0 ? a : b).check({ policy: pol, ip })))
  const allowed = results.filter(r => r.allowed).length
  assert.equal(allowed, 20, `expected exactly 20 admitted, got ${allowed}`)
  for (const r of results.filter(x => !x.allowed)) {
    assert.ok(r.retryAfterMs > 0)
    assert.ok(r.retryAfterHeader >= 1)
  }
})

test('IP and subject dimensions are independent: same IP different accounts each get full budget', async t => {
  const [a] = [await RedisRateLimiter.connect(url)]
  t.after(async () => { await a.close() })
  const pol = policy({ id: 'gw202acct-' + rnd(), ipLimit: 4, ipWindowMs: 5000, subjectLimit: 2, subjectWindowMs: 5000, subjectFrom: 'email' })
  const ip = '198.51.100.' + (1 + Math.floor(Math.random() * 200))
  const outcomes = []
  for (const email of ['x1@a.test', 'x1@a.test', 'x1@a.test', 'x2@a.test', 'x2@a.test']) {
    outcomes.push(await a.check({ policy: pol, ip, subject: email }))
  }
  // x1: 2 allowed (subject cap), then rejected; x2: 2 more allowed, then rejected.
  assert.deepEqual(outcomes.map(o => o.allowed), [true, true, false, true, false])
})

test('account budget is shared across rotating IPs (credential-stuffing defence)', async t => {
  const [a] = [await RedisRateLimiter.connect(url)]
  t.after(async () => { await a.close() })
  const pol = policy({ id: 'gw202rot-' + rnd(), ipLimit: 100, ipWindowMs: 5000, subjectLimit: 3, subjectWindowMs: 5000, subjectFrom: 'email' })
  const outcomes = []
  for (let i = 0; i < 8; i++) {
    outcomes.push(await a.check({ policy: pol, ip: '192.0.2.' + i, subject: 'victim@example.test' }))
  }
  assert.equal(outcomes.filter(o => o.allowed).length, 3)
})

test('window slides: requests admitted again after the window expires', async t => {
  const [a] = [await RedisRateLimiter.connect(url)]
  t.after(async () => { await a.close() })
  const pol = policy({ id: 'gw202slide-' + rnd(), ipLimit: 5, ipWindowMs: 600, failClosed: true })
  const ip = '203.0.113.' + (1 + Math.floor(Math.random() * 200))
  for (let i = 0; i < 5; i++) assert.ok((await a.check({ policy: pol, ip })).allowed)
  assert.ok(!(await a.check({ policy: pol, ip })).allowed)
  await new Promise(r => setTimeout(r, 700))
  assert.ok((await a.check({ policy: pol, ip })).allowed, 'window must have slid open')
})

test('no raw IP or email material in Redis keys', async t => {
  const [a] = [await RedisRateLimiter.connect(url)]
  t.after(async () => { await a.close() })
  const pol = policy({ id: 'gw202privacy-' + rnd(), subjectLimit: 5, subjectWindowMs: 5000, subjectFrom: 'email' })
  await a.check({ policy: pol, ip: '203.0.113.55', subject: 'secret@user.test' })
  const { createClient } = await import('redis')
  const inspector = createClient({ url })
  await inspector.connect()
  const keys = await inspector.keys('txbgw:v1:rl:' + pol.id + ':*')
  await inspector.quit()
  assert.ok(keys.length >= 1)
  for (const key of keys) {
    assert.ok(!key.includes('203.0.113.55'), 'raw IP leaked into key')
    assert.ok(!key.includes('secret@user.test'), 'raw email leaked into key')
    assert.ok(/^[0-9a-f]{32}$/.test(key.split(':').pop()), 'key segment must be a digest')
  }
})
