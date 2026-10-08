import type { CryptoService } from '../services/crypto.js'
import { upstreamRequest } from '../services/upstream.js'
import { toPublicCaptcha, toPublicSite, toPublicTheme } from '../adapters/txboard-v1.js'
import { planListSchema } from '../contracts/schemas.js'
import { PREFIX } from '../middleware/request-context.js'
import { fail, ok, requiredRecord, validated, type RouteContext, type RouteDeps } from './shared.js'

/**
 * routes/public.ts — unauthenticated `publicRead` routes.
 *
 * No Bearer token, no HPKE, no Redis hard dependency. These routes never send
 * an Authorization header upstream and only expose the allowlisted public DTOs
 * produced by ../adapters/txboard-v1.ts. A route never talks to Redis or builds
 * an arbitrary upstream URL: the operation name is its only upstream coupling.
 */

export type PublicRouteDeps = RouteDeps & {
  crypto?: CryptoService
  accountWorkflows: boolean
}

export type RouteRegistrar = {
  get(path: string, handler: (c: RouteContext) => Promise<Response> | Response): unknown
}

export function registerPublicRoutes(app: RouteRegistrar, deps: PublicRouteDeps): void {
  const { config, fetcher, crypto, accountWorkflows } = deps

  app.get(`${PREFIX}/bootstrap`, async c => {
    const data = requiredRecord(await upstreamRequest(config, fetcher, 'guestConfig'))
    return ok(c, {
      site: toPublicSite(data),
      theme: toPublicTheme(data),
      security: { captcha: toPublicCaptcha(data) },
      capabilities: [
        'auth.login', 'user.profile', 'plans.list', 'orders.list', 'theme.config',
        'user.subscription.summary', 'orders.detail', 'payments.methods', 'notices.list',
        'dashboard.stats', 'orders.status',
        ...(crypto ? ['auth.login.encrypted'] : []),
        ...(accountWorkflows ? ['auth.register.encrypted', 'auth.email-code.encrypted'] : []),
      ],
    })
  })

  app.get(`${PREFIX}/theme/config`, async c => {
    const data = requiredRecord(await upstreamRequest(config, fetcher, 'guestConfig'))
    return ok(c, toPublicTheme(data))
  })

  app.get(`${PREFIX}/plans`, async c => {
    const plans = validated(planListSchema, await upstreamRequest(config, fetcher, 'guestPlans'))
    return ok(c, plans)
  })
}
