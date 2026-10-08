import { boundedJson, GatewayFailure } from '../services/upstream.js'

/**
 * middleware/validation.ts — shared request-body reading.
 *
 * Enforces content-type and the byte cap BEFORE any handler sees the payload,
 * so an oversized or non-JSON body never reaches a route or the upstream.
 */

/** Read a JSON request body with content-type and byte-cap enforcement. */
export async function readJsonRequest(request: Request, maxBytes: number): Promise<unknown> {
  const type = request.headers.get('content-type') || ''
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new GatewayFailure('VALIDATION_ERROR', 400, 'Content-Type must be application/json')
  }
  const len = request.headers.get('content-length')
  if (len && Number(len) > maxBytes) {
    throw new GatewayFailure('PAYLOAD_TOO_LARGE', 413, 'Request body too large')
  }
  try {
    return await boundedJson(request.body, maxBytes)
  } catch (e) {
    if (e instanceof GatewayFailure && e.code === 'PAYLOAD_TOO_LARGE') throw e
    throw new GatewayFailure('VALIDATION_ERROR', 400, 'Invalid JSON request')
  }
}
