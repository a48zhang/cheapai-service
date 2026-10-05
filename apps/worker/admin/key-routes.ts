import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { batch, prepare } from '../db';
import { ApiError, apiError, apiSuccess, createRequestId } from '../http';
import { requireSession } from '../auth/middleware';
import type { AuthVariables } from '../auth/middleware';
import { requireAdmin } from '../auth/roles';
import { validateCsrfRequest } from '../auth/csrf';
import { buildAuditStatement } from './audit';

export const ADMIN_KEY_REVOKE_PATH = '/api/v1/admin/keys/:id/revoke';
export const ADMIN_KEY_REVOKE_BODY_MAX_BYTES = 1024;
type Bindings = { DB: D1Database };
type RouteEnv<B extends Bindings> = { Bindings: B; Variables: AuthVariables & { adminKeyNow: number } };
export interface AdminKeyRouteDependencies<B extends Bindings = Bindings> {
  now(): number;
  trustedOrigin: string | ((env: B, request: Request) => string | Promise<string>);
}
interface KeyState {
  id: string; userId: string; status: 'active' | 'revoked'; version: number; createdAt: number; updatedAt: number;
}
export interface AdminKeyRevocationResult { kind: 'revoked' | 'already_revoked'; key: KeyState }

function guardFailure(error: unknown): boolean {
  for (let depth = 0; error instanceof Error && depth < 4; depth++, error = error.cause) {
    if (error.message.includes('admin_key_revoke_conflict')) return true;
  }
  return false;
}

/** Admin variant of A25-U's status/CAS contract. Its owner-scoped standalone
 * mutation cannot atomically include audit or handle disabled owners, so this
 * small local batch deliberately does not call that self-service mutation.
 * Expired Keys and disabled owners/groups remain revocable by an active admin.
 */
async function revokeAsAdmin(database: D1Database, actorId: string, keyId: string, version: number, now: number): Promise<AdminKeyRevocationResult> {
  const authorized = () => prepare(database, `SELECT u.id FROM users u JOIN groups g ON g.id=u.group_id
    WHERE u.id=? AND u.role='admin' AND u.status='active' AND g.status='active' AND u.created_at<=? AND g.created_at<=?`, [actorId, now, now]).first();
  const read = () => prepare<KeyState>(database, "SELECT id,user_id AS userId,status,version,created_at AS createdAt,updated_at AS updatedAt FROM api_keys WHERE id=? AND kind='api'", [keyId]).first();
  if (!await authorized()) throw new ApiError('forbidden');
  const current = await read();
  if (!current) throw new ApiError('not_found');
  if (current.status === 'revoked') return { kind: 'already_revoked', key: current };
  if (current.version !== version || version >= Number.MAX_SAFE_INTEGER || current.createdAt > now || current.updatedAt > now) throw new ApiError('conflict');
  try {
    const results = await batch(database, [
      prepare<KeyState>(database, `UPDATE api_keys SET status='revoked',updated_at=?,version=version+1
        WHERE id=? AND user_id=? AND kind='api' AND status='active' AND version=? AND version<9007199254740991
          AND created_at<=? AND updated_at<=?
          AND EXISTS (SELECT 1 FROM users a JOIN groups g ON g.id=a.group_id
            WHERE a.id=? AND a.role='admin' AND a.status='active' AND g.status='active' AND a.created_at<=? AND g.created_at<=?)
        RETURNING id,user_id AS userId,status,version,created_at AS createdAt,updated_at AS updatedAt`,
      [now, keyId, current.userId, version, now, now, actorId, now, now]),
      prepare(database, "SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('{}','admin_key_revoke_conflict') END AS changed"),
      buildAuditStatement(database, { actor_id: actorId, operation_id: crypto.randomUUID(), created_at: now,
        action: 'api_keys.revoke', target_type: 'api_key', target_id: keyId,
        changes: { status: { before: 'active', after: 'revoked' }, version: { before: version, after: version + 1 } } }),
    ] as const);
    const key = results[0].rows[0];
    if (!key) throw new ApiError('service_unavailable');
    return { kind: 'revoked', key };
  } catch (error) {
    if (!await authorized()) throw new ApiError('forbidden');
    const committed = await read();
    if (committed?.status === 'revoked') return { kind: 'already_revoked', key: committed };
    if (!committed) throw new ApiError('not_found');
    if (guardFailure(error)) throw new ApiError('conflict');
    throw error;
  }
}

async function readVersion(request: Request): Promise<number> {
  if (request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json' || !request.body) throw new ApiError('invalid_request');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (part.value.byteLength > ADMIN_KEY_REVOKE_BODY_MAX_BYTES - size) {
        void reader.cancel().catch(() => undefined);
        throw new ApiError('payload_too_large');
      }
      chunks.push(part.value); size += part.value.byteLength;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ApiError('invalid_request');
    const body = parsed as Record<string, unknown>;
    if (Object.keys(body).length !== 1 || typeof body.version !== 'number' || !Number.isSafeInteger(body.version) || body.version < 1) throw new ApiError('invalid_request');
    return body.version;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('invalid_request');
  } finally { reader.releaseLock(); }
}

/** Independent router; the main router mounts it separately. */
export function createAdminKeyRoutes<B extends Bindings = Bindings>(dependencies: AdminKeyRouteDependencies<B>): Hono<RouteEnv<B>> {
  const app = new Hono<RouteEnv<B>>();
  app.onError((error, context) => {
    const response = apiError(error instanceof ApiError ? error : new ApiError('service_unavailable', { cause: error }), context.get('requestId') ?? createRequestId());
    response.headers.set('Cache-Control', 'no-store');
    return response;
  });
  app.use(ADMIN_KEY_REVOKE_PATH, async (context, next) => {
    context.set('requestId', context.get('requestId') ?? createRequestId());
    const now = dependencies.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new ApiError('service_unavailable');
    context.set('adminKeyNow', now);
    await next();
    context.res.headers.set('Cache-Control', 'no-store');
  });
  app.use(ADMIN_KEY_REVOKE_PATH, (context, next) => {
    const authenticate: MiddlewareHandler = requireSession(() => context.get('adminKeyNow'));
    return authenticate(context, next);
  });
  app.use(ADMIN_KEY_REVOKE_PATH, requireAdmin);
  app.post(ADMIN_KEY_REVOKE_PATH, async (context) => {
    const origin = typeof dependencies.trustedOrigin === 'function' ? await dependencies.trustedOrigin(context.env, context.req.raw) : dependencies.trustedOrigin;
    validateCsrfRequest(context.req.raw, origin);
    const id = context.req.param('id');
    if (id.trim() !== id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || /s2a_(?:key|session|invite|desktop)_/.test(id)
        || new URL(context.req.url).search !== '') throw new ApiError('invalid_request');
    const version = await readVersion(context.req.raw);
    return apiSuccess(await revokeAsAdmin(context.env.DB, context.get('user').id, id, version, context.get('adminKeyNow')), context.get('requestId'));
  });
  return app;
}
