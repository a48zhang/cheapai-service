import { Hono } from 'hono';
import { ApiError, apiError, apiSuccess, createRequestId } from '../http';
import { validateCsrfRequest } from './csrf';
import { login, LoginRateError } from './login';
import type { LoginDependencies } from './login';

export const LOGIN_PATH = '/api/v1/auth/login';
export const LOGIN_BODY_MAX_BYTES = 8 * 1024;

export interface LoginRouteDependencies extends LoginDependencies {
  trustedOrigin: string;
  /** Server/deployment adapter only. Never derive trust from body or arbitrary
   * forwarding headers; this route does not select an IP header on its own.
   */
  trustedIp(request: Request): string | Promise<string>;
}
export type LoginDependencySource<Bindings extends object> = LoginRouteDependencies
  | ((env: Bindings, request: Request) => LoginRouteDependencies | Promise<LoginRouteDependencies>);

async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json' || request.body === null) {
    throw new ApiError('invalid_request');
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (result.value.byteLength > LOGIN_BODY_MAX_BYTES - length) {
        // Do not let an untrusted cancellation callback delay the 413 response.
        void reader.cancel().catch(() => undefined);
        throw new ApiError('payload_too_large');
      }
      length += result.value.byteLength;
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('invalid_request');
  } finally {
    reader.releaseLock();
  }
}

/** Mount explicitly later; no bindings are accessed during module evaluation.
 * A dependency resolver should only resolve trusted deployment configuration:
 * do not consume request bodies, perform KDF, or authenticate inside the resolver.
 */
export function createLoginRoutes<Bindings extends object = Record<string, unknown>>(
  source: LoginDependencySource<Bindings>,
): Hono<{ Bindings: Bindings; Variables: { requestId: string } }> {
  const app = new Hono<{ Bindings: Bindings; Variables: { requestId: string } }>();
  app.post(LOGIN_PATH, async (context) => {
    const existingId = context.get('requestId');
    const requestId = typeof existingId === 'string' ? existingId : createRequestId();
    let response: Response;
    try {
      const dependencies = typeof source === 'function' ? await source(context.env, context.req.raw) : source;
      if (!dependencies || typeof dependencies.trustedIp !== 'function') throw new ApiError('service_unavailable');
      // Login is anonymous, but Origin and double-submit CSRF still precede all
      // body consumption, IP quota, user lookup and password verification.
      validateCsrfRequest(context.req.raw, dependencies.trustedOrigin);
      const body = await readJson(context.req.raw);
      const trustedIp = await dependencies.trustedIp(context.req.raw);
      const result = await login(dependencies, body, trustedIp);
      response = apiSuccess(result.user, requestId);
      response.headers.set('Set-Cookie', result.setCookie);
    } catch (error) {
      response = apiError(error instanceof ApiError ? error : new ApiError('service_unavailable', { cause: error }), requestId);
      if (error instanceof LoginRateError) response.headers.set('Retry-After', String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))));
    }
    response.headers.set('Cache-Control', 'no-store');
    return response;
  });
  return app;
}
