import type { Hono, Context } from 'hono'
import type { GatewayConfig } from '../config/env.js'
import {
  CONTRACT_VERSION_V2,
  PREFIX_V2,
  failureEnvelope,
  successEnvelope,
  type ErrorStatus,
} from '../middleware/request-context.js'
import { v2Capabilities } from './capabilities.js'

/**
 * v2/routes.ts — the `/txapi/*` route surface.
 *
 * PR1 registers exactly one route: `GET /txapi/healthz`, answered locally.
 * Everything else about the v2 surface is plumbing this PR exists to put in
 * place — the `txboard-v1` envelope version, the capability list, the scope
 * helper, the v2 policy table — and the business routes land in later PRs.
 *
 * This module deliberately reuses the v1 transport, policy, CORS, rate-limit
 * and observability machinery: only the prefix, the envelope version and the
 * DTO layer differ.
 */

/** Dependencies `registerV2Routes` needs from the composition root. */
export type V2RouteDeps = {
  config: GatewayConfig
  /** Enabled v2 feature flags (GATEWAY_V2_FEATURES), drives capabilities. */
  features: readonly string[]
}

type Bindings = { Bindings: Record<string, never>; Variables: { requestId: string } }
type V2Context = Context<Bindings>

/** Success response in the v2 envelope (`meta.version` = `txboard-v1`). */
function v2Ok(c: V2Context, data: unknown, status: 200 | 201 = 200) {
  return c.json(
    successEnvelope(c.get('requestId'), data, status, CONTRACT_VERSION_V2),
    status,
  )
}

/** Failure response in the v2 envelope (`meta.version` = `txboard-v1`). */
function v2Fail(c: V2Context, code: string, message: string, status: ErrorStatus) {
  return c.json(failureEnvelope(c.get('requestId'), code, message, CONTRACT_VERSION_V2), status)
}

/**
 * Register the v2 routes on the shared Hono app.
 *
 * `enabled` is GATEWAY_ENABLE_V2: when false, nothing under `/txapi/*` is
 * registered at all, so the prefix answers the standard 404 NOT_FOUND from
 * the global handler. There is no runtime switch inside a handler.
 */
export function registerV2Routes(app: Hono<Bindings>, deps: V2RouteDeps, enabled = true): void {
  if (!enabled) return

  app.get(`${PREFIX_V2}/healthz`, c => {
    // Gateway-local: no upstream call, no token, no secrets. Mirrors the v1
    // /healthz posture but reports the v2 contract version, so a client can
    // tell the two surfaces apart with one request.
    return c.json({
      status: 'ok',
      contract: CONTRACT_VERSION_V2,
      capabilities: v2Capabilities(deps.features),
    })
  })

  // A v2 route that throws (e.g. a RangeError from the DTO layer) is turned
  // into the standard v2 failure envelope by the global onError handler;
  // these local helpers keep the envelope construction identical here.
  void v2Ok
  void v2Fail
}
