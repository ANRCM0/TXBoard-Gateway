import { PREFIX, PREFIX_V2 } from '../middleware/request-context.js'

export type GatewayConfig = {
  host: string
  port: number
  upstream: URL
  allowedOrigins: ReadonlySet<string>
  /** GW-204: ingress IPs/CIDRs whose forwarded headers may be trusted. Empty = trust nobody. */
  trustedIngress: string[]
  /** GW-204: allowed Host header values (exact or *.suffix). Empty = syntax check only. */
  allowedHosts: string[]
  /** GW-204: expected upstream hostnames; the resolved IP of the fetch is verified against these. */
  upstreamHosts: string[]
  timeoutMs: number
  maxRequestBytes: number
  maxResponseBytes: number
  /**
   * v2 (`/txapi/*`) infrastructure: when false, no `/txapi/*` route is
   * registered at all (the prefix answers a plain 404). Default true.
   * GATEWAY_ENABLE_V2=false disables it.
   */
  enableV2: boolean
  /** GATEWAY_V2_FEATURES: comma-separated v2 capability flags (e.g. `agent,theme`). */
  v2Features: string[]
}

function intSetting(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid gateway numeric configuration (expected ${min}-${max})`)
  }
  return parsed
}

function privateHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (name === 'localhost' || name === '::1' || name.endsWith('.localhost') || name.endsWith('.internal')) return true
  // Docker Compose service names are unqualified DNS labels.
  if (/^[a-z][a-z0-9-]{0,62}$/.test(name) && !name.includes('.')) return true
  const ip = name.split('.').map(Number)
  if (ip.length !== 4 || ip.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return false
  return ip[0] === 10 || ip[0] === 127 || (ip[0] === 172 && ip[1]! >= 16 && ip[1]! <= 31)
    || (ip[0] === 192 && ip[1] === 168)
}

/**
 * v2 feature flags: a comma-separated allowlist of capability names used to
 * grey the v2 surface (`GATEWAY_V2_FEATURES=agent,theme,knowledge`). Each
 * entry is a lowercase alphanumeric token with `-`/`_` separators, and a
 * duplicate is a configuration error: the flags gate capability NAMES, so a
 * repeated entry can never widen the enabled set but would hide a typo.
 */
function v2FeatureFlags(value: string | undefined): string[] {
  const features = (value || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
  const seen = new Set<string>()
  for (const feature of features) {
    if (!/^[a-z0-9_-]{1,64}$/.test(feature)) {
      throw new Error(`Invalid GATEWAY_V2_FEATURES entry: ${feature}`)
    }
    if (seen.has(feature)) {
      throw new Error(`Duplicate GATEWAY_V2_FEATURES entry: ${feature}`)
    }
    seen.add(feature)
  }
  return features
}

export function loadConfig(env: Record<string, string | undefined> = process.env): GatewayConfig {
  if (!env.TXBOARD_UPSTREAM_URL) throw new Error('TXBOARD_UPSTREAM_URL is required')
  let upstream: URL
  try {
    upstream = new URL(env.TXBOARD_UPSTREAM_URL)
  } catch {
    throw new Error('TXBOARD_UPSTREAM_URL must be an absolute http(s) URL')
  }
  if (!['http:', 'https:'].includes(upstream.protocol)
      || upstream.username || upstream.password || upstream.search || upstream.hash
      || upstream.pathname !== '/') {
    throw new Error('TXBOARD_UPSTREAM_URL must be a clean origin without credentials/path/query')
  }
  if (upstream.protocol === 'http:' && !(env.TXBOARD_ALLOW_PRIVATE_HTTP === 'true' && privateHost(upstream.hostname))) {
    throw new Error('HTTP upstream is allowed only for explicitly opted-in private hosts')
  }
  const allowedOrigins = new Set<string>()
  for (const raw of (env.GATEWAY_ALLOWED_ORIGINS || '').split(',')) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    let url: URL
    try { url = new URL(trimmed) } catch { throw new Error('Invalid allowed origin') }
    if (url.origin !== trimmed || url.username || url.password || !['https:', 'http:'].includes(url.protocol)) {
      throw new Error('Allowed origins must be exact http(s) origins without wildcard or path')
    }
    allowedOrigins.add(url.origin)
  }

  const trustedIngress = (env.GATEWAY_TRUSTED_INGRESS || '')
    .split(',').map(s => s.trim()).filter(Boolean)
  const allowedHosts = (env.GATEWAY_ALLOWED_HOSTS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  const upstreamHosts = (env.GATEWAY_UPSTREAM_HOSTS || upstream.hostname)
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)

  // The v2 surface is on by default; `false` (case-insensitive, whitespace
  // tolerated) is the only accepted opt-out, so an unparseable value can never
  // silently fall back to one side of the switch.
  const enableV2 = (env.GATEWAY_ENABLE_V2 ?? 'true').trim().toLowerCase()
  if (!['true', 'false'].includes(enableV2)) {
    throw new Error('GATEWAY_ENABLE_V2 must be "true" or "false"')
  }

  return {
    host: env.GATEWAY_HOST || '127.0.0.1',
    port: intSetting(env.GATEWAY_PORT, 8787, 1, 65535),
    upstream,
    allowedOrigins,
    trustedIngress,
    allowedHosts,
    upstreamHosts,
    timeoutMs: intSetting(env.GATEWAY_UPSTREAM_TIMEOUT_MS, 8000, 500, 60000),
    maxRequestBytes: intSetting(env.GATEWAY_MAX_REQUEST_BYTES, 16384, 1024, 1048576),
    maxResponseBytes: intSetting(env.GATEWAY_MAX_RESPONSE_BYTES, 1048576, 16384, 8388608),
    enableV2: enableV2 === 'true',
    v2Features: v2FeatureFlags(env.GATEWAY_V2_FEATURES),
  }
}

/** True when `path` belongs to either contract surface (`/gateway/v1` or `/txapi`). */
export function isContractPath(path: string): boolean {
  return path.startsWith(`${PREFIX}/`) || path.startsWith(`${PREFIX_V2}/`)
}
