import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { requireSession } from '../auth/middleware';
import type { AuthEnv } from '../auth/middleware';
import { requireAdmin } from '../auth/roles';
import { validateCsrfRequest } from '../auth/csrf';
import { ApiError, apiError, apiSuccess, createRequestId, parsePagination } from '../http';
import { createGroup, getGroupById, listGroups, updateGroup } from './group-repository';
import type { CreateGroupInput, GroupPatch } from './group-repository';

export const ADMIN_GROUPS_PATH = '/api/v1/admin/groups';
export const GROUP_BODY_MAX_BYTES = 16 * 1024;
export interface GroupRouteDependencies {
  database: D1Database;
  now(): number;
  /** Used only by authenticated writes; safe to omit for reads. */
  trustedOrigin?: string | (() => string | Promise<string>);
}
export type GroupDependencySource = GroupRouteDependencies
  | ((env: AuthEnv['Bindings'], request: Request) => GroupRouteDependencies | Promise<GroupRouteDependencies>);
interface RouteEnv extends AuthEnv { Variables: AuthEnv['Variables'] & { requestTime?: number; groupDependencies?: GroupRouteDependencies } }
function noStore(response: Response): Response { response.headers.set('Cache-Control', 'no-store'); return response; }

async function writeOrigin(dependencies: GroupRouteDependencies | undefined): Promise<string> {
  const configured = dependencies?.trustedOrigin;
  const origin = typeof configured === 'function' ? await configured() : configured;
  if (typeof origin !== 'string') throw new ApiError('service_unavailable');
  return origin;
}
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json' || !request.body) throw new ApiError('invalid_request');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      if (part.value.byteLength > GROUP_BODY_MAX_BYTES - size) {
        void reader.cancel().catch(() => undefined); throw new ApiError('payload_too_large');
      }
      chunks.push(part.value); size += part.value.byteLength;
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('invalid_request');
    return input as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('invalid_request');
  } finally { reader.releaseLock(); }
}

/** Full paths, mounted separately by C17. Binding/clock resolution is request-local. */
export function createGroupRoutes(source: GroupDependencySource = env => ({ database: env.DB, now: Date.now })): Hono<RouteEnv> {
  const app = new Hono<RouteEnv>();
  app.onError((error, context) => noStore(apiError(error instanceof ApiError ? error : new ApiError('service_unavailable'), context.get('requestId') ?? createRequestId())));
  app.notFound(context => noStore(apiError(new ApiError('not_found'), context.get('requestId') ?? createRequestId())));
  const initialize: MiddlewareHandler<RouteEnv> = async (context, next) => {
    context.set('requestId', context.get('requestId') ?? createRequestId());
    const dependencies = typeof source === 'function' ? await source(context.env, context.req.raw) : source;
    const now = dependencies.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) throw new ApiError('service_unavailable');
    context.env = { ...context.env, DB: dependencies.database };
    context.set('requestTime', now); context.set('groupDependencies', dependencies);
    await next(); context.res.headers.set('Cache-Control', 'no-store');
  };
  app.get(ADMIN_GROUPS_PATH, initialize,
    (context, next) => requireSession(() => context.get('requestTime')!)(context, next), requireAdmin,
    async context => {
      const query = new URL(context.req.url).searchParams;
      for (const key of query.keys()) if (!['status', 'limit', 'cursor'].includes(key)) throw new ApiError('invalid_request');
      if (query.getAll('status').length > 1) throw new ApiError('invalid_request');
      const status = query.get('status');
      if (status !== null && status !== 'active' && status !== 'disabled') throw new ApiError('invalid_request');
      const page = parsePagination(query);
      return noStore(apiSuccess(await listGroups(context.env.DB, { limit: page.limit,
        ...(page.cursor === null ? {} : { cursor: page.cursor }), ...(status === null ? {} : { status }) }), context.get('requestId')));
    });
  app.get(`${ADMIN_GROUPS_PATH}/:id`, initialize,
    (context, next) => requireSession(() => context.get('requestTime')!)(context, next), requireAdmin,
    async context => {
      const id = context.req.param('id');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || new URL(context.req.url).search !== '') throw new ApiError('invalid_request');
      const group = await getGroupById(context.env.DB, id);
      if (!group) throw new ApiError('not_found');
      return noStore(apiSuccess(group, context.get('requestId')));
    });
  app.post(ADMIN_GROUPS_PATH, initialize,
    (context, next) => requireSession(() => context.get('requestTime')!)(context, next), requireAdmin,
    async context => {
      validateCsrfRequest(context.req.raw, await writeOrigin(context.get('groupDependencies')));
      if (new URL(context.req.url).search !== '') throw new ApiError('invalid_request');
      const body = await readBody(context.req.raw);
      if (Object.keys(body).some(key => !['name', 'status', 'channelIds', 'billingMultiplier'].includes(key))) throw new ApiError('invalid_request');
      const group = await createGroup(context.env.DB, body as unknown as CreateGroupInput, {
        actorId: context.get('user').id, operationId: context.get('requestId'), now: context.get('requestTime')! });
      return noStore(apiSuccess(group, context.get('requestId'), 201));
    });
  app.patch(`${ADMIN_GROUPS_PATH}/:id`, initialize,
    (context, next) => requireSession(() => context.get('requestTime')!)(context, next), requireAdmin,
    async context => {
      validateCsrfRequest(context.req.raw, await writeOrigin(context.get('groupDependencies')));
      if (new URL(context.req.url).search !== '') throw new ApiError('invalid_request');
      const body = await readBody(context.req.raw);
      if (Object.keys(body).some(key => !['version', 'name', 'status', 'channelIds', 'billingMultiplier'].includes(key))
        || typeof body.version !== 'number' || !Number.isSafeInteger(body.version) || body.version < 1) throw new ApiError('invalid_request');
      const { version, ...patch } = body;
      const group = await updateGroup(context.env.DB, context.req.param('id'), version, patch as GroupPatch, {
        actorId: context.get('user').id, operationId: context.get('requestId'), now: context.get('requestTime')! });
      return noStore(apiSuccess(group, context.get('requestId')));
    });
  return app;
}
