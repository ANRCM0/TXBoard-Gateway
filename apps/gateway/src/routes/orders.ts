import { upstreamRequest } from '../services/upstream.js'
import { toPublicOrderStatus, toPublicPaymentMethods } from '../adapters/txboard-v1.js'
import {
  ORDER_STATUSES,
  PREFIX,
  TRADE_NO_PATTERN,
} from '../middleware/request-context.js'
import {
  orderDetailSchema,
  orderListSchema,
  orderStatusSchema,
  paymentMethodsSchema,
} from '../contracts/schemas.js'
import { authBearer } from '../middleware/auth.js'
import { fail, ok, validated, type RouteContext, type RouteDeps } from './shared.js'

/**
 * routes/orders.ts — order and payment read routes plus the write ban.
 *
 * Order creation is permanently disabled at the Gateway (fixed 405), so no
 * order POST, charge, checkout or callback can ever reach upstream. Order
 * ownership itself is decided by Laravel, not here.
 */

export type OrdersRouteDeps = RouteDeps

function requireBearer(c: RouteContext): string | Response {
  const auth = authBearer(c)
  if (!auth) return fail(c, 'UNAUTHORIZED', 'Bearer token required', 401)
  return auth
}

/** Validate and normalize the single optional `status` query parameter. */
function parseStatusQuery(c: RouteContext): number | undefined | Response {
  const status = c.req.query('status')
  const keys = Object.keys(c.req.queries())
  if (keys.some(key => key !== 'status')
    || (status !== undefined && !ORDER_STATUSES.has(status))
    || (status !== undefined && c.req.queries('status')?.length !== 1)) {
    return fail(c, 'VALIDATION_ERROR', 'Invalid order query', 400)
  }
  return status === undefined ? undefined : Number(status)
}

/** Validate an order identifier path parameter. */
function parseTradeNo(c: RouteContext): string | Response {
  const tradeNo = c.req.param('tradeNo')
  if (!TRADE_NO_PATTERN.test(tradeNo)) {
    return fail(c, 'VALIDATION_ERROR', 'Invalid order identifier', 400)
  }
  return tradeNo
}

export function registerOrdersRoutes(
  app: {
    get(path: string, handler: (c: RouteContext) => Promise<Response> | Response): unknown
    post(path: string, handler: (c: RouteContext) => Promise<Response> | Response): unknown
  },
  deps: OrdersRouteDeps,
): void {
  const { config, fetcher } = deps

  app.get(`${PREFIX}/orders`, async c => {
    const auth = requireBearer(c)
    if (auth instanceof Response) return auth
    const status = parseStatusQuery(c)
    if (status instanceof Response) return status
    return ok(c, validated(orderListSchema, await upstreamRequest(config, fetcher, 'userOrders',
      { auth, status })))
  })

  app.get(`${PREFIX}/orders/:tradeNo`, async c => {
    const auth = requireBearer(c)
    if (auth instanceof Response) return auth
    const tradeNo = parseTradeNo(c)
    if (tradeNo instanceof Response) return tradeNo
    return ok(c, validated(orderDetailSchema,
      await upstreamRequest(config, fetcher, 'userOrderDetail', { auth, tradeNo })))
  })

  app.get(`${PREFIX}/orders/:tradeNo/status`, async c => {
    const auth = requireBearer(c)
    if (auth instanceof Response) return auth
    const tradeNo = parseTradeNo(c)
    if (tradeNo instanceof Response) return tradeNo
    const status = validated(orderStatusSchema,
      await upstreamRequest(config, fetcher, 'userOrderStatus', { auth, tradeNo }))
    return ok(c, toPublicOrderStatus(tradeNo, status))
  })

  app.get(`${PREFIX}/payments`, async c => {
    const auth = requireBearer(c)
    if (auth instanceof Response) return auth
    const methods = validated(paymentMethodsSchema,
      await upstreamRequest(config, fetcher, 'userPaymentMethods', { auth }))
    return ok(c, toPublicPaymentMethods(methods))
  })

  // Write ban: never proxied upstream, so no transaction side effect is possible.
  app.post(`${PREFIX}/orders`, c =>
    fail(c, 'METHOD_NOT_ALLOWED', 'Order creation is not available in Gateway v1 Phase 1', 405))
}
