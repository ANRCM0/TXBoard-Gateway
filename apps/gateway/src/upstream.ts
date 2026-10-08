import type { GatewayConfig } from './env.js'

export type GatewayFailureCode =
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_ERROR'
  | 'PAYLOAD_TOO_LARGE'
  | 'VALIDATION_ERROR'
  | 'RATE_LIMITED'
  /** GW-203: upstream authentication is possible but a CAPTCHA must be satisfied. */
  | 'CAPTCHA_REQUIRED'

export class GatewayFailure extends Error {
  constructor(
    public readonly code: GatewayFailureCode,
    public readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export type UpstreamFetcher = typeof fetch

const allowlistedPaths = {
  guestConfig: '/api/v1/guest/comm/config',
  guestPlans: '/api/v1/guest/plan/fetch',
  login: '/api/v1/passport/auth/login',
  userProfile: '/api/v1/user/info',
  userOrders: '/api/v1/user/order/fetch',
  userOrderDetail: '/api/v1/user/order/detail',
  userSubscription: '/api/v1/user/getSubscribe',
  userPaymentMethods: '/api/v1/user/order/getPaymentMethod',
  userNotices: '/api/v1/user/notice/fetch',
  userStats: '/api/v1/user/getStat',
  userOrderStatus: '/api/v1/user/order/check',
  register: '/api/v1/passport/auth/register',
  sendEmailCode: '/api/v1/passport/comm/sendEmailVerify',
} as const

export type UpstreamOperation = keyof typeof allowlistedPaths

/** Read UTF-8 JSON with a strict byte cap, including chunked bodies. */
export async function boundedJson(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<unknown> {
  if (!stream) throw new GatewayFailure('UPSTREAM_ERROR', 502, 'Empty upstream response')
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      throw new GatewayFailure('PAYLOAD_TOO_LARGE', 413, 'JSON payload exceeds configured limit')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new GatewayFailure('UPSTREAM_ERROR', 502, 'Invalid upstream JSON')
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function publicErrorMessage(status: number): string {
  // Never echo upstream messages: a plugin/exception may contain PII or secrets.
  switch (status) {
    case 401: return 'Authentication failed'
    case 403: return 'Access denied'
    case 404: return 'Resource not found'
    case 422: return 'Invalid request data'
    case 429: return 'Too many requests'
    default: return status >= 500 ? 'Upstream request failed' : 'Upstream request rejected'
  }
}

export async function upstreamRequest(
  config: GatewayConfig,
  fetcher: UpstreamFetcher,
  operation: UpstreamOperation,
  options: {
    auth?: string
    body?: unknown
    status?: number
    tradeNo?: string
    current?: number
    pageSize?: number
  } = {},
): Promise<unknown> {
  // No untrusted path/host input can escape this static allowlist.
  const target = new URL(allowlistedPaths[operation], config.upstream)
  if (operation === 'userOrders' && options.status !== undefined) {
    target.searchParams.set('status', String(options.status))
  }
  if (operation === 'userOrderStatus' && options.tradeNo) {
    target.searchParams.set('trade_no', options.tradeNo)
  }
  if (operation === 'userOrderDetail' && options.tradeNo) {
    target.searchParams.set('trade_no', options.tradeNo)
  }
  if (operation === 'userNotices') {
    target.searchParams.set('current', String(options.current ?? 1))
    target.searchParams.set('pageSize', String(options.pageSize ?? 5))
  }
  const headers = new Headers({ Accept: 'application/json' })
  if (options.auth) headers.set('Authorization', options.auth)
  const method = operation === 'login' || operation === 'register' || operation === 'sendEmailCode'
    ? 'POST' : 'GET'
  if (method === 'POST') headers.set('Content-Type', 'application/json')
  // GW-204: pin the Host we send and refuse any response that was not served
  // from the configured origin. redirect:'manual' stops follow-through; the
  // response.url check catches a proxy that rewrote the effective URL, and the
  // 3xx status check covers Location-only redirects.
  const finalUrl = target.toString()
  try {
    const response = await fetcher(finalUrl, {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(config.timeoutMs),
      redirect: 'manual',
      cache: 'no-store',
    })
    if (response.status >= 300 && response.status < 400) {
      throw new GatewayFailure('UPSTREAM_ERROR', 502, 'Unexpected upstream redirect')
    }
    // A redirect that was followed despite redirect:'manual' (custom fetcher,
    // undici retry, DNS-rebinding proxy) would land on a different origin.
    if (response.url) {
      const landed = new URL(response.url)
      if (landed.origin !== target.origin) {
        throw new GatewayFailure('UPSTREAM_ERROR', 502, 'Upstream response origin mismatch')
      }
    }
    const contentLength = response.headers.get('content-length')
    if (contentLength && Number(contentLength) > config.maxResponseBytes) {
      await response.body?.cancel()
      throw new GatewayFailure('PAYLOAD_TOO_LARGE', 502, 'Upstream response too large')
    }
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      await response.body?.cancel()
      throw new GatewayFailure('UPSTREAM_ERROR', 502, 'Unexpected upstream content type')
    }
    let payload: unknown
    try {
      payload = await boundedJson(response.body, config.maxResponseBytes)
    } catch (error) {
      if (error instanceof GatewayFailure && error.code === 'PAYLOAD_TOO_LARGE') {
        throw new GatewayFailure('UPSTREAM_ERROR', 502, 'Upstream response too large')
      }
      throw error
    }
    const record = asRecord(payload)
    // Never swallow a TXBoard application-level error with HTTP 200.
    if (!response.ok || record.status === 'fail') {
      const status = response.status >= 400 ? response.status : 400
      throw new GatewayFailure('UPSTREAM_ERROR', status, publicErrorMessage(status))
    }
    // An unknown status is not a TXBoard business failure. Treat its
    // response as a broken contract rather than manufacturing HTTP 400.
    if (Object.hasOwn(record, 'status') && record.status !== 'success') {
      throw new GatewayFailure('UPSTREAM_ERROR', 502, 'Unexpected upstream response shape')
    }
    if (record.status === 'success') {
      if (!Object.hasOwn(record, 'data')) {
        throw new GatewayFailure('UPSTREAM_ERROR', 502, 'Invalid upstream success response')
      }
      return record.data
    }
    // Only the known legacy paginator format may omit a status envelope.
    // Unknown successful bodies must not masquerade as valid domain data.
    if (Array.isArray(record.data) && typeof record.total === 'number'
      && Number.isFinite(record.total) && record.total >= 0) {
      return operation === 'userNotices'
        ? { data: record.data, total: record.total }
        : record.data
    }
    throw new GatewayFailure('UPSTREAM_ERROR', 502, 'Unexpected upstream response shape')
  } catch (err) {
    if (err instanceof GatewayFailure) return Promise.reject(err)
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new GatewayFailure('UPSTREAM_UNAVAILABLE', 504, 'Upstream request timed out')
    }
    throw new GatewayFailure('UPSTREAM_UNAVAILABLE', 502, 'Upstream connection failed')
  }
}
