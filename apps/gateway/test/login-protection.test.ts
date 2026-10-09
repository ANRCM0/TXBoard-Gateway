import { describe, expect, it } from 'vitest'
import { MemoryLoginProtection, defaultLoginPolicy, type LoginProtection } from '../src/middleware/login-protection.js'

/**
 * GW-203 unit tests. Semantics are asserted on the in-process implementation,
 * which mirrors the Redis Lua scripts 1:1 (see login-protection.ts). Live Redis
 * behaviour (atomicity across replicas) is covered by
 * tests/redis/login-protection.test.mjs.
 */

let clock = 0
function protection(overrides: Partial<typeof defaultLoginPolicy> = {}) {
  clock = 0
  const policy = { ...defaultLoginPolicy, ...overrides }
  return new MemoryLoginProtection(policy, () => clock)
}
function advance(ms: number) { clock += ms }

async function repeated(p: LoginProtection, count: number, email = 'a@example.test', ip?: string) {
  const verdicts = []
  for (let i = 0; i < count; i++) verdicts.push((await p.recordFailure(email, ip)).verdict)
  return verdicts
}

describe('GW-203 login protection engine', () => {
  it('allows a first attempt and admits a success case', async () => {
    const p = protection()
    expect(await p.admit('a@example.test', '203.0.113.1')).toEqual({ verdict: 'allow', retryAfterMs: 0 })
    await p.recordFailure('a@example.test', '203.0.113.1')
    expect(await p.recordFailure('a@example.test', '203.0.113.1')).toEqual({ verdict: 'allow', retryAfterMs: 0 })
    await p.recordSuccess('a@example.test')
    expect(await p.admit('a@example.test', '203.0.113.1')).toEqual({ verdict: 'allow', retryAfterMs: 0 })
  })

  it('escalates the account dimension to captcha after the threshold, then locks it', async () => {
    const p = protection({ ipCaptchaAfter: 1000 })
    const verdicts = await repeated(p, 6, 'victim@example.test')
    // The 3rd failed attempt (== accountCaptchaAfter) demands a captcha.
    expect(verdicts).toEqual(['allow', 'allow', 'captcha', 'captcha', 'locked', 'locked'])
    const admit = await p.admit('victim@example.test')
    expect(admit.verdict).toBe('locked')
    expect(admit.retryAfterMs).toBeGreaterThan(0)
    expect(admit.retryAfterMs).toBeLessThanOrEqual(60_000)
    // Lock expiry releases the dimension; the failure counter may still live.
    advance(61_000)
    expect(await p.admit('victim@example.test')).toEqual({ verdict: 'captcha', retryAfterMs: 0 })
  })

  it('escalates the lock duration with higher failure counts', async () => {
    const p = protection({ accountCaptchaAfter: 3, ipCaptchaAfter: 1000, lockTiers: [[5, 60_000], [10, 900_000]] })
    await repeated(p, 5, 'a@example.test')
    expect((await p.admit('a@example.test')).retryAfterMs).toBeLessThanOrEqual(60_000)
    advance(61_000)
    await repeated(p, 5, 'a@example.test')
    expect((await p.admit('a@example.test')).retryAfterMs).toBeGreaterThan(60_000)
  })

  it('locks a credential-stuffing source IP across many distinct accounts', async () => {
    const p = protection({ ipCaptchaAfter: 3, lockTiers: [[4, 300_000]] })
    const verdicts = []
    for (let i = 0; i < 5; i++) verdicts.push((await p.recordFailure('user' + i + '@example.test', '198.51.100.7')).verdict)
    expect(verdicts).toEqual(['allow', 'allow', 'captcha', 'locked', 'locked'])
    // A brand-new account from the same IP is still locked: stuffing cannot
    // simply rotate the target account.
    expect((await p.admit('fresh@example.test', '198.51.100.7')).verdict).toBe('locked')
    // Unaffected accounts from other IPs stay open.
    expect((await p.admit('fresh@example.test', '198.51.100.9')).verdict).toBe('allow')
  })

  it('a single account success does not reset the IP dimension', async () => {
    const p = protection({ accountCaptchaAfter: 2, ipCaptchaAfter: 4, lockTiers: [] })
    for (let i = 0; i < 4; i++) await p.recordFailure('a@example.test', '203.0.113.5')
    await p.recordSuccess('a@example.test')
    // Account dimension cleared, but the same account from the same IP still
    // meets the IP captcha threshold — dual-dimension means the weaker verdict
    // wins and the challenge stands.
    expect((await p.admit('a@example.test', '203.0.113.5')).verdict).toBe('captcha')
    expect((await p.admit('b@example.test', '203.0.113.5')).verdict).toBe('captcha')
    // From a clean IP the cleared account dimension reads as open.
    expect((await p.admit('a@example.test', '198.51.100.1')).verdict).toBe('allow')
  })

  it('failure counters expire after the window so no permanent penalty exists', async () => {
    const p = protection({ accountCaptchaAfter: 2, lockTiers: [] })
    await repeated(p, 2, 'a@example.test')
    expect((await p.admit('a@example.test')).verdict).toBe('captcha')
    advance(defaultLoginPolicy.failureWindowMs + 1)
    expect((await p.admit('a@example.test')).verdict).toBe('allow')
  })

  it('normalizes submitted email so case and whitespace share one counter', async () => {
    const p = protection({ accountCaptchaAfter: 2, lockTiers: [] })
    await repeated(p, 2, 'Victim@Example.TEST')
    expect((await p.admit('  victim@example.test ')).verdict).toBe('captcha')
  })

  it('takes the worse verdict across both dimensions', async () => {
    const p = protection({ accountCaptchaAfter: 1, ipCaptchaAfter: 10, lockTiers: [] })
    await p.recordFailure('a@example.test')            // account -> captcha
    expect((await p.admit('a@example.test', '203.0.113.2')).verdict).toBe('captcha')
    // Fresh account, clean IP, clean account dimension stays open.
    expect((await p.admit('b@example.test', '203.0.113.2')).verdict).toBe('allow')
  })
})
