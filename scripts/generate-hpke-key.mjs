#!/usr/bin/env node
// Generates an isolated P-256 JWK for Docker secret mounting. Never commit it.
import { generateKeyPairSync } from 'node:crypto'
import { mkdir, open, chmod } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
const target = resolve(process.argv[2] || './secrets/gateway-hpke.json')
await mkdir(dirname(target), { recursive: true, mode: 0o700 })
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const key = privateKey.export({ format: 'jwk' })
const file = await open(target, 'wx', 0o600) // never silently replace existing key
try {
  await file.writeFile(JSON.stringify(key) + '\n', 'utf8')
  await file.sync()
} finally {
  await file.close()
}
await chmod(target, 0o600)
console.log('HPKE private key generated at:', target)
console.log('Back up securely; do not share, log or commit this file.')
