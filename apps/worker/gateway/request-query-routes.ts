import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { requireSession } from '../auth/middleware';
import type { AuthEnv } from '../auth/middleware';
import { requireAdmin } from '../auth/roles';
import { ApiError, apiError, apiSuccess, createRequestId, parsePagination } from '../http';
import { prepare } from '../db';
import type { DbValue } from '../db';
import { readPriceSnapshot } from '../billing/fingerprint';
import type { RequestRecord } from './request-repository';

export const PERSONAL_REQUESTS_PATH = '/api/v1/usage/requests';
export const ADMIN_REQUESTS_PATH = '/api/v1/admin/requests';
interface RouteEnv extends AuthEnv { Variables: AuthEnv['Variables'] & { queryNow?: number } }
interface QueryRow extends RequestRecord {
  source: 'api' | 'web_chat'; group_id: string | null;
  usage_json: string | null; usage_quality: string; cost_units: string | null; error_code: string | null;
  retry_count: number; next_retry_at: number | null; updated_at: number;
}
const projection = `id,user_id,api_key_id,source,group_id,channel_id,public_model_id,upstream_model,downstream_protocol,upstream_protocol,
  price_snapshot,execution_status,billing_status,created_at,started_at,finished_at,updated_at,
  usage_json,usage_quality,CAST(cost_units AS TEXT) AS cost_units,error_code,retry_count,next_retry_at`;
const statuses = ['admitted', 'succeeded', 'failed', 'cancelled', 'abandoned'];
const billings = ['awaiting_usage', 'settled', 'not_chargeable', 'settlement_pending', 'usage_unknown'];
const errors: Record<string, string> = { upstream_error: 'Upstream request failed.', client_cancelled: 'Client cancelled the request.',
  request_timeout: 'Request timed out.', internal_error: 'Request processing failed.' };
