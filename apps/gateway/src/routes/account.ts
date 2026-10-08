import { GatewayFailure, upstreamRequest } from '../services/upstream.js'
import type { AccountLimiter } from '../services/redis-security.js'
import type { CryptoOperation, CryptoService, SealedRequest } from '../services/crypto.js'
import {
  emailCodeSchema,
  loginResultSchema,
  loginSchema,
  registerSchema,
  sealedRequestSchema,
} from '../contracts/schemas.js'
import { PREFIX } from '../middleware/request-context.js'
import { countsAsCredentialFailure, hasCaptchaField } from '../middleware/auth.js'
import {
  normalizeLoginEmail,
  type LoginAdmission,
  type LoginProtection,
} from '../middleware/login-protection.js'
import { readJsonRequest } from '../middleware/validation.js'
import { fail, ok, validated, type RouteContext, type RouteDeps } from './shared.js'

/**
 * routes/account.ts — credential and account-workflow routes.
 *
 * `login` keeps the existing plaintext path working: no HPKE upgrade is used as
 * a silent breaking change. `secureRegister` / `secureEmailCode` are gated on
 * HPKE + Redis + the feature flag together and stay off by default.
 *
 * This module creates no Laravel business permissions: password and CAPTCHA
 * verification, and account existence, remain Laravel's decision.
 */

export type AccountRouteDeps = RouteDeps & {
  crypto?: CryptoService
  limiter?: AccountLimiter
  loginProtection?: LoginProtection
  accountWorkflows: boolean
}

/** Resolve the sanitized client IP set by the trusted-proxy middleware. */
function clientIpOf(c: RouteContext): string | undefined {
  return (c.req.raw as unknown as { __clientIp?: string }).__clientIp
}

/** Redis account-level throttle protects the Gateway entry point. Laravel
 *  remains the authority for password and CAPTCHA and also needs own limits. */
async function checkAccountLimiter(
  c: RouteContext, limiter: AccountLimiter,
  action: 'login' | 'register' | 'email-code', email: string,
): Promise<Response | null> {
  try {
    await limiter.check(action, email, clientIpOf(c))
  } catch (error) {
    if (error instanceof GatewayFailure) {
      return fail(c, error.code, error.message, error.status as 400 | 429 | 503)
    }
    throw error
  }
  return null
}

/**
 * GW-203: outcome-driven anti-credential-stuffing. The verdict is decided on
 * the SUBMITTED email and the sanitized source IP only — never on whether the
 * account exists — so existing and unknown accounts receive byte-identical
 * statuses, codes and Retry-After headers at every step.
 */
async function applyLoginProtection(
  c: RouteContext,
  protection: LoginProtection | undefined,
  email: string,
  data: Record<string, unknown>,
): Promise<Response | null> {
  if (!protection) return null
  const clientIp = clientIpOf(c)
  let verdict: LoginAdmission
  try {
    verdict = await protection.admit(email, clientIp)
  } catch {
    // Fail closed: without the safety store, no login attempt may reach
    // Laravel. This mirrors the replay/rate-limit failure posture.
    return fail(c, 'UPSTREAM_UNAVAILABLE', 'Login protection unavailable', 503)
  }
  if (verdict.verdict === 'locked') {
    c.header('Retry-After', String(Math.ceil(verdict.retryAfterMs / 1000)))
    return fail(c, 'RATE_LIMITED', 'Too many requests', 429)
  }
  if (verdict.verdict === 'captcha' && !hasCaptchaField(data)) {
    return fail(c, 'CAPTCHA_REQUIRED', 'Verification required to continue', 428)
  }
  return null
}

