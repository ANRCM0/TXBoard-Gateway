import { describe, expect, it, vi } from 'vitest'
import {
  compileIpAllowlist,
  evaluateRequest,
  hostMatchesAllowlist,
  ipMatches,
  normalizeIp,
  parseIpEntry,
  sanitizeForwardedHeaders,
} from '../src/middleware/security.js'
import { createGatewayApp, safeHostHeader } from '../src/app.js'
import { loadConfig } from '../src/config/env.js'

const config = loadConfig({
  TXBOARD_UPSTREAM_URL: 'https://txboard.example/',
  GATEWAY_ALLOWED_ORIGINS: 'https://theme.example',
})

/** Build a Request whose socket peer is `peer` (test seam used by the gateway). */
function requestFromPeer(peer: string, init?: RequestInit) {
  const req = new Request('https://gateway.test/gateway/v1/bootstrap', init)
  Object.defineProperty(req, '__peerIp', { value: peer, enumerable: false })
  return req
}

describe('GW-204 trusted IP normalization', () => {
  it('normalizes IPv4-mapped IPv6, bracketed and cased addresses', () => {
    expect(normalizeIp('::FFFF:127.0.0.1')).toBe('127.0.0.1')
    expect(normalizeIp('[::1]')).toBe('::1')
    expect(normalizeIp('  10.0.0.5 ')).toBe('10.0.0.5')
    expect(normalizeIp('::ffff:a00:5')).toBe('10.0.0.5')
    expect(normalizeIp('2001:DB8::1')).toBe('2001:db8::1')
  })

  it('parses host and CIDR entries for both families', () => {
    expect(parseIpEntry('10.0.0.1')).toEqual({ ip: String((10 << 24) | 1), bits: 32, family: 4 })
    expect(parseIpEntry('10.0.0.0/8')?.bits).toBe(8)
    expect(parseIpEntry('10.0.0.0/33')).toBeNull()
    expect(parseIpEntry('not-an-ip')).toBeNull()
    expect(parseIpEntry('10.0.0.256')).toBeNull()
    expect(parseIpEntry('10.0.0.1/')).toBeNull()
    expect(parseIpEntry('::1')?.family).toBe(6)
    expect(parseIpEntry('2001:db8::/32')?.bits).toBe(32)
    expect(parseIpEntry('2001:db8::/129')).toBeNull()
  })

  it('rejects malformed entries at compile time instead of silently ignoring them', () => {
    expect(() => compileIpAllowlist('10.0.0.0/8,!!bad!!')).toThrow('Invalid trusted ingress entry')
  })
})

describe('GW-204 ingress allowlist matching', () => {
  const allow = compileIpAllowlist('10.0.0.0/8, 172.16.0.5, 192.168.1.0/24, ::1, fd00::/8')

  it('matches exact hosts and CIDR members', () => {
    expect(ipMatches(allow, '10.1.2.3')).toBe(true)
    expect(ipMatches(allow, '172.16.0.5')).toBe(true)
    expect(ipMatches(allow, '172.16.0.6')).toBe(false)
    expect(ipMatches(allow, '192.168.1.200')).toBe(true)
    expect(ipMatches(allow, '192.168.2.200')).toBe(false)
    expect(ipMatches(allow, '11.0.0.1')).toBe(false)
    expect(ipMatches(allow, '::1')).toBe(true)
    expect(ipMatches(allow, 'fd12:3456::abcd')).toBe(true)
    expect(ipMatches(allow, 'fe80::1')).toBe(false)
    expect(ipMatches(allow, '::ffff:10.1.2.3')).toBe(true)
  })

  it('treats an empty allowlist as trust-nobody (fail closed)', () => {
    const none = compileIpAllowlist('')
    expect(none.empty).toBe(true)
    expect(ipMatches(none, '10.0.0.1')).toBe(false)
    expect(ipMatches(none, '::1')).toBe(false)
  })
})

