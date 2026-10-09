/**
 * GW-202 live Redis integration test for the sliding-window rate limiter.
 * Run: GATEWAY_TEST_REDIS_URL=redis://user:pass@host:6379 \
 *      node --test tests/redis/rate-limiter.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { RedisRateLimiter } from '../../apps/gateway/dist/middleware/rate-limit.js'

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

// ---------------------------------------------------------------------------
// PR-C (GW-215): dual-layer limits, live Redis, two independent clients
// ---------------------------------------------------------------------------

test('GW-215 same IP with many distinct accounts trips the IP dimension', async t => {
  const [a] = [await RedisRateLimiter.connect(url)]
  t.after(async () => { await a.close() })
  const pol = policy({
    id: 'gw215-ipdim-' + rnd(), ipLimit: 3, ipWindowMs: 5000,
    subjectLimit: 50, subjectWindowMs: 5000, subjectFrom: 'email',
  })
  const ip = '203.0.113.' + (1 + Math.floor(Math.random() * 200))
  const outcomes = []
  for (let i = 0; i < 5; i++) {
    outcomes.push(await a.check({ policy: pol, ip, subject: 'acct' + i + '-' + rnd() + '@example.test' }))
  }
  assert.deepEqual(outcomes.map(o => o.allowed), [true, true, true, false, false])
  const rejected = outcomes[3]
  assert.equal(rejected.limitedBy, 'ip')
  assert.ok(rejected.retryAfterMs > 0)
  assert.ok(rejected.retryAfterHeader >= 1)
})

test('GW-215 same account across rotating IPs trips the account dimension', async t => {
  const [a] = [await RedisRateLimiter.connect(url)]
  t.after(async () => { await a.close() })
  const pol = policy({
    id: 'gw215-acctdim-' + rnd(), ipLimit: 100, ipWindowMs: 5000,
    subjectLimit: 3, subjectWindowMs: 5000, subjectFrom: 'email',
  })
  const victim = 'victim-' + rnd() + '@example.test'
  const outcomes = []
  for (let i = 0; i < 6; i++) {
    outcomes.push(await a.check({ policy: pol, ip: '192.0.2.' + i, subject: victim }))
  }
  assert.deepEqual(outcomes.map(o => o.allowed), [true, true, true, false, false, false])
  const rejected = outcomes[3]
  assert.equal(rejected.limitedBy, 'subject')
  assert.ok(rejected.retryAfterMs > 0)
  assert.ok(rejected.retryAfterHeader >= 1)
})

test('GW-215 a missing subject cannot bypass an account-dimension policy', async t => {
  const [a] = [await RedisRateLimiter.connect(url)]
  t.after(async () => { await a.close() })
  const pol = policy({
    id: 'gw215-nosub-' + rnd(), ipLimit: 100, ipWindowMs: 5000,
    subjectLimit: 5, subjectWindowMs: 5000, subjectFrom: 'email',
  })
  const decision = await a.check({ policy: pol, ip: '198.51.100.7' })
  assert.equal(decision.allowed, false)
  assert.equal(decision.limitedBy, 'missing_subject')
  assert.ok(decision.retryAfterHeader >= 1)
  assert.equal(a.getStats().missingSubject, 1)
})

test('GW-215 two independent clients share one atomic window (multi-replica)', async t => {
  const [a, b] = await Promise.all([RedisRateLimiter.connect(url), RedisRateLimiter.connect(url)])
  t.after(async () => { await Promise.all([a.close(), b.close()]) })
  const pol = policy({ id: 'gw215-replica-' + rnd(), ipLimit: 10, ipWindowMs: 5000 })
  const ip = '203.0.113.' + (1 + Math.floor(Math.random() * 200))
  // 40 concurrent checks spread over two clients: exactly 10 may be admitted,
  // which is only possible if both clients evaluate the same atomic window.
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) =>
    (i % 2 === 0 ? a : b).check({ policy: pol, ip })))
  const allowed = results.filter(r => r.allowed)
  const denied = results.filter(r => !r.allowed)
  assert.equal(allowed.length, 10, `expected exactly 10 admitted across two replicas, got ${allowed.length}`)
  assert.equal(denied.length, 30)
  for (const r of denied) {
    assert.equal(r.limitedBy, 'ip')
    assert.ok(r.retryAfterMs > 0)
    assert.ok(r.retryAfterHeader >= 1)
  }
})

test('GW-215 Redis failure fails closed on credential routes and degrades on public reads', async t => {
  // A limiter whose store is gone must not silently allow either class of route.
  const dead = await RedisRateLimiter.connect(url)
  await dead.close()
  const closedPolicy = policy({ id: 'gw215-closed-' + rnd(), ipLimit: 5, ipWindowMs: 5000, failClosed: true })
  await assert.rejects(
    () => dead.check({ policy: closedPolicy, ip: '203.0.113.9' }),
    e => e.code === 'UPSTREAM_UNAVAILABLE' && e.status === 503,
  )
  const openPolicy = policy({ id: 'gw215-open-' + rnd(), ipLimit: 5, ipWindowMs: 5000, failClosed: false })
  const degraded = await dead.check({ policy: openPolicy, ip: '203.0.113.9' })
  assert.equal(degraded.allowed, true)
  assert.equal(degraded.degraded, true, 'a degraded route must be flagged, never silently unlimited')
  assert.equal(dead.getStats().degraded, 1)
  assert.equal(dead.getStats().redisFailures, 2)
})

test('GW-215 no raw IP, email or bearer token appears in any Redis key', async t => {
  const [a] = [await RedisRateLimiter.connect(url)]
  t.after(async () => { await a.close() })
  const pol = policy({
    id: 'gw215-hygiene-' + rnd(), ipLimit: 10, ipWindowMs: 5000,
    subjectLimit: 5, subjectWindowMs: 5000, subjectFrom: 'bearer',
  })
  const ip = '203.0.113.55'
  const token = 'Bearer ' + 'a'.repeat(64)
  await a.check({ policy: pol, ip, subject: token })
  const { createClient } = await import('redis')
  const inspector = createClient({ url })
  await inspector.connect()
  const keys = await inspector.keys('txbgw:v1:rl:' + pol.id + ':*')
  await inspector.quit()
  assert.ok(keys.length >= 2, 'both the IP and the account key must exist')
  for (const key of keys) {
    assert.ok(!key.includes(ip), 'raw IP leaked into key')
    assert.ok(!key.includes(token), 'raw bearer token leaked into key')
    assert.ok(!key.includes('Bearer'), 'bearer scheme leaked into key')
    assert.ok(!key.includes('a'.repeat(64)), 'token material leaked into key')
    assert.ok(/^[0-9a-f]{32}$/.test(key.split(':').pop()), 'key segment must be a digest')
  }
})
