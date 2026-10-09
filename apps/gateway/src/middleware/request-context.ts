/**
 * middleware/request-context.ts — request-scoped constants and the response
 * envelope builders shared by every route module.
 *
 * The envelope shape `{ ok, data|error, meta: { version, requestId } }` is
 * contract-frozen: theme SDKs parse it, so a field rename is a breaking change.
 * This module holds no policy decisions and no Laravel semantics.
 */

export const CONTRACT_VERSION = '1'
export const PREFIX = '/gateway/v1'

/** Success envelope. */
export function successEnvelope(requestId: string, data: unknown, status: 200 | 201 = 200) {
  return { ok: true, data, meta: { version: CONTRACT_VERSION, requestId } }
}

/** Failure envelope. */
export function failureEnvelope(requestId: string, code: string, message: string) {
  return { ok: false, error: { code, message }, meta: { version: CONTRACT_VERSION, requestId } }
}

export type ErrorStatus =
  | 400 | 401 | 403 | 404 | 405 | 409 | 413 | 422 | 428 | 429 | 500 | 502 | 503 | 504

/**
 * Statuses a GatewayFailure may surface verbatim. Anything else collapses to
 * 502 so an unexpected backend status can never masquerade as a client error.
 */
export const PRESERVED_STATUSES: readonly number[] =
  [400, 401, 403, 404, 405, 409, 413, 422, 428, 429, 500, 502, 503, 504]

/** Bearer shape check only — never authorization. */
export const BEARER_PATTERN = /^Bearer [^\s]{8,4096}$/

/** Order identifiers are bounded safe tokens; anything else is rejected. */
export const TRADE_NO_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/

/** Order status query accepts only the four TXBoard states. */
export const ORDER_STATUSES: ReadonlySet<string> = new Set(['0', '1', '2', '3'])