describe('GW-204 forwarded header spoofing', () => {
  const allow = compileIpAllowlist('10.0.0.0/8')

  it('ignores forged X-Forwarded-For from an untrusted peer', () => {
    const headers = new Headers({ 'X-Forwarded-For': '1.2.3.4', 'X-Real-IP': '9.9.9.9' })
    const verdict = evaluateRequest('203.0.113.9', headers, allow)
    expect(verdict.trusted).toBe(false)
    expect(verdict.reason).toBe('forged_headers')
    expect(verdict.clientIp).toBe('203.0.113.9')
  })

  it('honors the right-most untrusted address from a trusted ingress', () => {
    const headers = new Headers({ 'X-Forwarded-For': '1.2.3.4, 10.0.0.7' })
    const verdict = evaluateRequest('10.0.0.7', headers, allow)
    expect(verdict.trusted).toBe(true)
    expect(verdict.clientIp).toBe('1.2.3.4')
  })

  it('falls back to the peer when a trusted ingress sends only trusted addresses', () => {
    const verdict = evaluateRequest('10.0.0.7', new Headers({ 'X-Forwarded-For': '10.0.0.7, 10.0.0.8' }), allow)
    expect(verdict.trusted).toBe(true)
    expect(verdict.clientIp).toBe('10.0.0.7')
  })

  it('prefers X-Real-IP over the X-Forwarded-For chain from a trusted ingress', () => {
    const headers = new Headers({ 'X-Forwarded-For': '1.2.3.4', 'X-Real-IP': '5.6.7.8' })
    const verdict = evaluateRequest('10.0.0.7', headers, allow)
    expect(verdict.clientIp).toBe('5.6.7.8')
  })

  it('uses the peer address verbatim when no forwarding is claimed', () => {
    const verdict = evaluateRequest('203.0.113.9', new Headers(), allow)
    expect(verdict).toEqual({ trusted: false, clientIp: '203.0.113.9', claimedForwarded: false, reason: 'peer_not_trusted' })
  })

  it('rebuilds rather than appends the proxy header chain', () => {
    const source = new Headers({
      'X-Forwarded-For': '1.2.3.4, 5.6.7.8',
      'X-Real-IP': '5.6.7.8',
      'Forwarded': 'for=5.6.7.8',
      'X-Forwarded-Host': 'evil.test',
      'X-Forwarded-Proto': 'http',
      'Connection': 'keep-alive',
      'Authorization': 'Bearer token',
      'Content-Type': 'application/json',
    })
    const verdict = evaluateRequest('10.0.0.7', source, allow)
    const out = sanitizeForwardedHeaders(source, verdict)
    // X-Real-IP wins, so the rebuilt chain carries exactly one client IP.
    expect(out.get('X-Forwarded-For')).toBe('5.6.7.8')
    expect(out.get('X-Real-IP')).toBe('5.6.7.8')
    expect(out.get('Forwarded')).toBeNull()
    expect(out.get('X-Forwarded-Host')).toBeNull()
    expect(out.get('X-Forwarded-Proto')).toBe('https')
    expect(out.get('Connection')).toBeNull()
    expect(out.get('Authorization')).toBe('Bearer token')
    expect(out.get('Content-Type')).toBe('application/json')
  })

  it('collapses a multi-hop chain to a single rebuilt address', () => {
    const source = new Headers({ 'X-Forwarded-For': '9.9.9.9, 8.8.8.8, 10.0.0.7' })
    const out = sanitizeForwardedHeaders(source, evaluateRequest('10.0.0.7', source, allow))
    expect(out.get('X-Forwarded-For')).toBe('8.8.8.8')
    expect(out.get('X-Real-IP')).toBe('8.8.8.8')
  })

  it('never emits proxy headers for untrusted peers', () => {
    const verdict = evaluateRequest('203.0.113.9', new Headers(), allow)
    const out = sanitizeForwardedHeaders(new Headers({ 'Accept': 'application/json' }), verdict)
    expect(out.has('X-Forwarded-For')).toBe(false)
    expect(out.has('X-Real-IP')).toBe(false)
    expect(out.has('X-Forwarded-Proto')).toBe(false)
    expect(out.get('Accept')).toBe('application/json')
  })
})

