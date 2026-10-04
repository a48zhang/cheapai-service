import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { requireSession } from '../auth/middleware';
import type { AuthVariables } from '../auth/middleware';
import { requireAdmin } from '../auth/roles';
import { getChannelById } from '../catalog/channels';
import { validateCsrfRequest } from '../auth/csrf';
import { DEFAULT_CONFIG } from '../config';
import { ApiError, apiError, apiSuccess, createRequestId, parsePagination } from '../http';
import { createChannel, listChannels, updateChannel } from './channel-repository';
import type { ChannelEncryptionKey, ChannelPatch, CreateChannelInput } from './channel-repository';

export const ADMIN_CHANNELS_PATH = '/api/v1/admin/channels';
export const CHANNEL_BODY_MAX_BYTES = DEFAULT_CONFIG.adminBodyMaxBytes;
type Bindings = { DB: D1Database };
type RouteEnv<B extends Bindings> = { Bindings: B; Variables: AuthVariables & { channelNow: number } };
export interface ChannelRouteDependencies<B extends Bindings = Bindings> {
  now(): number;
  /** Writes resolve these only after session/admin authorization; GET never does. */
  trustedOrigin?: string | ((env: B, request: Request) => string | Promise<string>);
  encryptionKey?: ChannelEncryptionKey | ((env: B, request: Request) => ChannelEncryptionKey | Promise<ChannelEncryptionKey>);
}

async function protectWrite<B extends Bindings>(dependencies: ChannelRouteDependencies<B>, env: B, request: Request): Promise<void> {
  const configured = dependencies.trustedOrigin;
  const origin = typeof configured === 'function' ? await configured(env, request) : configured;
  if (typeof origin !== 'string') throw new ApiError('service_unavailable');
  validateCsrfRequest(request, origin);
}
async function encryptionKey<B extends Bindings>(dependencies: ChannelRouteDependencies<B>, env: B, request: Request): Promise<ChannelEncryptionKey> {
  const configured = dependencies.encryptionKey;
  const key = typeof configured === 'function' ? await configured(env, request) : configured;
  if (!key) throw new ApiError('service_unavailable');
  return key;
}
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json' || !request.body) throw new ApiError('invalid_request');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength > CHANNEL_BODY_MAX_BYTES - size) {
        void reader.cancel().catch(() => undefined);
        throw new ApiError('payload_too_large');
      }
      chunks.push(next.value); size += next.value.byteLength;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('invalid_request');
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('invalid_request');
  } finally { reader.releaseLock(); }
}

/** Independent factory; main routing and Env secret bindings belong to C17. */
export function createChannelRoutes<B extends Bindings = Bindings>(dependencies: ChannelRouteDependencies<B>): Hono<RouteEnv<B>> {
  const app = new Hono<RouteEnv<B>>();
  app.onError((error, context) => {
    const response = apiError(error instanceof ApiError ? error : new ApiError('service_unavailable'), context.get('requestId') ?? createRequestId());
    response.headers.set('Cache-Control', 'no-store');
    return response;
  });
  app.use('*', async (context, next) => {
    context.set('requestId', context.get('requestId') ?? createRequestId());
    const now = dependencies.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new ApiError('service_unavailable');
    context.set('channelNow', now);
    await next();
    context.res.headers.set('Cache-Control', 'no-store');
  });
  app.use('*', (context, next) => {
    const authenticate: MiddlewareHandler = requireSession(() => context.get('channelNow'));
    return authenticate(context, next);
  });
  app.use('*', requireAdmin);
  app.get(ADMIN_CHANNELS_PATH, async (context) => {
    const query = new URL(context.req.url).searchParams;
    for (const field of query.keys()) if (!['limit', 'cursor', 'status'].includes(field) || query.getAll(field).length !== 1) throw new ApiError('invalid_request');
    const status = query.get('status');
    if (status !== null && status !== 'active' && status !== 'disabled') throw new ApiError('invalid_request');
    const page = parsePagination(query);
    const result = await listChannels(context.env.DB, { limit: page.limit,
      ...(page.cursor === null ? {} : { cursor: page.cursor }), ...(status === null ? {} : { status }) });
    return apiSuccess(result, context.get('requestId'));
  });
  app.get(`${ADMIN_CHANNELS_PATH}/:id`, async (context) => {
    const id = context.req.param('id');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || new URL(context.req.url).search !== '') throw new ApiError('invalid_request');
    const channel = await getChannelById(context.env.DB, id);
    if (!channel) throw new ApiError('not_found');
    return apiSuccess(channel, context.get('requestId'));
  });
  app.post(ADMIN_CHANNELS_PATH, async (context) => {
    await protectWrite(dependencies, context.env, context.req.raw);
    if (new URL(context.req.url).search !== '') throw new ApiError('invalid_request');
    const body = await readBody(context.req.raw);
    if (Object.keys(body).some((field) => !['name', 'baseUrl', 'upstreamKey', 'concurrencyLimit', 'rpmLimit', 'priority', 'status'].includes(field))) throw new ApiError('invalid_request');
    const key = await encryptionKey(dependencies, context.env, context.req.raw);
    const result = await createChannel(context.env.DB, body as unknown as CreateChannelInput, {
      actorId: context.get('user').id, operationId: crypto.randomUUID(), now: context.get('channelNow'),
    }, key);
    return apiSuccess(result, context.get('requestId'), 201);
  });
  app.patch(`${ADMIN_CHANNELS_PATH}/:id`, async (context) => {
    await protectWrite(dependencies, context.env, context.req.raw);
    const id = context.req.param('id');
    if (id.trim() !== id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || new URL(context.req.url).search !== '') throw new ApiError('invalid_request');
    const body = await readBody(context.req.raw);
    if (Object.keys(body).some((field) => !['version', 'name', 'baseUrl', 'upstreamKey', 'concurrencyLimit', 'rpmLimit', 'priority', 'status'].includes(field))
        || typeof body.version !== 'number' || !Number.isSafeInteger(body.version) || body.version < 1) throw new ApiError('invalid_request');
    const { version, ...patch } = body;
    // Omission means preserve. Empty/null never requests credential deletion;
    // ordinary configuration edits must work without loading encryption secrets.
    const replacingKey = Object.hasOwn(patch, 'upstreamKey');
    if (replacingKey && (typeof patch.upstreamKey !== 'string' || patch.upstreamKey.trim() === '')) throw new ApiError('invalid_request');
    const key = replacingKey ? await encryptionKey(dependencies, context.env, context.req.raw) : undefined;
    const result = await updateChannel(context.env.DB, id, version, patch as ChannelPatch, {
      actorId: context.get('user').id, operationId: crypto.randomUUID(), now: context.get('channelNow'),
    }, key);
    return apiSuccess(result, context.get('requestId'));
  });
  app.notFound((context) => apiError(new ApiError('not_found'), context.get('requestId') ?? createRequestId()));
  return app;
}
