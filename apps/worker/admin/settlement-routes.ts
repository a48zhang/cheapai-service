import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { UsageSnapshot } from '@sub2api/apicompat/types/shared';
import { requireSession } from '../auth/middleware';
import type { AuthEnv } from '../auth/middleware';
import { requireAdmin } from '../auth/roles';
import { validateCsrfRequest } from '../auth/csrf';
import { ApiError, apiError, apiSuccess, createRequestId } from '../http';
import { batch, prepare } from '../db';
import { getRequest } from '../gateway/request-repository';
import { readPriceSnapshot } from '../billing/fingerprint';
import { calculatePrice } from '../billing/pricing';
import { prepareConsumptionSettlement, settleConsumption } from '../billing/settlement-repository';
import { buildAuditStatement } from './audit';

export const RETRY_SETTLEMENT_PATH = '/api/v1/admin/requests/:id/retry-settlement';
interface RouteEnv extends AuthEnv { Variables: AuthEnv['Variables'] & { retryNow?: number } }
export interface SettlementRouteDependencies {
  now(): number;
  trustedOrigin?: string | ((env: AuthEnv['Bindings'], request: Request) => string | Promise<string>);
}
interface Evidence { user_id: string; billing_status: string; usage_quality: string; usage_json: string | null; cost_units: number | null; fingerprint: string | null }
function noStore(response: Response): Response { response.headers.set('Cache-Control', 'no-store'); return response; }
async function emptyBody(request: Request): Promise<void> {
  if (!request.body) return;
  if (request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') throw new ApiError('invalid_request');
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      if (part.value.byteLength > 512 - size) { void reader.cancel().catch(() => undefined); throw new ApiError('payload_too_large'); }
      chunks.push(part.value); size += part.value.byteLength;
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) throw new ApiError('invalid_request');
  } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError('invalid_request'); }
  finally { reader.releaseLock(); }
}

/** One local write attempt, stable consume:<id> identity. A failed response may
 * have committed; B04 reconciles and subsequent calls consult the immutable ledger.
 * The audit records retry REQUESTED, not a success claim. No upstream is called.
 */