describe('GW-204 Host validation', () => {
  it('accepts well-formed hosts', () => {
    expect(safeHostHeader('gateway.example.com')).toBe('gateway.example.com')
    expect(safeHostHeader('GATEWAY.Example.com:8443')).toBe('gateway.example.com')
    expect(safeHostHeader('[2001:db8::1]')).toBe('[2001:db8::1]')
  })

  it('rejects injection and smuggling payloads', () => {
    for (const bad of [
      'evil.com\r\nX-Injected: yes',
      'evil.com:80/x',
      'evil.com?x=1',
      'evil.com#frag',
      'user@evil.com',
      'evil .com',
      '',
      '..evil.com',
      'a..b.com',
      `${'a'.repeat(64)}.example.com`,
    ]) {
      expect(safeHostHeader(bad)).toBeNull()
    }
  })

  it('never lets a CR/LF payload survive into the accepted host value', () => {
    // trim() removes the raw CR/LF, so the returned value is a clean hostname;
    // the untrimmed input must never be logged or forwarded.
    expect(safeHostHeader('gateway.example.com\r\nX-Evil: 1')).toBeNull()
    expect(safeHostHeader('gateway.example.com\n')).toBe('gateway.example.com')
  })

  it('matches exact and wildcard host entries, denying otherwise', async () => {
    await expect(hostMatchesAllowlist('gateway.example.com', ['gateway.example.com'])).resolves.toBe(true)
    await expect(hostMatchesAllowlist('gw.example.com', ['*.example.com'])).resolves.toBe(true)
    await expect(hostMatchesAllowlist('a.b.example.com', ['*.example.com'])).resolves.toBe(false)
    await expect(hostMatchesAllowlist('example.com', ['*.example.com'])).resolves.toBe(false)
    await expect(hostMatchesAllowlist('evil.test', ['*.example.com'])).resolves.toBe(false)
    await expect(hostMatchesAllowlist('', ['*.example.com'])).resolves.toBe(false)
  })
})

