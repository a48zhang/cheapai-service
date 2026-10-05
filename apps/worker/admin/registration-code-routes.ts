import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { requireSession } from '../auth/middleware';
import type { AuthEnv } from '../auth/middleware';
import { requireAdmin } from '../auth/roles';
import { generateRegistrationCodes, listRegistrationCodes, revokeRegistrationCode, REGISTRATION_CODE_LIMITS } from '../auth/registration-codes';
import { validateCsrfRequest } from '../auth/csrf';
import { ApiError, apiError, apiSuccess, createRequestId, parsePagination } from '../http';

export const REGISTRATION_CODES_PATH = '/api/v1/admin/registration/codes';
export const REGISTRATION_CODE_REVOKE_PATH = `${REGISTRATION_CODES_PATH}/:id/revoke`;
export const REGISTRATION_CODE_CREATE_BODY_MAX_BYTES = 2048;
export interface RegistrationCodeRouteDependencies {
  database: D1Database;
  /** Trusted server clock, sampled once per request for auth and pagination. */
  now(): number;
  /** Required for POST only; existing read-only factory callers remain valid. */
  trustedOrigin?: string | (() => string | Promise<string>);
}
export type RegistrationCodeDependencySource = RegistrationCodeRouteDependencies
  | ((env: AuthEnv['Bindings'], request: Request) => RegistrationCodeRouteDependencies | Promise<RegistrationCodeRouteDependencies>);
interface RouteEnv extends AuthEnv {
  Variables: AuthEnv['Variables'] & { requestTime?: number; codeDependencies?: RegistrationCodeRouteDependencies };
}

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

async function writeOrigin(dependencies: RegistrationCodeRouteDependencies | undefined): Promise<string> {
  const configured = dependencies?.trustedOrigin;
  const origin = typeof configured === 'function' ? await configured() : configured;
  if (typeof origin !== 'string') throw new ApiError('service_unavailable');
  return origin;
}

/** Bound actual bytes for both code-writing endpoints, not Content-Length. */
async function readCodeJsonBody(request: Request): Promise<unknown> {
  if (request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json' || !request.body) throw new ApiError('invalid_request');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let parsed: unknown;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (part.value.byteLength > REGISTRATION_CODE_CREATE_BODY_MAX_BYTES - length) {
        void reader.cancel().catch(() => undefined);
        throw new ApiError('payload_too_large');
      }
      chunks.push(part.value); length += part.value.byteLength;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('invalid_request');
  } finally { reader.releaseLock(); }
  return parsed;
}

/** expiresAt is a required absolute UTC-millisecond safe integer. null never
 * means unlimited lifetime; A11 enforces future/30-day bounds for new batches
 * while allowing exact metadata replay after the original expiry has passed.
 */
async function readCreationBody(request: Request): Promise<{ quantity: number; expiresAt: number }> {
  const parsed = await readCodeJsonBody(request);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ApiError('invalid_request');
  const fields = parsed as Record<string, unknown>;
  if (Object.keys(fields).length !== 2 || !Object.hasOwn(fields, 'quantity') || !Object.hasOwn(fields, 'expiresAt')
      || typeof fields.quantity !== 'number' || !Number.isSafeInteger(fields.quantity) || fields.quantity < 1 || fields.quantity > REGISTRATION_CODE_LIMITS.quantity
      || typeof fields.expiresAt !== 'number' || !Number.isSafeInteger(fields.expiresAt) || fields.expiresAt < 0) throw new ApiError('invalid_request');
  return { quantity: fields.quantity, expiresAt: fields.expiresAt };
}

/** Mount at '/': this router owns its full path. No bindings are read at import
 * or factory time. POST issues plaintext only in the initial successful response.
 */
