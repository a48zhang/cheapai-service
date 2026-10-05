import type { MiddlewareHandler } from 'hono';
import { ApiError } from '../http';
import { findInternalPlatformKeyByHash } from './key-repository';
import type { InternalPlatformKeyAuth } from './key-repository';
import { getTokenDisplayPrefix, hashToken } from './tokens';

// Chat callers use the session-derived user ID and selected group directly;
// this re-export keeps the authentication entry points discoverable without
// exposing any raw or synthetic API credential.
export { authenticateWebChat, WebChatAuthError } from './web-chat-auth';
export type { WebChatAuthFailure } from './web-chat-auth';

export type PlatformKeyAuthFailure = 'invalid_api_key' | 'conflicting_api_key_headers' | 'authentication_unavailable';

/** Stable public classification; retain backend causes for Workers Logs. */
export class PlatformKeyAuthError extends ApiError {
  readonly status: 400 | 401 | 503;
  constructor(readonly reason: PlatformKeyAuthFailure, options?: ErrorOptions) {
    super(reason === 'invalid_api_key' ? 'unauthorized' : reason === 'conflicting_api_key_headers' ? 'invalid_request' : 'service_unavailable', options);
    this.name = 'PlatformKeyAuthError';
    this.status = reason === 'invalid_api_key' ? 401 : reason === 'conflicting_api_key_headers' ? 400 : 503;
  }
}

function credential(request: Request): string {
  const authorization = request.headers.get('Authorization');
  const apiKey = request.headers.get('x-api-key');
  if (authorization === null && apiKey === null) throw new PlatformKeyAuthError('invalid_api_key');
  let bearer: string | null = null;
  if (authorization !== null) {
    // Duplicate Headers values are comma-joined and fail this exact grammar.
    if (authorization.length > 256) throw new PlatformKeyAuthError('invalid_api_key');
    const match = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(authorization);
    if (!match?.[1]) throw new PlatformKeyAuthError('invalid_api_key');
    bearer = match[1];
  }
  // Validate every supplied credential: a valid alternative never hides a bad one.
  try {
    if (bearer !== null) getTokenDisplayPrefix('apiKey', bearer);
    if (apiKey !== null) getTokenDisplayPrefix('apiKey', apiKey);
  } catch { throw new PlatformKeyAuthError('invalid_api_key'); }
  if (bearer !== null && apiKey !== null && bearer !== apiKey) throw new PlatformKeyAuthError('conflicting_api_key_headers');
  return (bearer ?? apiKey)!;
}

/**
 * Platform-Key authentication only, against authoritative D1 on every request.
 * Cookies, query parameters, body owner IDs and forwarding headers confer no
 * identity. Authentication does not grant model access, check balances, acquire
 * leases, or contact an upstream; those remain explicit gateway admission steps.
 * SQL NULL model inheritance and [] denial remain distinct in the trusted result.
 */
export async function authenticatePlatformKey(database: D1Database, request: Request, now: number): Promise<InternalPlatformKeyAuth> {
  if (!Number.isSafeInteger(now) || now < 0) throw new PlatformKeyAuthError('authentication_unavailable');
  const token = credential(request);
  let stored: InternalPlatformKeyAuth | null;
  try {
    const digest = await hashToken('apiKey', token);
    stored = await findInternalPlatformKeyByHash(database, digest, now);
  } catch (error) { throw new PlatformKeyAuthError('authentication_unavailable', { cause: error }); }
  if (stored === null) throw new PlatformKeyAuthError('invalid_api_key');
  // No token or digest enters the request context; freeze the authoritative projection.
  return Object.freeze({
    key: Object.freeze({ ...stored.key, allowedModels: stored.key.allowedModels === null ? null : Object.freeze([...stored.key.allowedModels]) }),
    user: Object.freeze({ ...stored.user }), group: Object.freeze({ ...stored.group }),
  });
}

export interface PlatformKeyAuthEnv {
  Bindings: { DB: D1Database };
  Variables: { platformKeyAuth: InternalPlatformKeyAuth };
}

/**
 * Unmounted middleware for gateway composition. Throws PlatformKeyAuthError so
 * the gateway's native protocol error adapter chooses its JSON/SSE representation;
 * this module never emits a management-API success/error envelope.
 */
export function requirePlatformKey(now: () => number = Date.now): MiddlewareHandler<PlatformKeyAuthEnv> {
  return async (context, next) => {
    let at: number;
    try { at = now(); } catch (error) { throw new PlatformKeyAuthError('authentication_unavailable', { cause: error }); }
    const auth = await authenticatePlatformKey(context.env.DB, context.req.raw, at);
    context.set('platformKeyAuth', auth);
    // Business failures after successful authentication are not relabeled as auth failures.
    await next();
  };
}
