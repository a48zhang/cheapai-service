import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { Protocol } from '@sub2api/apicompat/types/shared';
import type { ChannelCapabilities } from '@sub2api/apicompat/capabilities/check';
import { requireSession } from '../auth/middleware';
import type { AuthVariables } from '../auth/middleware';
import { requireAdmin } from '../auth/roles';
import { validateCsrfRequest } from '../auth/csrf';
import { DEFAULT_CONFIG } from '../config';
import { ApiError, apiError, apiSuccess, createRequestId } from '../http';
import { createModelMapping, listModelMappings, updateModelMapping } from './model-mappings';
import type { ModelMappingPatch } from './model-mappings';

export const ADMIN_MAPPINGS_PATH = '/api/v1/admin/models/:publicModelId/mappings';
export const ADMIN_MAPPING_UPDATE_PATH = `${ADMIN_MAPPINGS_PATH}/:channelId/:protocol`;
export const MAPPING_BODY_MAX_BYTES = DEFAULT_CONFIG.adminBodyMaxBytes;
type Bindings = { DB: D1Database };
type RouteEnv<B extends Bindings> = { Bindings: B; Variables: AuthVariables & { mappingNow: number } };
export interface MappingRouteDependencies<B extends Bindings = Bindings> {
  now(): number;
  trustedOrigin?: string | ((env: B, request: Request) => string | Promise<string>);
}
async function protect<B extends Bindings>(dependencies: MappingRouteDependencies<B>, env: B, request: Request) {
  const source = dependencies.trustedOrigin;
  const origin = typeof source === 'function' ? await source(env, request) : source;
  if (typeof origin !== 'string') throw new ApiError('service_unavailable');
  validateCsrfRequest(request, origin);
}
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json' || !request.body) throw new ApiError('invalid_request');
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      if (next.value.byteLength > MAPPING_BODY_MAX_BYTES - size) { void reader.cancel().catch(() => undefined); throw new ApiError('payload_too_large'); }
      chunks.push(next.value); size += next.value.byteLength;
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ApiError('invalid_request');
    return body as Record<string, unknown>;
  } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError('invalid_request'); }
  finally { reader.releaseLock(); }
}

/** Site-admin configuration only. These mappings neither grant group access nor
 * establish actual protocol-adapter availability. C17 owns main-route mounting.
 */
export function createMappingRoutes<B extends Bindings = Bindings>(dependencies: MappingRouteDependencies<B>): Hono<RouteEnv<B>> {
  const app = new Hono<RouteEnv<B>>();
  app.onError((error, context) => {
    const response = apiError(error instanceof ApiError ? error : new ApiError('service_unavailable', { cause: error }), context.get('requestId') ?? createRequestId());
    response.headers.set('Cache-Control', 'no-store'); return response;
  });
  app.use('*', async (context, next) => {
    context.set('requestId', context.get('requestId') ?? createRequestId());
    const now = dependencies.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new ApiError('service_unavailable');
    context.set('mappingNow', now);
    await next(); context.res.headers.set('Cache-Control', 'no-store');
  });
  app.use('*', (context, next) => {
    const authenticate: MiddlewareHandler = requireSession(() => context.get('mappingNow'));
    return authenticate(context, next);
  });
  app.use('*', requireAdmin);
  app.get(ADMIN_MAPPINGS_PATH, async (context) => {
    const query = new URL(context.req.url).searchParams;
    for (const field of query.keys()) if (!['protocol', 'activeOnly'].includes(field) || query.getAll(field).length !== 1) throw new ApiError('invalid_request');
    const protocol = query.get('protocol');
    if (protocol !== null && !['chat', 'responses', 'messages'].includes(protocol)) throw new ApiError('invalid_request');
    const active = query.get('activeOnly');
    if (active !== null && active !== 'true' && active !== 'false') throw new ApiError('invalid_request');
    const items = await listModelMappings(context.env.DB, { publicModelId: context.req.param('publicModelId'),
      ...(protocol === null ? {} : { protocol: protocol as Protocol }), activeOnly: active === 'true' });
    return apiSuccess({ items }, context.get('requestId'));
  });
  app.post(ADMIN_MAPPINGS_PATH, async (context) => {
    await protect(dependencies, context.env, context.req.raw);
    if (new URL(context.req.url).search) throw new ApiError('invalid_request');
    const body = await readBody(context.req.raw);
    if (Object.keys(body).some((field) => !['channelId', 'protocol', 'upstreamModel', 'capabilities'].includes(field))) throw new ApiError('invalid_request');
    const result = await createModelMapping(context.env.DB, {
      publicModelId: context.req.param('publicModelId'), channelId: body.channelId as string,
      protocol: body.protocol as Protocol, upstreamModel: body.upstreamModel as string, capabilities: body.capabilities as ChannelCapabilities,
    }, { actorId: context.get('user').id, operationId: crypto.randomUUID(), now: context.get('mappingNow') });
    return apiSuccess(result, context.get('requestId'), 201);
  });
  app.patch(ADMIN_MAPPING_UPDATE_PATH, async (context) => {
    await protect(dependencies, context.env, context.req.raw);
    if (new URL(context.req.url).search) throw new ApiError('invalid_request');
    const body = await readBody(context.req.raw);
    if (Object.keys(body).some((field) => !['version', 'upstreamModel', 'capabilities'].includes(field))
        || typeof body.version !== 'number' || !Number.isSafeInteger(body.version) || body.version < 1) throw new ApiError('invalid_request');
    const { version, ...patch } = body;
    const result = await updateModelMapping(context.env.DB, { publicModelId: context.req.param('publicModelId'),
      channelId: context.req.param('channelId'), protocol: context.req.param('protocol') as Protocol }, version, patch as ModelMappingPatch,
    { actorId: context.get('user').id, operationId: crypto.randomUUID(), now: context.get('mappingNow') });
    return apiSuccess(result, context.get('requestId'));
  });
  app.notFound((context) => apiError(new ApiError('not_found'), context.get('requestId') ?? createRequestId()));
  return app;
}