export function createSettlementRoutes(dependencies: SettlementRouteDependencies = { now: Date.now }): Hono<RouteEnv> {
  const app = new Hono<RouteEnv>();
  app.onError((error, context) => noStore(apiError(error instanceof ApiError ? error : new ApiError('service_unavailable'), context.get('requestId') ?? createRequestId())));
  app.post(RETRY_SETTLEMENT_PATH, async (context, next) => {
    context.set('requestId', context.get('requestId') ?? createRequestId());
    const now = dependencies.now(); if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) throw new ApiError('service_unavailable');
    context.set('retryNow', now); await next(); context.res.headers.set('Cache-Control', 'no-store');
  }, (context, next) => requireSession(() => context.get('retryNow')!)(context, next), requireAdmin, async context => {
    const configured = dependencies.trustedOrigin;
    const origin = typeof configured === 'function' ? await configured(context.env, context.req.raw) : configured;
    if (typeof origin !== 'string') throw new ApiError('service_unavailable');
    validateCsrfRequest(context.req.raw, origin);
    const id = context.req.param('id');
    if (id.trim() !== id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || new URL(context.req.url).search !== '') throw new ApiError('invalid_request');
    await emptyBody(context.req.raw);
    const db = context.env.DB; const actor = context.get('user').id; const now = context.get('retryNow')!;
    const evidence = await prepare<Evidence>(db, 'SELECT user_id,billing_status,usage_quality,usage_json,cost_units,fingerprint FROM requests WHERE id=?', [id]).first();
    if (!evidence) throw new ApiError('not_found');
    const existing = await prepare<{ id: string; operation_id: string; user_id: string; cost_units: string }>(db,
      "SELECT id,operation_id,user_id,CAST(-delta_units AS TEXT) AS cost_units FROM billing_entries WHERE request_id=? AND kind='consumption'", [id]).first();
    if (existing) {
      if (existing.operation_id !== `consume:${id}` || existing.user_id !== evidence.user_id) throw new ApiError('conflict');
      return noStore(apiSuccess({ status: 'already_settled', requestId: id, entryId: existing.id, costUnits: existing.cost_units }, context.get('requestId')));
    }
    const request = await getRequest(db, id, evidence.user_id);
    if (!request) throw new ApiError('not_found');
    let usage: UsageSnapshot;
    let expected: Awaited<ReturnType<typeof prepareConsumptionSettlement>>;
    try {
      if (evidence.billing_status !== 'settlement_pending' || evidence.usage_quality !== 'complete' || evidence.usage_json === null
        || evidence.usage_json.length > 1_048_576 || evidence.cost_units === null || !Number.isSafeInteger(evidence.cost_units) || evidence.cost_units < 0 || evidence.fingerprint === null) throw new Error();
      usage = JSON.parse(evidence.usage_json) as UsageSnapshot;
      const price = readPriceSnapshot(request.price_snapshot);
      expected = await prepareConsumptionSettlement({ operationId: `consume:${id}`, requestId: id, userId: evidence.user_id,
      priceSnapshotJson: request.price_snapshot, usage, costUnits: calculatePrice(usage, price.snapshot.sell_prices, price.snapshot.billing_multiplier ?? '1').costUnits });
      if (expected.costUnits !== String(evidence.cost_units) || expected.fingerprint !== evidence.fingerprint || expected.usageSnapshotJson !== evidence.usage_json
        || expected.publicModelId !== request.public_model_id || expected.upstreamModel !== request.upstream_model || expected.upstreamProtocol !== request.upstream_protocol) throw new Error();
    } catch { throw new ApiError('conflict'); }
    try {
      await batch(db, [
        prepare(db, `SELECT CASE WHEN EXISTS(SELECT 1 FROM users u JOIN groups g ON g.id=u.group_id
          WHERE u.id=? AND u.role='admin' AND u.status='active' AND g.status='active') THEN 1 ELSE json_extract('{}','retry_actor_forbidden') END`, [actor]),
        prepare(db, `SELECT CASE WHEN EXISTS(SELECT 1 FROM requests WHERE id=? AND user_id=? AND billing_status IN ('settlement_pending','settled')
          AND usage_quality='complete' AND usage_json=? AND price_snapshot=? AND fingerprint=? AND cost_units=?)
          THEN 1 ELSE json_extract('{}','retry_evidence_conflict') END`,
          [id, evidence.user_id, expected.usageSnapshotJson, expected.priceSnapshotJson, expected.fingerprint, evidence.cost_units]),
        buildAuditStatement(db, { actor_id: actor, operation_id: context.get('requestId'), action: 'settlement.retry_requested',
          target_type: 'request', target_id: id, created_at: now, changes: { quantity: 1 } }),
      ]);
    } catch (error) {
      for (let cause = error, depth = 0; cause instanceof Error && depth < 4; cause = cause.cause, depth++) {
        if (cause.message.includes('retry_actor_forbidden')) throw new ApiError('forbidden');
        if (cause.message.includes('retry_evidence_conflict')) throw new ApiError('conflict');
      }
      throw error;
    }
    // Intent audit is committed. B04/D13 exclusively own atomic debit and request
    // settlement; no original entry, price, usage, cost or retry counters are edited here.
    const settled = await settleConsumption(db, { operationId: expected.operationId, requestId: id, userId: evidence.user_id,
      priceSnapshotJson: request.price_snapshot, usage, costUnits: expected.costUnits }, now);
    return noStore(apiSuccess({ status: 'settled', requestId: id, entryId: settled.entry.id, costUnits: settled.entry.costUnits }, context.get('requestId')));
  });
  app.notFound(context => noStore(apiError(new ApiError('not_found'), context.get('requestId') ?? createRequestId())));
  return app;
}
