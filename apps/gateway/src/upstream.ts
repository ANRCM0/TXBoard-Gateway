import type { GatewayConfig } from './env.js'

export type GatewayFailureCode =
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_ERROR'
  | 'PAYLOAD_TOO_LARGE'
  | 'VALIDATION_ERROR'

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

function sanitizedMessage(value: unknown): string {
  if (typeof value !== 'string') return 'Upstream request rejected'
  return value.slice(0, 240) || 'Upstream request rejected'
}

export async function upstreamRequest(
  config: GatewayConfig,
  fetcher: UpstreamFetcher,
  operation: UpstreamOperation,
  options: {
    auth?: string
    body?: unknown
    status?: number
  } = {},
): Promise<unknown> {
  // No untrusted path/host input can escape this static allowlist.
  const target = new URL(allowlistedPaths[operation], config.upstream)
  if (operation === 'userOrders' && options.status !== undefined) {
    target.searchParams.set('status', String(options.status))
  }
  const headers = new Headers({ Accept: 'application/json' })
  if (options.auth) headers.set('Authorization', options.auth)
  const method = operation === 'login' ? 'POST' : 'GET'
  if (method === 'POST') headers.set('Content-Type', 'application/json')
  try {
    const response = await fetcher(target.toString(), {
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
    if (!response.ok || (typeof record.status === 'string' && record.status !== 'success')) {
      const status = response.status >= 400 ? response.status : 400
      throw new GatewayFailure('UPSTREAM_ERROR', status, status >= 500 ? 'Upstream request failed' : sanitizedMessage(record.message))
    }
    if (record.status === 'success') {
      if (!Object.hasOwn(record, 'data')) {
        throw new GatewayFailure('UPSTREAM_ERROR', 502, 'Invalid upstream success response')
      }
      return record.data
    }
    // Legacy TXBoard endpoints may return {data, total} directly.
    return payload
  } catch (err) {
    if (err instanceof GatewayFailure) return Promise.reject(err)
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new GatewayFailure('UPSTREAM_UNAVAILABLE', 504, 'Upstream request timed out')
    }
    throw new GatewayFailure('UPSTREAM_UNAVAILABLE', 502, 'Upstream connection failed')
  }
}
