import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { requireSession } from '../auth/middleware';
import type { AuthEnv } from '../auth/middleware';
import { requireAdmin } from '../auth/roles';
import { validateCsrfRequest } from '../auth/csrf';
import { createUser } from './create-user';
import type { CreateUserInput } from './create-user';
import { updateUser } from './update-user';
import { getAdminUserDetail } from './user-detail';
import type { UpdateUserPatch } from './update-user';
import { ADMIN_USER_PROJECTION_FROM_SQL, ADMIN_USER_PROJECTION_SQL, decodeAdminUserProjection } from './user-projection';
import type { AdminUserProjectionRow } from './user-projection';
import { prepare } from '../db';
import type { DbValue } from '../db';
import { ApiError, apiError, apiSuccess, createRequestId, parsePagination } from '../http';

export type { AdminUserListItem } from './user-projection';

export const ADMIN_USERS_PATH = '/api/v1/admin/users';
export const ADMIN_USER_BODY_MAX_BYTES = 8 * 1024;
export interface AdminUserRouteDependencies { database: D1Database; now(): number; trustedOrigin?: string | (() => string | Promise<string>) }
export type AdminUserDependencySource = AdminUserRouteDependencies
  | ((env: AuthEnv['Bindings'], request: Request) => AdminUserRouteDependencies | Promise<AdminUserRouteDependencies>);
