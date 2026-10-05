import { Hono } from 'hono';
import type { Env } from '../../env';
import { ApiError, apiError, apiSuccess, createRequestId } from '../../http';
import type { AuthGateNamespace, AuthRateConfig } from '../../limits/auth-rate-limit';
import { loginDesktop, LoginRateError } from './login';
import { authenticateDesktopSession, DesktopSessionAuthError } from './authenticate';
import { getOrCreateCurrentKey, DesktopKeyError } from './keys';
import type { DesktopKeyFailureReason } from './keys';
import { getDesktopAccount } from './account';
import { logoutDesktopSession } from './logout';

export const DESKTOP_LOGIN_PATH = '/api/v1/desktop/login';
export const DESKTOP_KEY_PATH = '/api/v1/desktop/key';
export const DESKTOP_ACCOUNT_PATH = '/api/v1/desktop/account';
export const DESKTOP_LOGOUT_PATH = '/api/v1/desktop/logout';
export const DESKTOP_LOGIN_BODY_MAX_BYTES = 8 * 1024;

export interface DesktopRouteDependencies {
  readonly database: D1Database;
  readonly gates: AuthGateNamespace;
  readonly now: () => number;
  readonly trustedIp: (request: Request) => string | Promise<string>;
  readonly rateConfig?: AuthRateConfig;
}

export type DesktopRouteDependencySource<Bindings extends object> = DesktopRouteDependencies
  | ((env: Bindings, request: Request) => DesktopRouteDependencies | Promise<DesktopRouteDependencies>);

type DesktopReason = DesktopKeyFailureReason | ConstructorParameters<typeof DesktopSessionAuthError>[0];
type DesktopErrorPayload = { error: { code: string; message: string; reason?: DesktopReason }; request_id: string };

async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json'
    || request.body === null) throw new ApiError('invalid_request');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let finished = false;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) { finished = true; break; }
      if (part.value.byteLength > DESKTOP_LOGIN_BODY_MAX_BYTES - length) {
        void reader.cancel().catch(() => undefined);
        throw new ApiError('payload_too_large');
      }
      length += part.value.byteLength;
      if (part.value.byteLength > 0) chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('invalid_request');
  } finally {
    if (!finished) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) as unknown;
  } catch {
    throw new ApiError('invalid_request');
  }
}

function requestId(context: { get(key: 'requestId'): unknown }): string {
  const current = context.get('requestId');
  return typeof current === 'string' ? current : createRequestId();
}

function desktopReason(error: unknown): DesktopReason | null {
  if (error instanceof DesktopSessionAuthError || error instanceof DesktopKeyError) return error.reason;
  return null;
}

async function errorResponse(error: unknown, id: string): Promise<Response> {
  const response = apiError(error instanceof ApiError ? error : new ApiError('service_unavailable', { cause: error }), id);
  const reason = desktopReason(error);
  if (reason === null) return response;

  // Only stable reasons from the two desktop authentication/key error types
  // cross this boundary. Exception text and causes are never serialized.
  const payload = await response.json<DesktopErrorPayload>();
  return Response.json({
    ...payload,
    error: { ...payload.error, reason },
  }, { status: response.status, headers: response.headers });
}

/** Build the four bearer-only desktop endpoints. Environment
 * bindings are supplied by a per-request resolver, never read at import time.
 */
export function createDesktopRoutes<Bindings extends object = Env>(source: DesktopRouteDependencySource<Bindings>) {
  const routes = new Hono<{ Bindings: Bindings; Variables: { requestId?: string } }>();
  routes.use('*', async (context, next) => {
    await next();
    context.res.headers.set('Cache-Control', 'no-store');
  });

  routes.post(DESKTOP_LOGIN_PATH, async context => {
    const id = requestId(context);
    let response: Response;
    try {
      const dependencies = typeof source === 'function' ? await source(context.env, context.req.raw) : source;
      if (!dependencies || typeof dependencies.trustedIp !== 'function') throw new ApiError('service_unavailable');
      const input = await readJson(context.req.raw);
      const trustedIp = await dependencies.trustedIp(context.req.raw);
      const result = await loginDesktop({
        database: dependencies.database,
        gates: dependencies.gates,
        now: dependencies.now,
        ...(dependencies.rateConfig === undefined ? {} : { rateConfig: dependencies.rateConfig }),
      }, input, trustedIp);
      response = apiSuccess(result, id);
    } catch (error) {
      response = await errorResponse(error, id);
      if (error instanceof LoginRateError) {
        response.headers.set('Retry-After', String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
      }
    }
    return response;
  });

  routes.post(DESKTOP_KEY_PATH, async context => {
    const id = requestId(context);
    try {
      const dependencies = typeof source === 'function' ? await source(context.env, context.req.raw) : source;
      const now = dependencies.now();
      const authenticated = await authenticateDesktopSession(dependencies.database, context.req.raw, now);
      const result = await getOrCreateCurrentKey(dependencies.database, authenticated.session, now);
      return apiSuccess(result, id);
    } catch (error) {
      return await errorResponse(error, id);
    }
  });

  routes.get(DESKTOP_ACCOUNT_PATH, async context => {
    const id = requestId(context);
    try {
      const dependencies = typeof source === 'function' ? await source(context.env, context.req.raw) : source;
      const authenticated = await authenticateDesktopSession(dependencies.database, context.req.raw, dependencies.now());
      return apiSuccess(await getDesktopAccount(dependencies.database, authenticated), id);
    } catch (error) {
      return await errorResponse(error, id);
    }
  });

  routes.post(DESKTOP_LOGOUT_PATH, async context => {
    const id = requestId(context);
    try {
      const dependencies = typeof source === 'function' ? await source(context.env, context.req.raw) : source;
      await logoutDesktopSession(dependencies.database, context.req.raw, dependencies.now());
      return apiSuccess({ loggedOut: true }, id);
    } catch (error) {
      return await errorResponse(error, id);
    }
  });

  return routes;
}
