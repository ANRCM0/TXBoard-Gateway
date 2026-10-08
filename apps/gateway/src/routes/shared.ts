import type { Context } from 'hono'
import { GatewayFailure, type UpstreamFetcher } from '../services/upstream.js'
import {
  CONTRACT_VERSION,
  PREFIX,
  failureEnvelope,
  successEnvelope,
  type ErrorStatus,
} from '../middleware/request-context.js'

/**
 * routes/shared.ts — helpers shared by every route module: the frozen response
 * envelope, the upstream-shape guard, and the route dependency bundle.
 *
 * These are pure request plumbing. Authorization is never performed here.
 */

export type RouteContext = Context<any, any, any>

/** Success response in the contract-frozen `{ ok, data, meta }` envelope. */
export function ok(c: RouteContext, data: unknown, status: 200 | 201 = 200) {
  return c.json(successEnvelope(c.get('requestId'), data, status), status)
}

/** Failure response in the contract-frozen `{ ok, error, meta }` envelope. */
export function fail(c: RouteContext, code: string, message: string, status: ErrorStatus) {
  return c.json(failureEnvelope(c.get('requestId'), code, message), status)
}

/** Validate an upstream payload; a shape mismatch is always a 502, never a 4xx. */
export function validated<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new GatewayFailure('UPSTREAM_ERROR', 502, 'Unexpected upstream response shape')
  }
  return parsed.data
}

/** Upstream payloads for object-shaped routes must actually be JSON objects. */
export function requiredRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayFailure('UPSTREAM_ERROR', 502, 'Unexpected upstream response shape')
  }
  return value as Record<string, unknown>
}

export type RouteDeps = {
  config: import('../config/env.js').GatewayConfig
  fetcher: UpstreamFetcher
}

export { CONTRACT_VERSION, PREFIX }