const countFields = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cacheWrite5mTokens', 'cacheWrite1hTokens', 'reasoningTokens'];
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validId(value: unknown): value is string { return typeof value === 'string' && value.length <= 128 && value.trim() === value && /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value); }
function timestamp(raw: string | null): number | null {
  if (raw === null) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw)) || String(Number(raw)) !== raw) throw new ApiError('invalid_request');
  return Number(raw);
}
function usage(raw: string | null): { value: unknown; valid: boolean | null } {
  if (raw === null) return { value: null, valid: null };
  try {
    if (raw.length > 65536) throw new Error();
    const input: unknown = JSON.parse(raw);
    if (!record(input) || !['chat', 'responses', 'messages'].includes(input.protocol as string)
      || !['complete', 'partial', 'missing', 'invalid'].includes(input.quality as string)) throw new Error();
    if (input.quality === 'missing') return { value: { protocol: input.protocol, quality: 'missing' }, valid: true };
    if (!record(input.counts)) throw new Error();
    const counts: Record<string, number> = {};
    for (const key of countFields) if (Object.hasOwn(input.counts, key)) {
      const value = input.counts[key];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error();
      counts[key] = value;
    }
    if (input.quality === 'complete' && (counts.inputTokens === undefined || counts.outputTokens === undefined)) throw new Error();
    const semantics: Record<string, string> = {};
    const allowed: Record<string, string[]> = { cacheRead: ['included_in_input', 'excluded_from_input', 'unknown'],
      cacheWrite: ['included_in_input', 'excluded_from_input', 'unknown'], reasoning: ['included_in_output', 'excluded_from_output', 'unknown'], cacheWriteTtl: ['subsets_of_cache_write', 'unknown'] };
    if (record(input.semantics)) for (const [key, values] of Object.entries(allowed)) {
      const value = input.semantics[key]; if (typeof value === 'string' && values.includes(value)) semantics[key] = value;
    }
    // No raw source objects, free-form issues, prompt, headers or provider text.
    return { value: { protocol: input.protocol, quality: input.quality, counts, semantics }, valid: true };
  } catch { return { value: null, valid: false }; }
}
function publicRecord(row: QueryRow) {
  const { price_snapshot, usage_json, error_code, ...safe } = row;
  let price: ReturnType<typeof readPriceSnapshot>['snapshot'] | null = null;
  try { if (price_snapshot.length <= 65536) price = readPriceSnapshot(price_snapshot).snapshot; } catch { /* Unsupported/corrupt evidence stays unknown. */ }
  const evidence = usage(usage_json);
  const error = error_code === null ? null : Object.hasOwn(errors, error_code)
    ? { code: error_code, message: errors[error_code] } : { code: 'unclassified_error', message: 'Request processing failed.' };
  return { ...safe, price_snapshot: price, price_snapshot_valid: price !== null, usage: evidence.value, usage_valid: evidence.valid, error };
}
function encode(value: unknown): string { return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
function noStore(response: Response): Response { response.headers.set('Cache-Control', 'no-store'); return response; }

/** from/to are inclusive UTC milliseconds. Admin mode is chosen by route and
 * requireAdmin, never query input. Pagination fixes the creation ceiling only.
 */
export function createRequestQueryRoutes(dependencies: { now(): number } = { now: Date.now }): Hono<RouteEnv> {
  const app = new Hono<RouteEnv>();
  app.onError((error, context) => noStore(apiError(error instanceof ApiError ? error : new ApiError('service_unavailable', { cause: error }), context.get('requestId') ?? createRequestId())));
  const initialize: MiddlewareHandler<RouteEnv> = async (context, next) => {
    context.set('requestId', context.get('requestId') ?? createRequestId());
    const now = dependencies.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) throw new ApiError('service_unavailable');
    context.set('queryNow', now); await next(); context.res.headers.set('Cache-Control', 'no-store');
  };
  for (const [path, admin] of [[PERSONAL_REQUESTS_PATH, false], [ADMIN_REQUESTS_PATH, true]] as const) {
    const authorize: MiddlewareHandler<RouteEnv> = async (context, next) => {
      const guard: MiddlewareHandler = admin ? requireAdmin : async (_context, proceed) => { await proceed(); };
      return guard(context, next);
    };
    app.get(path, initialize, (context, next) => requireSession(() => context.get('queryNow')!)(context, next), authorize, async context => {
      const query = new URL(context.req.url).searchParams;
      for (const key of query.keys()) if (!['limit', 'cursor', 'from', 'to', 'status', 'billingStatus', 'model', ...(admin ? ['userId'] : [])].includes(key) || query.getAll(key).length !== 1) throw new ApiError('invalid_request');
      const page = parsePagination(query);
      const filter = { userId: admin ? query.get('userId') : context.get('user').id, from: timestamp(query.get('from')), to: timestamp(query.get('to')),
        status: query.get('status'), billingStatus: query.get('billingStatus'), model: query.get('model') };
      if ((filter.userId !== null && !validId(filter.userId)) || (filter.model !== null && !validId(filter.model))
        || (filter.status !== null && !statuses.includes(filter.status)) || (filter.billingStatus !== null && !billings.includes(filter.billingStatus))
        || (filter.from !== null && filter.to !== null && filter.from > filter.to)) throw new ApiError('invalid_request');
      const actor = context.get('user').id;
      let ceiling = context.get('queryNow')!; let position: [number, string] | undefined;
      if (page.cursor !== null) {
        try {
          const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(atob(page.cursor.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0))));
          if (!Array.isArray(value) || value.length !== 7 || value[0] !== 1 || value[1] !== admin || value[2] !== actor
            || JSON.stringify(value[3]) !== JSON.stringify(filter) || !Number.isSafeInteger(value[4]) || value[4] < 0 || value[4] > ceiling
            || !Number.isSafeInteger(value[5]) || value[5] < 0 || value[5] > value[4] || !validId(value[6]) || encode(value) !== page.cursor) throw new Error();
          ceiling = value[4] as number; position = [value[5] as number, value[6]];
        } catch { throw new ApiError('invalid_request'); }
      }
      const conditions = ['created_at<=?']; const values: DbValue[] = [ceiling];
      for (const [column, value] of [['user_id', filter.userId], ['execution_status', filter.status], ['billing_status', filter.billingStatus], ['public_model_id', filter.model]] as const) {
        if (value !== null) { conditions.push(`${column}=?`); values.push(value); }
      }
      if (filter.from !== null) { conditions.push('created_at>=?'); values.push(filter.from); }
      if (filter.to !== null) { conditions.push('created_at<=?'); values.push(filter.to); }
      if (position) { conditions.push('(created_at<? OR (created_at=? AND id<?))'); values.push(position[0], position[0], position[1]); }
      values.push(page.limit + 1);
      const result = await prepare<QueryRow>(context.env.DB, `SELECT ${projection} FROM requests WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ?`, values).all();
      const selected = result.rows.slice(0, page.limit); const last = selected.at(-1);
      return noStore(apiSuccess({ items: selected.map(publicRecord), snapshotAt: ceiling, nextCursor: result.rows.length > page.limit && last
        ? encode([1, admin, actor, filter, ceiling, last.created_at, last.id]) : null }, context.get('requestId')));
    });
    app.get(`${path}/:id`, initialize, (context, next) => requireSession(() => context.get('queryNow')!)(context, next), authorize, async context => {
      const id = context.req.param('id');
      if (!validId(id) || new URL(context.req.url).search !== '') throw new ApiError('invalid_request');
      const row = await prepare<QueryRow>(context.env.DB, `SELECT ${projection} FROM requests WHERE id=?${admin ? '' : ' AND user_id=?'}`,
        admin ? [id] : [id, context.get('user').id]).first();
      if (!row) throw new ApiError('not_found');
      return noStore(apiSuccess(publicRecord(row), context.get('requestId')));
    });
  }
  app.notFound(context => noStore(apiError(new ApiError('not_found'), context.get('requestId') ?? createRequestId())));
  return app;
}