export function createLoginHandler(deps: AccountRouteDeps) {
  const { config, fetcher, limiter, loginProtection } = deps
  return async function runLogin(c: RouteContext, raw: unknown): Promise<Response> {
    const checked = loginSchema.safeParse(raw)
    if (!checked.success) return fail(c, 'VALIDATION_ERROR', 'Invalid login data', 400)

    const clientIp = clientIpOf(c)
    if (limiter) {
      const rejected = await checkAccountLimiter(c, limiter, 'login', checked.data.email)
      if (rejected) return rejected
    }

    const email = normalizeLoginEmail(checked.data.email)
    const challenged = await applyLoginProtection(c, loginProtection, email, checked.data)
    if (challenged) return challenged

    let result: unknown
    try {
      result = await upstreamRequest(config, fetcher, 'login', { body: checked.data })
    } catch (error) {
      // A genuine upstream rejection advances the stuffing counters.
      if (loginProtection && countsAsCredentialFailure(error)) {
        try { await loginProtection.recordFailure(email, clientIp) } catch { /* logged elsewhere */ }
      }
      throw error
    }
    // A real success clears the account dimension. The IP dimension is
    // intentionally kept: one legitimate login must not launder the stuffing
    // counters of a shared or rotating source address.
    if (loginProtection) {
      try { await loginProtection.recordSuccess(email) } catch { /* non-fatal */ }
    }
    return ok(c, validated(loginResultSchema, result))
  }
}

export function registerAccountRoutes(
  app: {
    get(path: string, handler: (c: RouteContext) => Promise<Response> | Response): unknown
    post(path: string, handler: (c: RouteContext) => Promise<Response> | Response): unknown
  },
  deps: AccountRouteDeps,
): void {
  const { config, fetcher, crypto, limiter, accountWorkflows } = deps
  const runLogin = createLoginHandler(deps)

  app.post(`${PREFIX}/auth/login`, async c =>
    runLogin(c, await readJsonRequest(c.req.raw, config.maxRequestBytes)))

  if (crypto) {
    app.get(`${PREFIX}/crypto/key`, c => ok(c, crypto.publicKey()))

    /** Decrypt-then-dispatch wrapper for every sealed operation. */
    const secure = (operation: CryptoOperation, handle: (c: RouteContext, data: unknown) => Promise<Response>) =>
      async (c: RouteContext) => {
        const raw = await readJsonRequest(c.req.raw, config.maxRequestBytes)
        const checked = sealedRequestSchema.safeParse(raw)
        if (!checked.success) return fail(c, 'VALIDATION_ERROR', 'Invalid encrypted request', 400)
        // Operation-specific AEAD AAD: ciphertext cannot be replayed to
        // registration or email endpoints, even with the same key and nonce.
        const data = await crypto.open(checked.data as SealedRequest, operation)
        return handle(c, data)
      }

    app.post(`${PREFIX}/secure/auth/login`, secure('login', runLogin))

    if (accountWorkflows && limiter) {
      app.post(`${PREFIX}/secure/auth/register`, secure('register', async (c, data) => {
        const parsed = registerSchema.safeParse(data)
        if (!parsed.success) return fail(c, 'VALIDATION_ERROR', 'Invalid registration data', 400)
        const rejected = await checkAccountLimiter(c, limiter, 'register', parsed.data.email)
        if (rejected) return rejected
        return ok(c, validated(loginResultSchema,
          await upstreamRequest(config, fetcher, 'register', { body: parsed.data })))
      }))

      app.post(`${PREFIX}/secure/auth/email-code`, secure('email-code', async (c, data) => {
        const parsed = emailCodeSchema.safeParse(data)
        if (!parsed.success) return fail(c, 'VALIDATION_ERROR', 'Invalid verification request', 400)
        const rejected = await checkAccountLimiter(c, limiter, 'email-code', parsed.data.email)
        if (rejected) return rejected
        const result = await upstreamRequest(config, fetcher, 'sendEmailCode', { body: parsed.data })
        if (result !== true) throw new GatewayFailure('UPSTREAM_ERROR', 502, 'Unexpected upstream response shape')
        return ok(c, { sent: true })
      }))
    }
  }
}