interface RouteEnv extends AuthEnv { Variables: AuthEnv['Variables'] & { requestTime?: number; userDependencies?: AdminUserRouteDependencies } }
type Status = 'active' | 'disabled' | null;
type Cursor = [1, actorId: string, status: Status, groupId: string | null, snapshotAt: number, createdAt: number, id: string];

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value);
}
function encode(cursor: Cursor): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(cursor))))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decode(raw: string, actorId: string, status: Status, groupId: string | null, now: number): Cursor {
  try {
    const bytes = Uint8Array.from(atob(raw.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!Array.isArray(value) || value.length !== 7 || value[0] !== 1 || value[1] !== actorId || value[2] !== status || value[3] !== groupId
      || !Number.isSafeInteger(value[4]) || value[4] < 0 || value[4] > now
      || !Number.isSafeInteger(value[5]) || value[5] < 0 || value[5] > value[4] || !validId(value[6])) throw new Error();
    const cursor = value as Cursor;
    if (encode(cursor) !== raw) throw new Error();
    return cursor;
  } catch { throw new ApiError('invalid_request'); }
}
function noStore(response: Response): Response { response.headers.set('Cache-Control', 'no-store'); return response; }

async function writeOrigin(dependencies: AdminUserRouteDependencies | undefined): Promise<string> {
  const configured = dependencies?.trustedOrigin;
  const origin = typeof configured === 'function' ? await configured() : configured;
  if (typeof origin !== 'string') throw new ApiError('service_unavailable');
  return origin;
}

async function readJsonBody(request: Request): Promise<unknown> {
  if (request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json' || request.body === null) {
    throw new ApiError('invalid_request');
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (part.value.byteLength > ADMIN_USER_BODY_MAX_BYTES - length) {
        void reader.cancel().catch(() => undefined);
        throw new ApiError('payload_too_large');
      }
      length += part.value.byteLength; chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    return input;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('invalid_request');
  } finally { reader.releaseLock(); }
}

/** Full-path user router. snapshotAt caps newly created users; it is not a database
 * snapshot of later status/group edits. Bindings are resolved per request only.
 */
export function createAdminUserRoutes(
  source: AdminUserDependencySource = (env) => ({ database: env.DB, now: Date.now }),
): Hono<RouteEnv> {
  const app = new Hono<RouteEnv>();
  app.onError((error, context) => noStore(apiError(error instanceof ApiError ? error : new ApiError('service_unavailable'),
    context.get('requestId') ?? createRequestId())));
  app.notFound((context) => noStore(apiError(new ApiError('not_found'), context.get('requestId') ?? createRequestId())));
  const initialize: MiddlewareHandler<RouteEnv> = async (context, next) => {
      context.set('requestId', context.get('requestId') ?? createRequestId());
      const dependencies = typeof source === 'function' ? await source(context.env, context.req.raw) : source;
      const now = dependencies.now();
      if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) throw new ApiError('service_unavailable');
      context.env = { ...context.env, DB: dependencies.database };
      context.set('requestTime', now);
      context.set('userDependencies', dependencies);
      await next();
      context.res.headers.set('Cache-Control', 'no-store');
    };
  app.get(ADMIN_USERS_PATH,
    initialize,
    (context, next) => requireSession(() => context.get('requestTime')!)(context, next),
    requireAdmin,
    async (context) => {
      const query = new URL(context.req.url).searchParams;
      for (const key of query.keys()) if (!['status', 'groupId', 'limit', 'cursor'].includes(key)) throw new ApiError('invalid_request');
      if (query.getAll('status').length > 1 || query.getAll('groupId').length > 1) throw new ApiError('invalid_request');
      const status = query.get('status');
      const groupId = query.get('groupId');
      if (status !== null && status !== 'active' && status !== 'disabled') throw new ApiError('invalid_request');
      if (groupId !== null && !validId(groupId)) throw new ApiError('invalid_request');
      const page = parsePagination(query);
      const actor = context.get('user').id;
      const now = context.get('requestTime')!;
      const cursor = page.cursor === null ? undefined : decode(page.cursor, actor, status, groupId, now);
      const snapshotAt = cursor?.[4] ?? now;
      const clauses = ['u.created_at<=?'];
      const values: DbValue[] = [snapshotAt];
      if (status !== null) { clauses.push('u.status=?'); values.push(status); }
      if (groupId !== null) { clauses.push('u.group_id=?'); values.push(groupId); }
      if (cursor) { clauses.push('(u.created_at<? OR (u.created_at=? AND u.id<?))'); values.push(cursor[5], cursor[5], cursor[6]); }
      values.push(page.limit + 1);
      const result = await prepare<AdminUserProjectionRow>(context.env.DB,
        `${ADMIN_USER_PROJECTION_SQL} ${ADMIN_USER_PROJECTION_FROM_SQL}
          WHERE ${clauses.join(' AND ')} ORDER BY u.created_at DESC,u.id DESC LIMIT ?`, values).all();
      const items = result.rows.slice(0, page.limit).map(decodeAdminUserProjection);
      const last = items.at(-1);
      const nextCursor = result.rows.length > page.limit && last ? encode([1, actor, status, groupId, snapshotAt, last.created_at, last.id]) : null;
      return noStore(apiSuccess({ items, nextCursor, snapshotAt }, context.get('requestId')));
    },
  );
  app.get(`${ADMIN_USERS_PATH}/:id`, initialize,
    (context, next) => requireSession(() => context.get('requestTime')!)(context, next), requireAdmin,
    async context => {
      const id = context.req.param('id');
      if (!validId(id) || id.includes('/') || new URL(context.req.url).search !== '') throw new ApiError('invalid_request');
      const user = await getAdminUserDetail(context.env.DB, id);
      if (!user) throw new ApiError('not_found');
      return noStore(apiSuccess(user, context.get('requestId')));
    });
  app.post(ADMIN_USERS_PATH,
    initialize,
    (context, next) => requireSession(() => context.get('requestTime')!)(context, next),
    requireAdmin,
    async (context) => {
      const origin = await writeOrigin(context.get('userDependencies'));
      if (typeof origin !== 'string') throw new ApiError('service_unavailable');
      validateCsrfRequest(context.req.raw, origin);
      if (new URL(context.req.url).searchParams.size !== 0) throw new ApiError('invalid_request');
      const input = await readJsonBody(context.req.raw);
      // A21 validates the complete allowlist and all field types before any KDF.
      const user = await createUser(context.env.DB, input as CreateUserInput, { actorId: context.get('user').id,
        operationId: context.get('requestId'), now: context.get('requestTime')! });
      return noStore(apiSuccess(user, context.get('requestId'), 201));
    },
  );
  app.patch(`${ADMIN_USERS_PATH}/:id`,
    initialize,
    (context, next) => requireSession(() => context.get('requestTime')!)(context, next),
    requireAdmin,
    async (context) => {
      const origin = await writeOrigin(context.get('userDependencies'));
      if (typeof origin !== 'string') throw new ApiError('service_unavailable');
      validateCsrfRequest(context.req.raw, origin);
      if (new URL(context.req.url).searchParams.size !== 0) throw new ApiError('invalid_request');
      const input = await readJsonBody(context.req.raw);
      if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('invalid_request');
      const body = input as Record<string, unknown>;
      if (Object.keys(body).some((key) => !['version', 'status', 'groupId', 'concurrencyLimit', 'rpmLimit', 'allowedGroupIds'].includes(key))
        || typeof body.version !== 'number' || !Number.isSafeInteger(body.version) || body.version < 1) throw new ApiError('invalid_request');
      const { version, ...patch } = body;
      const user = await updateUser(context.env.DB, context.req.param('id'), version, patch as UpdateUserPatch,
        { actorId: context.get('user').id, operationId: context.get('requestId'), now: context.get('requestTime')! });
      return noStore(apiSuccess(user, context.get('requestId')));
    },
  );
  return app;
}
