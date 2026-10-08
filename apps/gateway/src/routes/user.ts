import { upstreamRequest } from '../services/upstream.js'
import {
  noticeCurrentPattern,
  noticePageSchema,
  noticePageSizePattern,
  statsSchema,
  userProfileSchema,
} from '../contracts/schemas.js'
import { toPublicDashboardStats, toPublicSubscriptionSummary } from '../adapters/txboard-v1.js'
import { authBearer } from '../middleware/auth.js'
import { PREFIX } from '../middleware/request-context.js'
import { fail, ok, requiredRecord, validated, type RouteContext, type RouteDeps } from './shared.js'

/**
 * routes/user.ts — authenticated `userRead` routes.
 *
 * The Gateway only checks the Bearer *shape*. Laravel decides which user and
 * which orders a token may see; ownership is never inferred here. No shared
 * cache is used, so one user's data can never be served to another.
 */

export type UserRouteDeps = RouteDeps

/** 401 when the Authorization header is missing or malformed. */
function requireBearer(c: RouteContext): string | Response {
  const auth = authBearer(c)
  if (!auth) return fail(c, 'UNAUTHORIZED', 'Bearer token required', 401)
  return auth
}

export function registerUserRoutes(
  app: {
    get(path: string, handler: (c: RouteContext) => Promise<Response> | Response): unknown
  },
  deps: UserRouteDeps,
): void {
  const { config, fetcher } = deps

  app.get(`${PREFIX}/user/profile`, async c => {
    const auth = requireBearer(c)
    if (auth instanceof Response) return auth
    return ok(c, validated(userProfileSchema, await upstreamRequest(config, fetcher, 'userProfile', { auth })))
  })

  app.get(`${PREFIX}/user/subscription/summary`, async c => {
    const auth = requireBearer(c)
    if (auth instanceof Response) return auth
    const data = requiredRecord(await upstreamRequest(config, fetcher, 'userSubscription', { auth }))
    return ok(c, toPublicSubscriptionSummary(data))
  })

  app.get(`${PREFIX}/notices`, async c => {
    const auth = requireBearer(c)
    if (auth instanceof Response) return auth
    const params = c.req.queries()
    if (Object.keys(params).some(k => !['current', 'pageSize'].includes(k))
      || Object.values(params).some(a => a.length !== 1)) {
      return fail(c, 'VALIDATION_ERROR', 'Invalid notice query', 400)
    }
    const current = c.req.query('current') ?? '1'
    const pageSize = c.req.query('pageSize') ?? '5'
    if (!noticeCurrentPattern.test(current) || !noticePageSizePattern.test(pageSize)) {
      return fail(c, 'VALIDATION_ERROR', 'Invalid notice pagination', 400)
    }
    return ok(c, validated(noticePageSchema, await upstreamRequest(config, fetcher, 'userNotices',
      { auth, current: Number(current), pageSize: Number(pageSize) })))
  })

  app.get(`${PREFIX}/dashboard/stats`, async c => {
    const auth = requireBearer(c)
    if (auth instanceof Response) return auth
    const counts = validated(statsSchema, await upstreamRequest(config, fetcher, 'userStats', { auth }))
    return ok(c, toPublicDashboardStats(counts))
  })
}
