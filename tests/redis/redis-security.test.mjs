import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, generateKeyPairSync } from 'node:crypto'
import { RedisSecurity } from '../../apps/gateway/dist/services/redis-security.js'
import { CryptoService } from '../../apps/gateway/dist/services/crypto.js'
import { encryptForOperation } from '../../packages/theme-sdk/dist/crypto.js'

const url = process.env.GATEWAY_TEST_REDIS_URL
if (!url) throw new Error('Set GATEWAY_TEST_REDIS_URL for live Redis integration')
const rnd = () => randomBytes(12).toString('hex')

test('SET NX PX rejects 64 concurrent identical nonce reservations across independent Redis clients', async t => {
  const [a,b] = await Promise.all([RedisSecurity.connect(url), RedisSecurity.connect(url)])
  t.after(async () => { await a.close(); await b.close() })
  const kid = rnd(), nonce = rnd()
  const results = await Promise.all(Array.from({length:64},(_,i)=>
    (i % 2 === 0 ? a : b).reserve(kid,nonce,121000)))
  assert.equal(results.filter(Boolean).length, 1)
  assert.equal(await a.reserve(kid,nonce,121000), false)
  assert.equal(await b.reserve(kid,rnd(),121000), true)
})
test('Redis account limiter atomically stops requests across two clients and does not expose raw emails in key', async t => {
  const [a,b] = await Promise.all([RedisSecurity.connect(url),RedisSecurity.connect(url)])
  t.after(async()=>{await a.close();await b.close()})
  const email = 'user-' + rnd() + '@example.test'
  const results = await Promise.allSettled(Array.from({length:12},(_,i)=>
    (i%2===0?a:b).check('login',email)))
  assert.equal(results.filter(x=>x.status==='fulfilled').length,8)
  assert.equal(results.filter(x=>x.status==='rejected'&&x.reason.status===429).length,4)
  assert.equal(await b.reserve(rnd(),rnd(),1000),true)
})

// PR-C (GW-215): the per-account and per-IP keys must both be digests, and the
// per-source IP dimension must actually stop a campaign spread across accounts.
test('GW-215 account limiter keys are digests only and the IP dimension spans accounts', async t => {
  const [a] = [await RedisSecurity.connect(url)]
  t.after(async () => { await a.close() })
  const ip = '198.51.100.' + (Math.floor(Math.random() * 200) + 1)
  const marker = 'marker-' + rnd()
  const email = marker + '@example.test'
  await a.check('login', email, ip)
  const { createClient } = await import('redis')
  const inspector = createClient({ url })
  await inspector.connect()
  const accountKeys = await inspector.keys('txbgw:v1:rate:login:*')
  const ipKeys = await inspector.keys('txbgw:v1:rateip:login:*')
  await inspector.quit()
  const touched = [...accountKeys, ...ipKeys]
  assert.ok(touched.length >= 2, 'both the account and the IP key must exist')
  for (const key of touched) {
    assert.ok(!key.includes(email), 'raw email leaked into account key')
    assert.ok(!key.includes(marker), 'email material leaked into account key')
    assert.ok(!key.includes(ip), 'raw client IP leaked into IP key')
    assert.ok(/^[0-9a-f]{64}$/.test(key.split(':').pop()), 'key segment must be a sha256 digest')
  }
  // Per-IP cap (30 for login) applies across DISTINCT accounts from one source.
  const outcomes = []
  for (let i = 0; i < 40; i++) {
    outcomes.push(await a.check('login', 'spread-' + i + '-' + rnd() + '@example.test', ip).then(() => 'ok', e => e.status))
  }
  const allowed = outcomes.filter(o => o === 'ok').length
  assert.ok(allowed <= 30, `per-IP cap must bound the campaign, ${allowed} requests got through`)
  assert.ok(outcomes.includes(429), 'the per-IP dimension must reject once crossed')
})
test('nonce is never released after malformed payload and Redis failure blocks requests', async () => {
  const redis = await RedisSecurity.connect(url)
  const {privateKey} = generateKeyPairSync('ec',{namedCurve:'prime256v1'})
  const jwk = privateKey.export({format:'jwk'})
  const gateway = await CryptoService.create(jwk,redis,true)
  const key = gateway.publicKey()
  const sealed = await encryptForOperation(key,{email:'x@example.test',password:'pass12345678'},'register')
  const data = await gateway.open(sealed,'register')
  assert.equal(data.email,'x@example.test')
  await assert.rejects(()=>gateway.open(sealed,'register'),e=>e.status===409)
  const future = await encryptForOperation(key,{email:'x@example.test',password:'pass12345678'},'register')
  await redis.close()
  await assert.rejects(()=>gateway.open(future,'register'),e=>e.status===503)
})
