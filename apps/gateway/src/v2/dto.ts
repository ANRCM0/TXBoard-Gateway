/**
 * v2/dto.ts — camelCase projection stubs for the `/txapi/*` surface.
 *
 * PR1 carries no upstream-touching v2 route, so there is nothing to project
 * yet. This module exists to fix the LAYER in one place before the business
 * routes arrive: everything a v2 handler returns to a client passes through
 * here, and upstream snake_case is converted to the v2 camelCase contract
 * here — never inside a handler, and never leaked raw to the client.
 *
 * The two helpers below are the shared pieces of that layer: the v2 pagination
 * body (`{items,total,current,pageSize}`, replacing v1's `{data,total}`) and
 * the fail-closed record projection. Business DTOs land here in later PRs.
 */

/** The v2 pagination body — the deliberate breaking change from v1. */
export type V2Page<T> = {
  items: T[]
  total: number
  current: number
  pageSize: number
}

/**
 * Build the v2 pagination body.
 *
 * Bounds are enforced here, once, for every paginated v2 route: `current` and
 * `pageSize` must be safe positive integers within their documented ranges, or
 * this throws `PAGINATION_INVALID`. No v2 handler can emit an unbounded or
 * non-numeric page.
 */
export function v2Page<T>(
  items: readonly T[],
  total: number,
  current: number,
  pageSize: number,
): V2Page<T> {
  if (!Number.isSafeInteger(current) || current < 1) {
    throw new RangeError('PAGINATION_INVALID')
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new RangeError('PAGINATION_INVALID')
  }
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RangeError('PAGINATION_INVALID')
  }
  return { items: [...items], total, current, pageSize }
}

/** Coerce an unknown payload into a plain record; anything else throws. */
export function v2Record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RangeError('UPSTREAM_CONTRACT_MISMATCH')
  }
  return value as Record<string, unknown>
}
