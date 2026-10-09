/**
 * v2/scope.ts — token scope resolution for the `/txapi/*` surface.
 *
 * The Gateway never decides what a token MAY see: Laravel owns that. What this
 * module does is resolve the scope the token DECLARES, so a route can refuse a
 * mismatched token at the boundary (fail-closed, 401 INVALID_TOKEN_SCOPE)
 * instead of forwarding a hopeless request upstream.
 *
 * Scope is read from two places, in this order:
 *   1. an explicit `X-TXBoard-Scope` request header (Gateway-issued, shape
 *      checked here) — used when the fronting proxy knows the scope;
 *   2. a `scope` claim inside the Bearer token payload itself. Only the JWT-ish
 *      `scope` / `scp` claims are read, and ONLY their shape is trusted; the
 *      value never authorizes anything on its own.
 *
 * A token whose scope cannot be determined is UNKNOWN, and an unknown scope is
 * never admitted to a scope-restricted route — the alternative ("let it pass
 * and let upstream decide") is exactly the fail-open path this module exists
 * to prevent.
 */

/** The scope subjects the v2 surface distinguishes. `machine` deliberately
 *  never appears: machine credentials bypass the Gateway entirely (server.v2
 *  heartbeats stay a direct-to-upstream concern, as in v1). */
export type SubjectScope = 'user' | 'agent' | 'unknown'

/** The header a scope-aware fronting proxy may set. Shape-checked, never trusted. */
export const SCOPE_HEADER = 'x-txboard-scope'

/** A declared scope like `agent:node-1` — the agent id is a bounded token. */
const AGENT_SCOPE_PATTERN = /^agent:([A-Za-z0-9_-]{1,64})$/

/** Shape of an agent scope, when the token declares one. */
export type AgentScope = { kind: 'agent'; agentId: string }

export type ResolvedScope =
  | { kind: 'user' }
  | AgentScope
  | { kind: 'unknown' }

/**
 * Parse a raw scope string into a resolved scope.
 *
 * Accepts exactly `user` or `agent:<id>` (bounded id). Everything else —
 * including an empty string, a bare `agent`, a `machine` scope, or anything
 * with unexpected characters — resolves to `unknown`.
 */
export function parseScopeValue(raw: string | undefined | null): ResolvedScope {
  const value = (raw ?? '').trim()
  if (value === 'user') return { kind: 'user' }
  const agent = AGENT_SCOPE_PATTERN.exec(value)
  if (agent) return { kind: 'agent', agentId: agent[1]! }
  return { kind: 'unknown' }
}

/** The raw claims a Bearer token payload may carry a scope in. */
export type TokenClaims = {
  scope?: unknown
  scp?: unknown
}

/**
 * Extract the scope claim from a decoded JWT payload. Only the string forms of
 * `scope` / `scp` are considered, and only when they parse as one of the
 * accepted values; a malformed or non-string claim yields `unknown`.
 */
export function scopeFromClaims(claims: TokenClaims): ResolvedScope {
  for (const key of ['scope', 'scp'] as const) {
    const value = claims[key]
    if (typeof value === 'string') {
      return parseScopeValue(value)
    }
  }
  return { kind: 'unknown' }
}

/**
 * Decode the payload segment of a JWT-shaped Bearer token WITHOUT verifying
 * it. Verification is Laravel's job; this only reads the declared scope so the
 * boundary can fail closed early. An unparseable token yields `unknown`.
 */
export function decodeBearerClaims(authorization: string | undefined | null): TokenClaims {
  const match = /^Bearer\s+(\S+)$/.exec((authorization ?? '').trim())
  if (!match) return {}
  const segments = match[1]!.split('.')
  if (segments.length < 2) return {}
  try {
    const json = JSON.parse(
      Buffer.from(segments[1]!, 'base64url').toString('utf8'),
    ) as unknown
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      return json as TokenClaims
    }
  } catch {
    // An undecodable payload is not an error here: the scope is simply unknown.
  }
  return {}
}

/**
 * Resolve the effective scope of a request: an explicit, shape-checked
 * `X-TXBoard-Scope` header wins; otherwise the token's own declared claim is
 * used; otherwise `unknown`.
 */
export function resolveScope(
  headers: { header(name: string): string | undefined },
  authorization: string | undefined | null,
): ResolvedScope {
  const fromHeader = headers.header(SCOPE_HEADER)
  if (fromHeader !== undefined && fromHeader.trim() !== '') {
    return parseScopeValue(fromHeader)
  }
  return scopeFromClaims(decodeBearerClaims(authorization))
}

/** True when the resolved scope satisfies the scope a route requires. */
export function scopeSatisfies(resolved: ResolvedScope, required: SubjectScope): boolean {
  if (required === 'user') return resolved.kind === 'user' || resolved.kind === 'agent'
  if (required === 'agent') return resolved.kind === 'agent'
  return true
}

/** The v2 error code for a scope mismatch (401). */
export const INVALID_TOKEN_SCOPE = 'INVALID_TOKEN_SCOPE'
