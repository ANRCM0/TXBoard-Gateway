import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config/env.js'

describe('secure gateway configuration', () => {
  it('requires an explicit fixed upstream URL', () => {
    expect(() => loadConfig({})).toThrow('TXBOARD_UPSTREAM_URL')
    expect(() => loadConfig({ TXBOARD_UPSTREAM_URL: 'https://admin:pass@example.test/' })).toThrow('clean origin')
    expect(() => loadConfig({ TXBOARD_UPSTREAM_URL: 'https://example.test/api/v2/' })).toThrow('clean origin')
    expect(() => loadConfig({ TXBOARD_UPSTREAM_URL: 'javascript:alert(1)' })).toThrow('clean origin')
  })
  it('fails closed on accidental plaintext upstream deployment', () => {
    expect(() => loadConfig({ TXBOARD_UPSTREAM_URL: 'http://public.example/' })).toThrow('HTTP upstream')
    expect(() => loadConfig({ TXBOARD_UPSTREAM_URL: 'http://169.254.169.254/', TXBOARD_ALLOW_PRIVATE_HTTP: 'true' })).toThrow('HTTP upstream')
    expect(loadConfig({ TXBOARD_UPSTREAM_URL: 'http://txboard:80/', TXBOARD_ALLOW_PRIVATE_HTTP: 'true' }).upstream.host).toBe('txboard')
  })
  it('accepts only explicit exact CORS origins', () => {
    expect(() => loadConfig({ TXBOARD_UPSTREAM_URL: 'https://example.test/', GATEWAY_ALLOWED_ORIGINS: '*' })).toThrow('Invalid allowed origin')
    expect(() => loadConfig({ TXBOARD_UPSTREAM_URL: 'https://example.test/', GATEWAY_ALLOWED_ORIGINS: 'https://theme.example/login' })).toThrow('exact')
    expect([...loadConfig({ TXBOARD_UPSTREAM_URL: 'https://example.test/', GATEWAY_ALLOWED_ORIGINS: 'https://one.example,https://two.example:8443' }).allowedOrigins]).toEqual(['https://one.example', 'https://two.example:8443'])
  })
})
