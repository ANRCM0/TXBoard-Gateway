import {
  routeDefinitions,
  routeKey,
  type RouteDefinition,
  type RoutePolicy,
} from '../config/policies.js'
import type { GatewayFailure } from '../services/upstream.js'
import { authBearer } from './auth.js'
import { BEARER_PATTERN, PREFIX, failureEnvelope } from './request-context.js'
import { readJsonRequest } from './validation.js'

/**
 * middleware/policy.ts — the non-bypassable route policy layer (GW-212 / PR-B).
 *
 * One middleware, registered once between the global baseline and the route
 * handlers, enforces the compile-time policy of the matched route BEFORE the
 * handler runs:
 *
 *  - `auth: 'bearer'` with a missing or malformed Authorization header -> 401,
 *    before any upstream call and before the handler inspects the body;
 *  - `body: 'json'` / `body: 'hpke'` -> the envelope is read, size-capped and
 *    shape-checked here, so an unparsable or oversized body never reaches a
 *    handler or the upstream;
 *  - `disabledWrite` -> fixed 405 with zero upstream calls;
 *  - an unknown path or method is rejected here. It never falls through to a
 *    "closest match" policy and never reaches an upstream call.
 *
 * The GW-202 sliding-window limiter and the GW-203 login-protection counters
 * stay where they are (earlier in the chain, and inside the credential
 * handlers): they are additive defenses and this layer never weakens them.
 * Policy decisions are never taken from HTTP headers, a theme manifest, a
 * client capability or database theme config — only from the frozen table in
 * config/policies.ts. The global baseline, the static upstream allowlist,
 * Laravel's authority, response/log redaction and the payment write ban remain
 * non-overridable.
 */

export interface ResolvedRoutePolicy {
  definition: RouteDefinition
  policy: RoutePolicy
  /** Normalized uppercase HTTP method of the matched definition. */
  method: string
}

/** Context key under which the resolved policy is published to the handlers. */
export const POLICY_CONTEXT_KEY = 'routePolicy' as const
/** Context key under which the already-validated request body is published. */
export const POLICY_BODY_KEY = 'policyRequestBody' as const

/**
 * Compile the (optionally feature-flag-filtered) table into a lookup index.
 *
 * Method-specific entries always win over method-agnostic ones, and a longer
 * path wins over a shorter prefix of it, so `/gateway/v1/orders/:tradeNo`
 * never resolves to the `/gateway/v1/orders` entry.
 */
export function buildPolicyIndex(
  definitions: readonly RouteDefinition[],
): Map<string, ResolvedRoutePolicy> {
  const index = new Map<string, ResolvedRoutePolicy>()
  for (const definition of definitions) {
    index.set(routeKey(definition.method, definition.path), {
      definition,
      policy: definition.policy,
      method: definition.method.toUpperCase(),
    })
  }
  return index
}

/**
 * Resolve the policy of a request path + method with longest-prefix matching,
 * where a method-specific entry beats a method-agnostic entry of equal length.
 *
 * An unmatched path or method yields `undefined`, which the caller turns into a
 * rejection — there is no implicit default policy and no fall-through.
 */
export function resolvePolicy(
  path: string,
  method: string,
  index: Map<string, ResolvedRoutePolicy> = buildPolicyIndex(routeDefinitions),
): ResolvedRoutePolicy | undefined {
  const normalizedMethod = method.toUpperCase()
  const normalizedPath = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path

  let best: ResolvedRoutePolicy | undefined
  let bestLength = -1
  let bestIsMethodSpecific = false

  for (const [key, resolved] of index) {
    const separator = key.indexOf(' ')
    const entryMethod = key.slice(0, separator)
    const entryPath = key.slice(separator + 1)

    // Match on path-segment boundaries only: /gateway/v1/ordersX must never
    // match the /gateway/v1/orders entry.
    const isPrefix = normalizedPath === entryPath
      || normalizedPath.startsWith(entryPath.endsWith('/') ? entryPath : `${entryPath}/`)
    if (!isPrefix) continue

    const isMethodSpecific = entryMethod !== '*'
    if (isMethodSpecific && entryMethod !== normalizedMethod) continue

    const length = entryPath.length
    const wins = best === undefined
      || length > bestLength
      || (length === bestLength && isMethodSpecific && !bestIsMethodSpecific)
    if (!wins) continue

    best = resolved
    bestLength = length
    bestIsMethodSpecific = isMethodSpecific
  }
  return best
}

/** True when a resolved policy requires a JSON request envelope. */
export function requiresJsonBody(policy: RoutePolicy): boolean {
  return policy.body === 'json' || policy.body === 'hpke'
}

/** Sealed-envelope shape check, performed before any handler or upstream call. */
function looksSealed(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  const value = payload as Record<string, unknown>
  return typeof value.kid === 'string'
    && typeof value.enc === 'string'
    && typeof value.ct === 'string'
    && Number.isSafeInteger(value.ts)
    && typeof value.nonce === 'string'
}