describe('GW-204 gateway enforcement', () => {
  it('drops forged proxy headers from an untrusted peer before any handler runs', async () => {
    const fetcher = vi.fn(async () => Response.json({ status: 'success', data: {} }))
    const app = createGatewayApp(config, fetcher as any, undefined, { trustedIngress: '10.0.0.0/8' })
    const res = await app.request(requestFromPeer('203.0.113.9', {
      headers: { 'X-Forwarded-For': '10.0.0.1', 'X-Real-IP': '10.0.0.1' },
    }))
    expect(res.status).toBe(403)
    expect((await res.json() as any).error.code).toBe('FORBIDDEN')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('accepts forwarded headers from an allowlisted ingress', async () => {
    const fetcher = vi.fn(async () => Response.json({ status: 'success', data: {} }))
    const app = createGatewayApp(config, fetcher as any, undefined, { trustedIngress: '10.0.0.0/8' })
    const res = await app.request(requestFromPeer('10.0.0.7', { headers: { 'X-Forwarded-For': '1.2.3.4' } }))
    expect(res.status).toBe(200)
  })

  it('treats every peer as untrusted when the ingress allowlist is empty', async () => {
    const app = createGatewayApp(config, vi.fn(async () => Response.json({ status: 'success', data: {} })) as any)
    const res = await app.request(requestFromPeer('127.0.0.1', { headers: { 'X-Forwarded-For': '1.2.3.4' } }))
    expect(res.status).toBe(403)
  })

  it('rejects a malformed or disallowed Host header', async () => {
    const fetcher = vi.fn(async () => Response.json({ status: 'success', data: {} }))
    const app = createGatewayApp(config, fetcher as any, undefined, { allowedHosts: 'gateway.example.com' })
    const ok = await app.request(requestFromPeer('10.0.0.7', { headers: { Host: 'gateway.example.com' } }))
    expect(ok.status).toBe(200)
    const bad = await app.request(requestFromPeer('10.0.0.7', { headers: { Host: 'evil.test' } }))
    expect(bad.status).toBe(403)
    expect((await bad.json() as any).error.code).toBe('BAD_HOST')
    const injected = await app.request(requestFromPeer('10.0.0.7', { headers: { Host: 'evil.test:80/../gateway.example.com' } }))
    expect(injected.status).toBe(403)
    // CRLF cannot be constructed through the Headers API; safeHostHeader is the
    // last line of defence for raw parsers that allow it.
    expect(safeHostHeader('gateway.example.com\r\nX-Evil: 1')).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('never reflects an arbitrary CORS origin', async () => {
    const fetcher = vi.fn(async () => Response.json({ status: 'success', data: {} }))
    const app = createGatewayApp(config, fetcher as any, undefined, { trustedIngress: '10.0.0.0/8' })
    const spoofed = await app.request(requestFromPeer('10.0.0.7', { headers: { Origin: 'https://evil.test' } }))
    expect(spoofed.status).toBe(403)
    expect((await spoofed.json() as any).error.code).toBe('ORIGIN_DENIED')
    expect(spoofed.headers.get('access-control-allow-origin')).toBeNull()
    expect(spoofed.headers.get('access-control-allow-credentials')).toBeNull()

    const allowed = await app.request(requestFromPeer('10.0.0.7', { headers: { Origin: 'https://theme.example' } }))
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://theme.example')
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('false')
    expect(allowed.headers.get('vary')).toContain('Origin')

    const pre = await app.request(requestFromPeer('10.0.0.7', { method: 'OPTIONS', headers: { Origin: 'https://evil.test' } }))
    expect(pre.status).toBe(403)
  })

  it('emits hardened boundary headers on every response', async () => {
    const fetcher = vi.fn(async () => Response.json({ status: 'success', data: {} }))
    const app = createGatewayApp(config, fetcher as any, undefined, { trustedIngress: '10.0.0.0/8' })
    const res = await app.request(requestFromPeer('10.0.0.7'))
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(res.headers.get('strict-transport-security')).toContain('max-age=31536000')
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(res.headers.get('x-request-id')).toBeTruthy()
  })
})

describe('GW-204 upstream access hardening', () => {
  const upstream = loadConfig({ TXBOARD_UPSTREAM_URL: 'https://txboard.example/' })

  it('refuses a 3xx redirect instead of following it to another host', async () => {
    const fetcher = vi.fn(async () => new Response(null, {
      status: 302, headers: { Location: 'https://evil.test/steal' },
    }))
    const app = createGatewayApp(upstream, fetcher as any, undefined, { trustedIngress: '10.0.0.0/8' })
    const res = await app.request(requestFromPeer('10.0.0.7'))
    expect(res.status).toBe(502)
    expect((await res.json() as any).error.code).toBe('UPSTREAM_ERROR')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect((fetcher.mock.calls[0] as any)[1].redirect).toBe('manual')
  })

  it('detects an origin mismatch when a redirect was followed anyway', async () => {
    // A custom fetcher (or undici internals) that ignores redirect:'manual'
    // returns a response whose url points at the final, different origin.
    const fetcher = vi.fn(async () => {
      const body = Response.json({ status: 'success', data: {} })
      Object.defineProperty(body, 'url', { value: 'https://evil.test/api/v1/guest/comm/config' })
      return body
    })
    const app = createGatewayApp(upstream, fetcher as any, undefined, { trustedIngress: '10.0.0.0/8' })
    const res = await app.request(requestFromPeer('10.0.0.7'))
    expect(res.status).toBe(502)
    expect((await res.json() as any).error.message).toBe('Upstream response origin mismatch')
  })

  it('accepts a response from the configured origin', async () => {
    const fetcher = vi.fn(async () => Response.json(
      { status: 'success', data: {} },
      { headers: { 'content-type': 'application/json' } },
    ))
    const app = createGatewayApp(upstream, fetcher as any, undefined, { trustedIngress: '10.0.0.0/8' })
    const res = await app.request(requestFromPeer('10.0.0.7'))
    expect(res.status).toBe(200)
  })
})
