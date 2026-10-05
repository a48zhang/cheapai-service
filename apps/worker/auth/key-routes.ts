import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { ApiError, apiError, apiSuccess, createRequestId } from '../http';
import { requireSession } from './middleware';
import type { AuthVariables } from './middleware';
import { createPlatformKey, findPlatformKeyById, listPlatformKeys, PlatformKeyCreationError, updatePlatformKey, revokePlatformKey } from './key-repository';
import type { CreatePlatformKeyInput, PlatformKeyListState, PlatformKeyPatch } from './key-repository';
import { validateCsrfRequest } from './csrf';
import { listAvailableKeyGroups } from './key-groups';

export const PLATFORM_KEYS_PATH = '/api/v1/keys';
export const PLATFORM_KEY_BODY_MAX_BYTES = 16_384;
type Bindings = { DB: D1Database };
type KeyRouteEnv<B extends Bindings> = { Bindings: B; Variables: AuthVariables & { keyNow: number } };
export interface KeyRouteDependencies<B extends Bindings = Bindings> {
  now(): number;
  /** Not accessed by GET. Writes resolve this only after session authentication. */
  trustedOrigin?: string | ((env: B, request: Request) => string | Promise<string>);
}

async function protectWrite<B extends Bindings>(dependencies: KeyRouteDependencies<B>, env: B, request: Request): Promise<void> {
  try {
    const configured = dependencies.trustedOrigin;
    const origin = typeof configured === 'function' ? await configured(env, request) : configured;
    if (typeof origin !== 'string') throw new Error();
    validateCsrfRequest(request, origin);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('service_unavailable', { cause: error });
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json' || !request.body) throw new ApiError('invalid_request');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > PLATFORM_KEY_BODY_MAX_BYTES - size) {
        void reader.cancel().catch(() => undefined);
        throw new ApiError('payload_too_large');
      }
      chunks.push(chunk.value); size += chunk.value.byteLength;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ApiError('invalid_request');
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('invalid_request');
  } finally { reader.releaseLock(); }
}

/** Independent factory: no main-router mounting or binding initialization. */
export function createKeyRoutes<B extends Bindings = Bindings>(dependencies: KeyRouteDependencies<B>): Hono<KeyRouteEnv<B>> {
  const app = new Hono<KeyRouteEnv<B>>();
  app.onError((error, context) => {
    const mapped = error instanceof ApiError ? error : error instanceof PlatformKeyCreationError ? new ApiError('forbidden')
      : error instanceof TypeError ? new ApiError('invalid_request') : new ApiError('service_unavailable', { cause: error });
    const response = apiError(mapped, context.get('requestId') ?? createRequestId());
    response.headers.set('Cache-Control', 'no-store');
    return response;
  });
  app.use('*', async (context, next) => {
    context.set('requestId', context.get('requestId') ?? createRequestId());
    let now: number;
    try { now = dependencies.now(); } catch (error) { throw new ApiError('service_unavailable', { cause: error }); }
    if (!Number.isSafeInteger(now) || now < 0) throw new ApiError('service_unavailable');
    context.set('keyNow', now);
    await next();
    context.res.headers.set('Cache-Control', 'no-store');
  });
  app.use('*', (context, next) => {
    const authenticate: MiddlewareHandler = requireSession(() => context.get('keyNow'));
    return authenticate(context, next);
  });
  app.get('/api/v1/account/key-groups', async context => {
    return apiSuccess({ items: await listAvailableKeyGroups(context.env.DB, context.get('user').id) }, context.get('requestId'));
  });
  app.get(PLATFORM_KEYS_PATH, async context => {
    const query = new URL(context.req.url).searchParams;
    const rawLimit = query.get('limit');
    if (rawLimit !== null && !/^[1-9]\d{0,2}$/.test(rawLimit)) throw new ApiError('invalid_request');
    const state = query.get('state') ?? 'all';
    const page = await listPlatformKeys(context.env.DB, context.get('user').id, {
      limit: rawLimit === null ? 20 : Number(rawLimit), state: state as PlatformKeyListState, cursor: query.get('cursor'),
    }, context.get('keyNow'));
    return apiSuccess(page, context.get('requestId'));
  });
  app.get(`${PLATFORM_KEYS_PATH}/:id`, async context => {
    const key = await findPlatformKeyById(context.env.DB, context.get('user').id, context.req.param('id'), context.get('keyNow'));
    if (!key) throw new ApiError('not_found');
    return apiSuccess(key, context.get('requestId'));
  });
  app.post(PLATFORM_KEYS_PATH, async context => {
    await protectWrite(dependencies, context.env, context.req.raw);
    const operationId = context.req.header('Idempotency-Key');
    const body = await readBody(context.req.raw);
    const result = await createPlatformKey(context.env.DB, context.get('user').id,
      { name: body.name, expiresAt: body.expiresAt, allowedModels: body.allowedModels, groupId: body.groupId, operationId } as CreatePlatformKeyInput, context.get('keyNow'));
    return apiSuccess(result, context.get('requestId'), result.kind === 'created' ? 201 : 200);
  });
  app.patch(`${PLATFORM_KEYS_PATH}/:id`, async context => {
    await protectWrite(dependencies, context.env, context.req.raw);
    const body = await readBody(context.req.raw);
    const version = body.version as number;
    const patch = {
      ...(Object.hasOwn(body, 'name') ? { name: body.name } : {}),
      ...(Object.hasOwn(body, 'expiresAt') ? { expiresAt: body.expiresAt } : {}),
      ...(Object.hasOwn(body, 'allowedModels') ? { allowedModels: body.allowedModels } : {}),
      ...(Object.hasOwn(body, 'groupId') ? { groupId: body.groupId } : {}),
    };
    const result = await updatePlatformKey(context.env.DB, context.get('user').id, context.req.param('id'), version,
      patch as PlatformKeyPatch, context.get('keyNow'));
    // Uniform zero-row response: no foreign-Key existence or permission oracle.
    if (result.kind === 'not_updated') throw new ApiError('conflict');
    return apiSuccess(result.key, context.get('requestId'));
  });
  app.post(`${PLATFORM_KEYS_PATH}/:id/revoke`, async context => {
    await protectWrite(dependencies, context.env, context.req.raw);
    const body = await readBody(context.req.raw);
    const result = await revokePlatformKey(context.env.DB, context.get('user').id,
      context.req.param('id'), body.version as number, context.get('keyNow'));
    if (result.kind === 'not_revoked') throw new ApiError('conflict');
    return apiSuccess(result, context.get('requestId'));
  });
  app.notFound(context => apiError(new ApiError('not_found'), context.get('requestId') ?? createRequestId()));
  return app;
}
