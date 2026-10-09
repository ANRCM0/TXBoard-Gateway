import { lookup } from 'node:dns/promises'

/**
 * GW-204: trusted-ingress IP allowlisting, header normalization and CORS hardening.
 *
 * Design rules:
 *  - Client IP is derived ONLY from the socket peer address; forwarded headers are
 *    honored exclusively when the peer matches an allowlisted ingress.
 *  - The header chain (X-Forwarded-For / X-Forwarded-Proto / X-Real-IP / X-Forwarded-Host)
 *    is rebuilt, never appended, so one hop cannot append to a spoofed value.
 *  - Requests carrying forged proxy headers from an untrusted peer are dropped before
 *    any handler runs (403), so downstream code can never observe them.
 */

export type IpAllowlist = ReadonlySet<string> | readonly string[] | string

export type ProxyVerdict = {
  /** True when the peer is a trusted ingress and headers may be honored. */
  trusted: boolean
  /** Client IP after applying trusted headers; always the peer IP when untrusted. */
  clientIp: string
  /** Whether the request claimed to be forwarded. */
  claimedForwarded: boolean
  /** Reason for an untrusted verdict, for structured logs. */
  reason?: 'peer_not_trusted' | 'forged_headers' | 'no_headers'
}

/** Normalize a possibly bracketed / IPv6-mapped peer address. */
export function normalizeIp(value: string): string {
  const v = value.trim().toLowerCase()
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v)
  if (mapped) return mapped[1]!
  const bare = v.replace(/^\[/, '').replace(/\]$/, '')
  // ::ffff:a.b.c.d hex form -> dotted quad
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare)
  if (hexMapped) {
    const high = parseInt(hexMapped[1]!, 16)
    const low = parseInt(hexMapped[2]!, 16)
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')
  }
  return bare
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const v = Number(p)
    if (v > 255) return null
    n = n * 256 + v
  }
  return n >>> 0
}