export function createRegistrationCodeRoutes(
  source: RegistrationCodeDependencySource = (env) => ({ database: env.DB, now: Date.now }),
): Hono<RouteEnv> {
  const app = new Hono<RouteEnv>();
  app.onError((error, context) => noStore(apiError(error instanceof ApiError ? error : new ApiError('service_unavailable', { cause: error }),
    context.get('requestId') ?? createRequestId())));
  app.notFound((context) => noStore(apiError(new ApiError('not_found'), context.get('requestId') ?? createRequestId())));
  const resolve: MiddlewareHandler<RouteEnv> = async (context, next) => {
      context.set('requestId', context.get('requestId') ?? createRequestId());
      const dependencies = typeof source === 'function' ? await source(context.env, context.req.raw) : source;
      const now = dependencies.now();
      if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) throw new ApiError('service_unavailable');
      // Replace only this request's binding object; never mutate the source env.
      // Existing auth middleware and the listing use the exact same resolved DB.
      context.env = { ...context.env, DB: dependencies.database };
      context.set('requestTime', now);
      context.set('codeDependencies', dependencies);
      await next();
      context.res.headers.set('Cache-Control', 'no-store');
    };
  app.get(REGISTRATION_CODES_PATH,
    resolve,
    (context, next) => requireSession(() => context.get('requestTime')!)(context, next),
    requireAdmin,
    async (context) => {
      const query = new URL(context.req.url).searchParams;
      for (const key of query.keys()) {
        if (!['limit', 'cursor', 'creatorFilter'].includes(key)) throw new ApiError('invalid_request');
      }
      if (query.getAll('creatorFilter').length > 1) throw new ApiError('invalid_request');
      const creatorFilter = query.get('creatorFilter');
      if (creatorFilter !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(creatorFilter)) throw new ApiError('invalid_request');
      const page = parsePagination(query);
      const result = await listRegistrationCodes(context.env.DB, {
        actorId: context.get('user').id,
        now: context.get('requestTime')!, limit: page.limit,
        ...(page.cursor === null ? {} : { cursor: page.cursor }),
        ...(creatorFilter === null ? {} : { createdBy: creatorFilter }),
      });
      return noStore(apiSuccess(result, context.get('requestId')));
    },
  );
  app.post(REGISTRATION_CODES_PATH,
    resolve,
    (context, next) => requireSession(() => context.get('requestTime')!)(context, next),
    requireAdmin,
    async (context) => {
      const trustedOrigin = await writeOrigin(context.get('codeDependencies'));
      if (typeof trustedOrigin !== 'string') throw new ApiError('service_unavailable');
      validateCsrfRequest(context.req.raw, trustedOrigin);
      if (new URL(context.req.url).search !== '') throw new ApiError('invalid_request');
      const operationId = context.req.header('Idempotency-Key');
      if (!operationId || operationId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(operationId)) throw new ApiError('invalid_request');
      const body = await readCreationBody(context.req.raw);
      const result = await generateRegistrationCodes(context.env.DB, {
        actorId: context.get('user').id, operationId, now: context.get('requestTime')!,
        quantity: body.quantity, expiresAt: body.expiresAt,
      });
      return noStore(apiSuccess(result, context.get('requestId'), result.replayed ? 200 : 201));
    },
  );
  app.post(REGISTRATION_CODE_REVOKE_PATH,
    resolve,
    (context, next) => requireSession(() => context.get('requestTime')!)(context, next),
    requireAdmin,
    async (context) => {
      const trustedOrigin = await writeOrigin(context.get('codeDependencies'));
      if (typeof trustedOrigin !== 'string') throw new ApiError('service_unavailable');
      validateCsrfRequest(context.req.raw, trustedOrigin);
      const id = context.req.param('id');
      if (typeof id !== 'string' || id.trim() !== id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)
          || new URL(context.req.url).search !== '') throw new ApiError('invalid_request');
      // No mutation options exist. Accept no body or an explicit empty JSON
      // object; actor/time/operation ID can never be supplied by the client.
      if (context.req.raw.body !== null) {
        const body = await readCodeJsonBody(context.req.raw);
        if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) throw new ApiError('invalid_request');
      }
      const result = await revokeRegistrationCode(context.env.DB, {
        actorId: context.get('user').id, codeId: id, operationId: crypto.randomUUID(), now: context.get('requestTime')!,
      });
      if (result.status === 'not_found') throw new ApiError('not_found');
      if (result.status === 'already_used') throw new ApiError('conflict');
      return noStore(apiSuccess(result, context.get('requestId')));
    },
  );
  return app;
}