type PolicyContext = {
  req: { path: string; method: string; header(name: string): string | undefined; raw: Request }
  header(name: string, value: string): void
  get(name: string): unknown
  set(name: string, value: unknown): void
}

type MiddlewareResult = Response | void

function reject(
  context: PolicyContext,
  code: string,
  message: string,
  status: 400 | 401 | 403 | 404 | 405 | 413,
): Response {
  const requestId = typeof context.get('requestId') === 'string'
    ? String(context.get('requestId'))
    : 'unknown'
  return new Response(JSON.stringify(failureEnvelope(requestId, code, message)), {
    status,
    headers: { 'content-type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

/**
 * Options the enforcement middleware takes from the composition root.
 */
export interface PolicyMiddlewareOptions {
  /** Frozen table, already filtered for the capabilities this deployment has. */
  definitions: readonly RouteDefinition[]
  /** Envelope byte cap, enforced before the body is read. */
  maxRequestBytes: number
}

/**
 * The enforcement middleware.
 *
 * Calls `next()` only when the resolved policy admits the request. Every
 * rejection happens here, before the route handler, so no handler is ever the
 * last thing between a client and an upstream call.
 */
export function policyEnforcementMiddleware(options: PolicyMiddlewareOptions) {
  const index = buildPolicyIndex(options.definitions)

  return async function enforcePolicy(
    context: PolicyContext,
    next: () => Promise<unknown>,
  ): Promise<MiddlewareResult> {
    const path = context.req.path
    const method = context.req.method.toUpperCase()

    // /healthz is the operator health probe, outside the /gateway/v1 surface.
    if (path === '/healthz') { await next(); return }
    if (!path.startsWith(`${PREFIX}/`)) {
      return reject(context, 'NOT_FOUND', 'Gateway route does not exist', 404)
    }

    const resolved = resolvePolicy(path, method, index)
    if (!resolved) {
      // Unknown path, or a method the frozen table does not list. Rejecting
      // here is what keeps an unlisted method unreachable rather than
      // implicitly permissive.
      return reject(context, 'NOT_FOUND', 'Gateway route does not exist', 404)
    }
    const { policy } = resolved
    context.set(POLICY_CONTEXT_KEY, resolved)

    if (policy.name === 'disabledWrite') {
      // Payment write ban: no upstream call is possible on this path, ever.
      return reject(context, 'METHOD_NOT_ALLOWED',
        'Order creation is not available in Gateway v1 Phase 1', 405)
    }

    if (policy.auth === 'bearer') {
      const authorization = context.req.header('Authorization') || ''
      if (!BEARER_PATTERN.test(authorization)) {
        return reject(context, 'UNAUTHORIZED', 'Bearer token required', 401)
      }
      // Shape only; Laravel decides what the token may see.
      context.set('bearerToken', authBearer(context) ?? authorization)
    }

    if (requiresJsonBody(policy)) {
      // Read and shape-check the envelope once, here, so no handler ever sees
      // an unparsable body and no oversized body ever reaches the upstream.
      let payload: unknown
      try {
        payload = await readJsonRequest(context.req.raw, options.maxRequestBytes)
      } catch (error) {
        const failure = error as GatewayFailure
        if (failure && failure.code === 'PAYLOAD_TOO_LARGE') {
          return reject(context, 'PAYLOAD_TOO_LARGE', 'Request body too large', 413)
        }
        return reject(context, 'VALIDATION_ERROR', 'Invalid JSON request', 400)
      }
      if (policy.body === 'hpke' && !looksSealed(payload)) {
        return reject(context, 'VALIDATION_ERROR', 'Invalid encrypted request', 400)
      }
      // Publish the validated body and hand the handler an equivalent request
      // so the consumed stream is never read twice. The non-standard properties
      // the global baseline attaches to the raw request (the sanitized client
      // IP, the socket peer) are NOT carried by the Request constructor, so
      // they are re-attached here — otherwise the IP dimension of the
      // credential-stuffing protection would silently lose its identity.
      context.set(POLICY_BODY_KEY, payload)
      const previous = context.req.raw
      const replayable = new Request(previous, { body: JSON.stringify(payload) })
      for (const property of ['__clientIp', '__peerIp']) {
        const value = (previous as unknown as Record<string, unknown>)[property]
        if (value !== undefined) {
          Object.defineProperty(replayable, property, { value, enumerable: false })
        }
      }
      Object.defineProperty(context.req, 'raw', {
        value: replayable,
        configurable: true,
      })
    }

    await next()
    return
  }
}

/** The resolved policy of the current request, for handlers and tests. */
export function resolvedPolicyOf(context: PolicyContext): ResolvedRoutePolicy | undefined {
  return context.get(POLICY_CONTEXT_KEY) as ResolvedRoutePolicy | undefined
}

/** The already-validated request body, when the resolved policy has one. */
export function policyBodyOf(context: PolicyContext): unknown {
  return context.get(POLICY_BODY_KEY)
}