function ipv6Groups(ip: string): number[] | null {
  if (!ip.includes(':')) return null
  const halves = ip.split('::')
  if (halves.length > 2) return null
  const expand = (part: string) => part ? part.split(':').filter(Boolean) : []
  const head = expand(halves[0]!)
  const tail = halves.length === 2 ? expand(halves[1]!) : []
  const missing = 8 - head.length - tail.length
  if (missing < 0) return null
  const middle = halves.length === 2 ? new Array<string>(missing).fill('0') : []
  const groups = [...head, ...middle, ...tail].map(g => parseInt(g || '0', 16))
  if (groups.length !== 8 || groups.some(g => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null
  return groups
}

/** Parse "ip" or "ip/prefix" entries (IPv4 and IPv6, prefix default = exact host). */
export function parseIpEntry(entry: string): { ip: string; bits: number; family: 4 | 6 } | null {
  const trimmed = entry.trim().toLowerCase()
  if (!trimmed) return null
  const slash = trimmed.lastIndexOf('/')
  const ipPart = slash === -1 ? trimmed : trimmed.slice(0, slash)
  let bits = -1
  if (slash !== -1) {
    const raw = trimmed.slice(slash + 1)
    if (!/^\d{1,3}$/.test(raw)) return null
    bits = Number(raw)
  }
  const ip = normalizeIp(ipPart)
  if (ip.includes(':')) {
    const groups = ipv6Groups(ip)
    if (!groups) return null
    if (bits === -1) bits = 128
    if (bits > 128) return null
    return { ip: groups.map(g => g.toString(16)).join(':'), bits, family: 6 }
  }
  const n = ipv4ToInt(ip)
  if (n === null) return null
  if (bits === -1) bits = 32
  if (bits > 32) return null
  return { ip: String(n), bits, family: 4 }
}

type V4Entry = { network: number; bits: number; cidr: string }
type V6Entry = { groups: number[]; bits: number; cidr: string }

export type CompiledIpAllowlist = {
  entries: string[]
  v4: V4Entry[]
  v6: V6Entry[]
  empty: boolean
}

export function compileIpAllowlist(input: IpAllowlist): CompiledIpAllowlist {
  const raw: string[] = input instanceof Set
    ? [...input]
    : Array.isArray(input) ? [...input]
      : typeof input === 'string' ? input.split(',') : []
  const v4: V4Entry[] = []
  const v6: V6Entry[] = []
  const entries: string[] = []
  for (const item of raw) {
    const trimmed = item.trim()
    if (!trimmed) continue
    const parsed = parseIpEntry(trimmed)
    if (!parsed) throw new Error(`Invalid trusted ingress entry: ${trimmed}`)
    entries.push(trimmed)
    if (parsed.family === 4) {
      const shift = 32 - parsed.bits
      const network = shift === 32 ? 0 : ((Number(parsed.ip) >>> shift) << shift) >>> 0
      v4.push({ network, bits: parsed.bits, cidr: trimmed })
    } else {
      v6.push({ groups: ipv6Groups(parsed.ip)!, bits: parsed.bits, cidr: trimmed })
    }
  }
  return { entries, v4, v6, empty: entries.length === 0 }
}

export function ipMatches(allowlist: CompiledIpAllowlist, candidate: string): boolean {
  const ip = normalizeIp(candidate)
  if (!ip) return false
  if (ip.includes(':')) {
    const groups = ipv6Groups(ip)
    if (!groups) return false
    return allowlist.v6.some(({ groups: t, bits }) => {
      let remaining = bits
      for (let i = 0; i < 8 && remaining > 0; i++) {
        const take = Math.min(16, remaining)
        const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff
        if ((groups[i]! & mask) !== (t[i]! & mask)) return false
        remaining -= take
      }
      return true
    })
  }
  const n = ipv4ToInt(ip)
  if (n === null) return false
  return allowlist.v4.some(({ network, bits }) => {
    const shift = 32 - bits
    if (shift === 32) return network === 0 && n === 0
    return ((n >>> shift) << shift >>> 0) === network
  })
}

const PROXY_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-real-ip',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-server',
  'forwarded',
] as const

const HOP_BY_HOP = [
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'proxy-authorization', 'proxy-connection',
] as const

export function claimsForwarding(headers: Headers): boolean {
  return PROXY_HEADERS.some(h => headers.has(h))
}

/**
 * Classify a request. When the peer is untrusted and the request carries any
 * proxy header, the verdict is "forged_headers" and the caller MUST drop it.
 */
export function evaluateRequest(
  peerIp: string,
  headers: Headers,
  allowlist: CompiledIpAllowlist,
): ProxyVerdict {
  const peer = normalizeIp(peerIp)
  const claimed = claimsForwarding(headers)
  const trusted = ipMatches(allowlist, peer)
  if (!trusted) {
    return {
      trusted: false,
      clientIp: peer,
      claimedForwarded: claimed,
      reason: claimed ? 'forged_headers' : 'peer_not_trusted',
    }
  }
  if (!claimed) return { trusted: true, clientIp: peer, claimedForwarded: false, reason: 'no_headers' }
  // Trusted ingress: take the right-most address that is not itself a trusted
  // ingress; that is the last hop that cannot have been forged by our proxy.
  const xff = headers.get('x-forwarded-for') || ''
  const chain = xff.split(',').map(s => s.trim()).filter(Boolean).reverse()
  const fromChain = chain.find(ip => !ipMatches(allowlist, ip)) ?? null
  const realIp = headers.get('x-real-ip')
  let clientIp: string
  if (realIp) clientIp = normalizeIp(realIp)
  else if (fromChain) clientIp = fromChain
  else clientIp = chain.at(-1) ?? peer
  if (!clientIp) clientIp = peer
  return { trusted: true, clientIp, claimedForwarded: true }
}

/**
 * Rebuild the outgoing header set for the trusted-proxy chain. Never appends to
 * a client-supplied value; drops proxy and hop-by-hop headers entirely.
 */
export function sanitizeForwardedHeaders(source: Headers, verdict: ProxyVerdict): Headers {
  const out = new Headers()
  for (const [name, value] of source.entries()) {
    const key = name.toLowerCase()
    if (PROXY_HEADERS.includes(key as any)) continue
    if (HOP_BY_HOP.includes(key as any)) continue
    out.set(name, value)
  }
  if (verdict.trusted && verdict.claimedForwarded) {
    out.set('X-Forwarded-For', verdict.clientIp)
    out.set('X-Real-IP', verdict.clientIp)
    out.set('X-Forwarded-Proto', 'https')
  }
  for (const h of HOP_BY_HOP) out.delete(h)
  return out
}

/**
 * Host allowlist match. Exact entries are compared literally; "*.suffix"
 * entries match exactly one additional label (so a.b.example.com does not
 * match *.example.com). DNS resolution is only a name-to-IP comparison aid
 * and never widens the allowlist: a failed lookup is a deny.
 */
export async function hostMatchesAllowlist(host: string, allowed: readonly string[]): Promise<boolean> {
  const h = host.trim().toLowerCase().replace(/:\d{1,5}$/, '')
  if (!h) return false
  for (const raw of allowed) {
    const e = raw.trim().toLowerCase()
    if (!e) continue
    if (e.startsWith('*.')) {
      const suffix = e.slice(1)
      const prefix = h.slice(0, -suffix.length)
      if (h.endsWith(suffix) && prefix && !prefix.includes('.')) return true
    } else if (h === e) {
      return true
    }
  }
  return false
}

/** Exposed for diagnostics and upstream-forwarding call sites. */
export { lookup as dnsLookup }
