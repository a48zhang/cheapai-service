import { Hono } from 'hono';
import { requireSession } from '../auth/middleware';
import type { AuthEnv } from '../auth/middleware';
import { requireAdmin } from '../auth/roles';
import { validateCsrfRequest } from '../auth/csrf';
import { adjustBalance } from '../billing/adjustments';
import type { BalanceAdjustmentInput } from '../billing/adjustments';
import { ApiError, apiError, apiSuccess, createRequestId } from '../http';

export const ADMIN_BALANCE_PATH = '/api/v1/admin/users/:id/balance-adjustments';
export const BALANCE_BODY_MAX_BYTES = 8192;
export interface BalanceRouteDependencies {
  database: D1Database;
  now(): number;
  trustedOrigin?: string | (() => string | Promise<string>);
}
interface RouteEnv extends AuthEnv { Variables: AuthEnv['Variables'] & { balanceTime?: number } }
const noStore = (response: Response): Response => { response.headers.set('Cache-Control', 'no-store'); return response; };

async function body(request: Request): Promise<Omit<BalanceAdjustmentInput, 'operationId' | 'userId'>> {
  if (request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json' || !request.body) throw new ApiError('invalid_request');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let value: unknown;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (part.value.byteLength > BALANCE_BODY_MAX_BYTES - size) {
        void reader.cancel().catch(() => undefined);
        throw new ApiError('payload_too_large');
      }
      size += part.value.byteLength; chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('invalid_request');
  } finally { reader.releaseLock(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('invalid_request');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['kind', 'deltaUnits', 'reason', 'requestId'].includes(key))
    || (input.kind !== 'grant' && input.kind !== 'adjustment') || typeof input.deltaUnits !== 'string'
    || typeof input.reason !== 'string' || (Object.hasOwn(input, 'requestId') && input.requestId !== null && typeof input.requestId !== 'string')) throw new ApiError('invalid_request');
  return input as unknown as Omit<BalanceAdjustmentInput, 'operationId' | 'userId'>;
}

/** Unmounted full-path router. Origin is resolved lazily, after session/admin auth. */
export function createAdminBalanceRoutes(dependencies?: BalanceRouteDependencies): Hono<RouteEnv> {
  const app = new Hono<RouteEnv>();
  app.onError((error, context) => noStore(apiError(error instanceof ApiError ? error : new ApiError('service_unavailable'), context.get('requestId') ?? createRequestId())));
  app.notFound(context => noStore(apiError(new ApiError('not_found'), context.get('requestId') ?? createRequestId())));
  app.post(ADMIN_BALANCE_PATH,
    async (context, next) => {
      context.set('requestId', createRequestId());
      const now = dependencies ? dependencies.now() : Date.now();
      if (!Number.isSafeInteger(now) || now < 0) throw new ApiError('service_unavailable');
      context.set('balanceTime', now);
      if (dependencies) context.env = { ...context.env, DB: dependencies.database };
      await next();
      context.res.headers.set('Cache-Control', 'no-store');
    },
    (context, next) => requireSession(() => context.get('balanceTime')!)(context, next),
    requireAdmin,
    async context => {
      const configured = dependencies?.trustedOrigin;
      const origin = typeof configured === 'function' ? await configured() : configured;
      if (typeof origin !== 'string') throw new ApiError('service_unavailable');
      validateCsrfRequest(context.req.raw, origin);
      const key = context.req.header('Idempotency-Key');
      if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(key) || key.length > 128) throw new ApiError('invalid_request');
      const input = await body(context.req.raw);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
      const operationId = `balance:${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
      const result = await adjustBalance(context.env.DB, { ...input, operationId, userId: context.req.param('id') }, context.get('user').id, context.get('balanceTime')!);
      return noStore(apiSuccess(result, context.get('requestId'), result.outcome === 'inserted' ? 201 : 200));
    });
  return app;
}
