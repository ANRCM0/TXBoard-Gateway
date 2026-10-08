/**
 * TXBoard Gateway v1: framework-agnostic TypeScript client.
 * The SDK NEVER stores access tokens or credentials.
 */

export type GatewayMeta = { version: '1'; requestId: string }
export type GatewaySuccess<T> = { ok: true; data: T; meta: GatewayMeta }
export type GatewayFailure = {
  ok: false
  error: { code: string; message: string }
  meta: GatewayMeta
}
export type GatewayEnvelope<T> = GatewaySuccess<T> | GatewayFailure

export type ThemeData = { name: string; config: Record<string, unknown> }
export type SiteData = { name: string; description: string; url: string; logo: string }
export type CaptchaConfig = {
  enabled: boolean
  type: 'turnstile' | 'recaptcha' | 'recaptcha-v3' | null
  siteKey: string | null
}
export type BootstrapData = {
  site: SiteData
  theme: ThemeData
  security: { captcha: CaptchaConfig }
  capabilities: string[]
}

export type LoginPayload = {
  email: string
  password: string
  turnstile_token?: string
  recaptcha_v3_token?: string
  recaptcha_data?: string
  email_code?: string
}
export type UserAuth = { auth_data: string; is_admin?: boolean | number }
export type UserProfile = {
  email: string
  balance?: number
  plan_id?: number | null
  expired_at?: number | null
  [field: string]: unknown
}
export type Plan = {
  id: number
  name: string
  month_price?: number | null
  year_price?: number | null
  [field: string]: unknown
}
export type Order = {
  trade_no: string
  status: number
  plan_id: number
  period: string
  total_amount: number
  [field: string]: unknown
}

export class GatewayApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message)
    this.name = 'GatewayApiError'
  }
}

export type TXBoardClientOptions = {
  /** Defaults to /gateway/v1. Use an HTTPS URL for cross-origin frontend hosting. */
  baseURL?: string
  /** User bearer callback; never used for public endpoints. */
  getToken?: () => string | undefined | null | Promise<string | undefined | null>
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export function createTXBoardClient(options: TXBoardClientOptions = {}) {
  const baseURL = (options.baseURL || '/gateway/v1').replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl ?? fetch
  const timeout = options.timeoutMs ?? 10000
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 60000) {
    throw new Error('timeoutMs must be between 100 and 60000 milliseconds')
  }
  if (/^https?:\/\//.test(baseURL) && !baseURL.startsWith('https://')
    && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(baseURL + '/')) {
    throw new Error('Cross-origin Gateway access requires HTTPS')
  }

  async function invoke<T>(path: string, options: {
    method?: 'GET' | 'POST'
    body?: unknown
    protected?: boolean
  } = {}): Promise<T> {
    const headers = new Headers({ Accept: 'application/json' })
    if (options.body !== undefined) headers.set('Content-Type', 'application/json')

    if (options.protected) {
      const token = String(await optionsGetToken() || '').trim()
      if (!token) throw new GatewayApiError('UNAUTHORIZED', 401, 'User session is required')
      headers.set('Authorization', /^Bearer /i.test(token) ? token : `Bearer ${token}`)
    }
    let response: Response
    try {
      response = await fetchImpl(`${baseURL}${path}`, {
        method: options.method || 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.timeout(timeout),
      })
    } catch {
      throw new GatewayApiError('NETWORK_ERROR', 0, 'Gateway is unavailable')
    }

    let envelope: unknown
    try { envelope = await response.json() } catch {
      throw new GatewayApiError('INVALID_RESPONSE', response.status, 'Invalid Gateway response')
    }
    if (!envelope || typeof envelope !== 'object') {
      throw new GatewayApiError('INVALID_RESPONSE', response.status, 'Invalid Gateway response')
    }
    const result = envelope as Partial<GatewayEnvelope<T>>
    if (result.meta?.version !== '1') {
      throw new GatewayApiError('VERSION_MISMATCH', response.status, 'Unsupported Gateway contract version')
    }
    if (result.ok === false) {
      const error = (result as GatewayFailure).error
      throw new GatewayApiError(error?.code || 'GATEWAY_ERROR', response.status, error?.message || 'Gateway request failed', result.meta?.requestId)
    }
    if (!response.ok || result.ok !== true || !('data' in result)) {
      throw new GatewayApiError('INVALID_RESPONSE', response.status, 'Unexpected Gateway response', result.meta?.requestId)
    }
    return result.data as T
  }

  async function optionsGetToken() {
    return options.getToken ? options.getToken() : undefined
  }

  return {
    bootstrap: () => invoke<BootstrapData>('/bootstrap'),
    theme: {
      config: () => invoke<ThemeData>('/theme/config'),
    },
    plans: {
      list: () => invoke<Plan[]>('/plans'),
    },
    auth: {
      login: (payload: LoginPayload) => invoke<UserAuth>('/auth/login', { method: 'POST', body: payload }),
    },
    user: {
      profile: () => invoke<UserProfile>('/user/profile', { protected: true }),
    },
    orders: {
      list: (query: { status?: 0 | 1 | 2 | 3 } = {}) => invoke<Order[]>(
        query.status === undefined ? '/orders' : `/orders?status=${query.status}`,
        { protected: true },
      ),
    },
  }
}

export type TXBoardClient = ReturnType<typeof createTXBoardClient>
