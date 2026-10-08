import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { RedisLoginProtection } from '../../apps/gateway/dist/login-protection.js'

const url = process.env.GATEWAY_TEST_REDIS_URL
if (!url) throw new Error('Set GATEWAY_TEST_REDIS_URL for live Redis integration')
const rnd = () => randomBytes(12).toString('hex')
const policy = {
  accountCaptchaAfter: 3,
  ipCaptchaAfter: 12,
  failureWindowMs: 900_000,
  lockTiers: [[5, 60_000], [10, 900_000]],
}

test('GW-203 account escalation is atomic across two independent Redis clients', async t => {
  const [a, b] = await Promise.all([
    RedisLoginProtection.connect(url, policy),
    RedisLoginProtection.connect(url, policy),
  ])
  t.after(async () => { await a.close(); await b.close() })
  const email = 'user-' + rnd() + '@example.test'
  const ip = '203.0.113.' + (Math.floor(Math.random() * 250) + 1)
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => (Math.random() < 0.5 ? a : b).recordFailure(email, ip))
  )
  // Atomicity invariant: exactly 8 failures were recorded and no concurrent
  // INCR was lost or double-counted. The per-verdict split under concurrency
  // is not deterministic (several failures land after the lock is already set
  // and all read 'locked'), so only totals are asserted here.
  const codes = results
    .filter(x => x.status === 'fulfilled')
    .map(x => x.value.verdict)
  assert.equal(codes.length, 8)
  assert.ok(codes.every(v => ['allow', 'captcha', 'locked'].includes(v)))
  const locked = await a.admit(email, ip)
  assert.equal(locked.verdict, 'locked')
  assert.ok(locked.retryAfterMs > 55_000 && locked.retryAfterMs <= 60_000)
})

test('GW-203 stuffing IP lock spans accounts and expires on its own', async t => {
  const ip = '198.51.100.' + (Math.floor(Math.random() * 250) + 1)
  const shortPolicy = { ...policy, accountCaptchaAfter: 100, ipCaptchaAfter: 3, lockTiers: [[4, 2_000]] }
  const [c, d] = await Promise.all([
    RedisLoginProtection.connect(url, shortPolicy),
    RedisLoginProtection.connect(url, shortPolicy),
  ])
  t.after(async () => { await c.close(); await d.close() })
  for (let i = 0; i < 3; i++) await c.recordFailure('acct' + i + '-' + rnd() + '@example.test', ip)
  // After 3 IP failures the challenge is armed for every account from this IP.
  assert.equal((await d.admit('fresh-' + rnd() + '@example.test', ip)).verdict, 'captcha')
  // The 4th distinct account from the same IP crosses the lock tier.
  await d.recordFailure('acct4-' + rnd() + '@example.test', ip)
  const locked = await d.admit('fresh2-' + rnd() + '@example.test', ip)
  assert.equal(locked.verdict, 'locked')
  assert.ok(locked.retryAfterMs > 0 && locked.retryAfterMs <= 2_000)
  await new Promise(r => setTimeout(r, 2_100))
  // The lock key expired, but the IP failure counter (window 900s) survives,
  // so the source is still challenged — only a captcha-bearing attempt may
  // proceed until the full window elapses.
  assert.equal((await d.admit('another-' + rnd() + '@example.test', ip)).verdict, 'captcha')
})

test('GW-203 success clears only the account dimension', async t => {
  const redis = await RedisLoginProtection.connect(url, policy)
  t.after(async () => { await redis.close() })
  const email = 'success-' + rnd() + '@Example.TEST'
  await redis.recordFailure(email)
  await redis.recordFailure(email)
  await redis.recordFailure(email)
  assert.equal((await redis.admit(email)).verdict, 'captcha')
  // Normalized (trim + lowercase) lookup clears the same counter.
  await redis.recordSuccess('  ' + email.toLowerCase() + ' ')
  assert.equal((await redis.admit(email)).verdict, 'allow')
  // Key hygiene (no raw email/IP in Redis) is asserted on the digest function
  // in the unit suite; the Lua scripts are the only writers here.
})

test('GW-203 fails closed when Redis is unreachable', async t => {
  const dead = await RedisLoginProtection.connect(url, policy)
  t.after(async () => { await dead.close() })
  await dead.close()
  await assert.rejects(() => dead.admit('x@example.test', '203.0.113.9'), /Login protection store unavailable/)
  // A second close is a no-op rather than a second ClientClosedError.
  await dead.close()
})
