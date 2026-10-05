import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { requireSession } from '../auth/middleware';
import type { AuthVariables } from '../auth/middleware';
import { requireAdmin } from '../auth/roles';
import { validateCsrfRequest } from '../auth/csrf';
import { DEFAULT_CONFIG } from '../config';
import { ApiError, apiError, apiSuccess, createRequestId, parsePagination } from '../http';
import { prepare } from '../db';
import { createModel, getModelById, updateModel } from './model-repository';
import type { CreateModelInput, ModelPatch } from './model-repository';

export const ADMIN_MODELS_PATH = '/api/v1/admin/models';
export const MODEL_BODY_MAX_BYTES = DEFAULT_CONFIG.adminBodyMaxBytes;
type Bindings = { DB: D1Database };
type RouteEnv<B extends Bindings> = { Bindings: B; Variables: AuthVariables & { modelNow: number } };
export interface ModelRouteDependencies<B extends Bindings = Bindings> {
  now(): number;
  /** Read-only access never resolves Origin; no encryption-key dependency. */
  trustedOrigin?: string | ((env: B, request: Request) => string | Promise<string>);
}
function cursorEncode(value: unknown): string { return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function cursorDecode(token: string, status: string | null): [number, string] {
  try {
    const parsed: unknown = JSON.parse(atob(token.replace(/-/g, '+').replace(/_/g, '/')));
    if (!Array.isArray(parsed) || parsed.length !== 4 || parsed[0] !== 1 || parsed[3] !== status
        || !Number.isSafeInteger(parsed[1]) || parsed[1] < 0 || typeof parsed[2] !== 'string' || parsed[2].length > 128
        || parsed[2].trim() !== parsed[2] || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(parsed[2]) || cursorEncode(parsed) !== token) throw new Error();
    return [parsed[1] as number, parsed[2]];
  } catch { throw new ApiError('invalid_request'); }
}
async function protectWrite<B extends Bindings>(dependencies: ModelRouteDependencies<B>, env: B, request: Request): Promise<void> {
  const configured = dependencies.trustedOrigin;
  const origin = typeof configured === 'function' ? await configured(env, request) : configured;
  if (typeof origin !== 'string') throw new ApiError('service_unavailable');
  validateCsrfRequest(request, origin);
}
async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json' || !request.body) throw new ApiError('invalid_request');
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      if (part.value.byteLength > MODEL_BODY_MAX_BYTES - size) { void reader.cancel().catch(() => undefined); throw new ApiError('payload_too_large'); }
      chunks.push(part.value); size += part.value.byteLength;
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ApiError('invalid_request');
    return parsed as Record<string, unknown>;
  } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError('invalid_request'); }
  finally { reader.releaseLock(); }
}

export function createModelRoutes<B extends Bindings = Bindings>(dependencies: ModelRouteDependencies<B>): Hono<RouteEnv<B>> {
  const app = new Hono<RouteEnv<B>>();
  app.onError((error, context) => {
    const response = apiError(error instanceof ApiError ? error : new ApiError('service_unavailable', { cause: error }), context.get('requestId') ?? createRequestId());
    response.headers.set('Cache-Control', 'no-store'); return response;
  });
  app.use('*', async (context, next) => {
    context.set('requestId', context.get('requestId') ?? createRequestId());
    const now = dependencies.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new ApiError('service_unavailable');
    context.set('modelNow', now);
    await next(); context.res.headers.set('Cache-Control', 'no-store');
  });
  app.use('*', (context, next) => {
    const authenticate: MiddlewareHandler = requireSession(() => context.get('modelNow'));
    return authenticate(context, next);
  });
  app.use('*', requireAdmin);
  app.get(ADMIN_MODELS_PATH, async (context) => {
    const query = new URL(context.req.url).searchParams;
    if (query.getAll('status').length > 1) throw new ApiError('invalid_request');
    const status = query.get('status');
    if (status !== null && status !== 'active' && status !== 'disabled') throw new ApiError('invalid_request');
    const page = parsePagination(query);
    const [time, id] = page.cursor === null ? [null, null] : cursorDecode(page.cursor, status);
    // C08 has no list function. Read bounded IDs, then reuse its validated public
    // projection rather than duplicate price parsing or expose raw configuration.
    const result = await prepare<{ public_model_id: string; created_at: number }>(context.env.DB,
      `SELECT public_model_id,created_at FROM models WHERE (? IS NULL OR status=?)
       AND (? IS NULL OR created_at<? OR (created_at=? AND public_model_id<?)) ORDER BY created_at DESC,public_model_id DESC LIMIT ?`,
      [status, status, time, time, time, id, page.limit + 1]).all();
    const selected = result.rows.slice(0, page.limit);
    const items = await Promise.all(selected.map((row) => getModelById(context.env.DB, row.public_model_id)));
    if (items.some((item) => item === null)) throw new ApiError('service_unavailable');
    const last = selected.at(-1);
    return apiSuccess({ items, nextCursor: result.rows.length > page.limit && last ? cursorEncode([1, last.created_at, last.public_model_id, status]) : null }, context.get('requestId'));
  });
  app.get(`${ADMIN_MODELS_PATH}/:id`, async (context) => {
    const id = context.req.param('id');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(id) || id.split('/').some(part => !part || part === '.' || part === '..')) throw new ApiError('invalid_request');
    const model = await getModelById(context.env.DB, id);
    if (!model) throw new ApiError('not_found');
    return apiSuccess(model, context.get('requestId'));
  });
  app.post(ADMIN_MODELS_PATH, async (context) => {
    await protectWrite(dependencies, context.env, context.req.raw);
    const body = await readBody(context.req.raw);
    const result = await createModel(context.env.DB, body as unknown as CreateModelInput, {
      actorId: context.get('user').id, operationId: crypto.randomUUID(), now: context.get('modelNow'),
    });
    return apiSuccess(result, context.get('requestId'), 201);
  });
  app.patch(`${ADMIN_MODELS_PATH}/:id`, async (context) => {
    await protectWrite(dependencies, context.env, context.req.raw);
    const id = context.req.param('id');
    if (id.trim() !== id || id.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(id)) throw new ApiError('invalid_request');
    const body = await readBody(context.req.raw);
    if (typeof body.version !== 'number' || !Number.isSafeInteger(body.version) || body.version < 1) throw new ApiError('invalid_request');
    const { version, ...patch } = body;
    const result = await updateModel(context.env.DB, id, version, patch as ModelPatch, {
      actorId: context.get('user').id, operationId: crypto.randomUUID(), now: context.get('modelNow'),
    });
    return apiSuccess(result, context.get('requestId'));
  });
  app.notFound((context) => apiError(new ApiError('not_found'), context.get('requestId') ?? createRequestId()));
  return app;
}
