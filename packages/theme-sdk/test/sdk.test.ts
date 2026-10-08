import { describe, expect, it, vi } from 'vitest'
import { createTXBoardClient, GatewayApiError } from '../src/index.js'

function response(data: unknown, status = 200) {
  return Response.json({ ok: true, data, meta: { version: '1', requestId: 'test-id' } }, { status })
}
describe('@txboard/theme-sdk v1', () => {
  it('loads bootstrap and plans without sending bearer tokens', async () => {
    const fetchImpl = vi.fn(async (url: unknown) => {
      if (String(url).endsWith('bootstrap')) return response({
        site: { name: 'TXBoard' }, theme: { name: 'Nova', config: {} },
        security: { captcha: { enabled: false, type: null, siteKey: null } }, capabilities: [],
      })
      return response([{ id: 1, name: 'Monthly', month_price: 500 }])
    })
    const sdk = createTXBoardClient({ fetchImpl: fetchImpl as typeof fetch, getToken: () => 'secretBearer' })
    expect((await sdk.bootstrap()).site.name).toBe('TXBoard')
    expect((await sdk.plans.list())[0]?.month_price).toBe(500)
    for (const [, options] of fetchImpl.mock.calls as any) {
      expect(options.headers.has('Authorization')).toBe(false)
      expect(options.credentials).toBe('omit')
    }
  })

  it('never auto-stores login credentials and passes CAPTCHA input unchanged', async () => {
    const fetchImpl = vi.fn(async () => response({ auth_data: 'Bearer abcdef123456' }))
    const sdk = createTXBoardClient({ baseURL: '/gateway/v1', fetchImpl: fetchImpl as typeof fetch })
    const login = await sdk.auth.login({ email: 'user@example.com', password: 'longpassword', turnstile_token: 'cf-token' })
    expect(login.auth_data).toBe('Bearer abcdef123456')
    const [, options] = fetchImpl.mock.calls[0] as any[]
    expect(options.method).toBe('POST')
    expect(JSON.parse(options.body).turnstile_token).toBe('cf-token')
    expect(options.headers.has('Authorization')).toBe(false)
  })

  it('passes user token only to protected fixed routes and normalizes errors', async () => {
    const fetchImpl = vi.fn(async () => response({ email: 'a@example.com' }))
    const sdk = createTXBoardClient({ fetchImpl: fetchImpl as typeof fetch, getToken: async () => 'my-user-token' })
    expect((await sdk.user.profile()).email).toBe('a@example.com')
    expect((fetchImpl.mock.calls[0] as any)[1].headers.get('Authorization')).toBe('Bearer my-user-token')
    const orders = await sdk.orders.list({ status: 0 })
    expect(orders).toEqual({ email: 'a@example.com' })
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/gateway/v1/orders?status=0')
    const noSession = createTXBoardClient({ fetchImpl: fetchImpl as typeof fetch })
    await expect(noSession.user.profile()).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('surfaces a structured gateway error with request ID', async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      ok: false, error: { code: 'ORIGIN_DENIED', message: 'Origin is not allowed' },
      meta: { version: '1', requestId: 'req-123' },
    }, { status: 403 }))
    const sdk = createTXBoardClient({ fetchImpl: fetchImpl as typeof fetch })
    await expect(sdk.plans.list()).rejects.toMatchObject({
      code: 'ORIGIN_DENIED', status: 403, requestId: 'req-123',
    } satisfies Partial<GatewayApiError>)
  })

  it('rejects mismatched protocol responses and network errors without leaking URLs', async () => {
    const invalid = createTXBoardClient({ fetchImpl: vi.fn(async () =>
      Response.json({ ok: true, data: {}, meta: { version: '2' } })) as typeof fetch })
    await expect(invalid.bootstrap()).rejects.toMatchObject({ code: 'VERSION_MISMATCH' })
    const offline = createTXBoardClient({ fetchImpl: vi.fn(async () => {
      throw new Error('secret internal hostname')
    }) as typeof fetch })
    await expect(offline.plans.list()).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: 'Gateway is unavailable' })
  })
})
