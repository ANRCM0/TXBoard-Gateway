import { createHash } from 'node:crypto'

/**
 * GW-304: order-write idempotency handling.
 *
 * Two header kinds exist and they are NOT interchangeable:
 *
 *  - `Idempotency-Key` — the client's own key (Stripe-style). Required on the
 *    write route, forwarded to Laravel verbatim. The Gateway validates its
 *    FORMAT and never its meaning; Laravel hashes it with the authenticated user and operation to identify
 *    the claim; it hashes the validated request body separately to detect
 *    same-key/different-body conflicts (docs/adr-order-idempotency.md).
 *
 *  - `X-Idempotency-Key-Hint` — derived BY THE GATEWAY from the validated body
 *    only (SHA-256 over the canonical JSON), without any user identity. ADR
 *    §7.2 is explicit: the hint is NOT authoritative. Laravel re-derives the
 *    final key from the authenticated user_id; a mismatch is a log signal, not
 *    a rejection. The Gateway computes it here purely so the backend has a
 *    cheap correlation value — it holds no idempotency state of its own and
 *    performs no deduplication.
 *
 * Bounds (256 bytes / 1..128 chars, URL-safe token) are enforced so a hostile
 * header can never blow up a log line or a Redis key upstream.
 */

/** Maximum accepted length of a client-supplied Idempotency-Key. */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128

/** Idempotency keys are bounded opaque tokens; anything else is rejected. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/

export type IdempotencyKeyVerdict =
  | { valid: true; key: string }
  | { valid: false; reason: 'missing' | 'malformed' | 'too_long' }

/**
 * Validate a client-supplied Idempotency-Key header value.
 *
 * Returns a verdict rather than throwing so the route layer can turn the
 * reason into the contract-frozen 400 response with a stable message.
 */
export function validateIdempotencyKey(header: string | null | undefined): IdempotencyKeyVerdict {
  if (header === null || header === undefined) {
    return { valid: false, reason: 'missing' }
  }
  // Multiple comma-separated keys are a client bug (or an injection attempt):
  // exactly one key is accepted, and never a list.
  const trimmed = header.trim()
  if (!trimmed) return { valid: false, reason: 'missing' }
  if (trimmed.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return { valid: false, reason: 'too_long' }
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(trimmed)) {
    return { valid: false, reason: 'malformed' }
  }
  return { valid: true, key: trimmed }
}

/**
 * Canonical JSON: keys sorted by Unicode code point, no insignificant
 * whitespace, UTF-8. This is the SAME canonicalization ADR §3.1 specifies for
 * the Laravel-side key, so the hint can be compared to the authoritative key
 * byte-for-byte if the backend chooses to.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => {
    if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return inner
    return Object.fromEntries(
      Object.keys(inner as Record<string, unknown>)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map(key => [key, (inner as Record<string, unknown>)[key]]),
    )
  })
}

/**
 * The Gateway-derived idempotency hint for an order body (ADR §7.2):
 * SHA-256 over the operation name and the canonical body, WITHOUT any user
 * identity — the Gateway never holds a trusted user_id, only the bearer token.
 */
export function orderIdempotencyHint(operation: string, body: unknown): string {
  return createHash('sha256')
    .update(`${operation}\n${canonicalJson(body)}`)
    .digest('hex')
}
