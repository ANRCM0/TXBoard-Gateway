import { GatewayFailure } from '../services/upstream.js'
import { BEARER_PATTERN } from './request-context.js'

/**
 * middleware/auth.ts — bearer shape check and login-failure classification.
 *
 * This module performs NO Laravel business authorization. It only inspects
 * token and CAPTCHA *envelope shapes*; ownership and permission decisions stay
 * in Laravel. The outcome-driven credential-stuffing verdict state lives in
 * ./login-protection.ts.
 */

type AuthContext = {
  req: { header(name: string): string | undefined }
}

/** Bearer shape check. Returns null when the header is missing or malformed. */
export function authBearer(c: AuthContext): string | null {
  const value = c.req.header('Authorization') || ''
  if (!BEARER_PATTERN.test(value)) return null
  return value
}

/**
 * The Gateway never validates CAPTCHA tokens — it only checks whether a
 * standard challenge field was submitted, then forwards it verbatim for
 * Laravel CaptchaService to verify. An empty or whitespace-only token does
 * not satisfy the challenge.
 */
export function hasCaptchaField(data: Record<string, unknown>): boolean {
  for (const key of ['turnstile_token', 'recaptcha_v3_token', 'recaptcha_data']) {
    const value = data[key]
    if (typeof value === 'string' && value.trim()) return true
  }
  return false
}

/**
 * Only real upstream auth rejections advance the credential-stuffing counters.
 * Token validation failures (400/403/422) are not password attempts, so they
 * must not burn the victim's account budget or lock a legitimate user out.
 */
export function countsAsCredentialFailure(error: unknown): boolean {
  return error instanceof GatewayFailure && (error.status === 401 || error.status === 429)
}
