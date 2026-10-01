import type { UsageSnapshot } from '@sub2api/apicompat/types/shared';
import { getRequest } from '../gateway/request-repository';
import { prepare } from '../db';
import { ApiError } from '../http';
import { canonicalJson, readPriceSnapshot } from './fingerprint';
import { calculatePrice } from './pricing';
import { prepareConsumptionSettlement } from './settlement-repository';
import { parseUnits, unitsToSafeNumber } from './money';

export interface RecoveryInput { readonly requestId: string; readonly userId: string; readonly usage: UsageSnapshot }
export interface RecoveryResult { readonly saved: boolean; readonly billingStatus: string; readonly fingerprint: string | null }

/**
 * B14 consumes B13's retained usage, not a caller-selected price or cost. Read
 * the original registered snapshot and recompute B02/B03 facts. Conditional
 * writes cannot downgrade a ledger/settled row or overwrite known pending facts.
 * This is best effort when D1 returns: failure does not imply a previous debit failed.
 */
export async function saveSettlementRecovery(database: D1Database, input: RecoveryInput, now: number): Promise<RecoveryResult> {
  if (!Number.isSafeInteger(now) || now < 0 || !input || typeof input !== 'object'
    || Object.keys(input).some(key => !['requestId', 'userId', 'usage'].includes(key))) throw new ApiError('invalid_request');
  try {
    const request = await getRequest(database, input.requestId, input.userId);
    if (!request) throw new ApiError('not_found');
    const read = async () => {
      const state = await prepare<{ billing_status: string; fingerprint: string | null; has_ledger: number }>(database,
        `SELECT billing_status,fingerprint,EXISTS(SELECT 1 FROM billing_entries b WHERE b.request_id=requests.id AND b.kind='consumption') AS has_ledger
         FROM requests WHERE id=? AND user_id=?`, [input.requestId, input.userId]).first();
      if (!state) throw new ApiError('not_found');
      return state;
    };
    const before = await read();
    if (before.has_ledger || before.billing_status === 'settled') return { saved: false, billingStatus: 'settled', fingerprint: before.fingerprint };
    let usage: UsageSnapshot;
    try {
      usage = JSON.parse(canonicalJson(input.usage)) as UsageSnapshot;
      if (!usage || typeof usage !== 'object' || !['complete', 'partial', 'missing', 'invalid'].includes(usage.quality)
        || usage.protocol !== request.upstream_protocol) throw new Error();
    } catch { throw new ApiError('invalid_request'); }
    let known: Awaited<ReturnType<typeof prepareConsumptionSettlement>> | undefined;
    if (usage.quality === 'complete') {
      try {
        const price = readPriceSnapshot(request.price_snapshot);
        if (price.snapshot.public_model_id !== request.public_model_id || price.snapshot.upstream_model !== request.upstream_model
          || price.snapshot.upstream_protocol !== request.upstream_protocol) throw new Error();
        const cost = calculatePrice(usage, price.snapshot.sell_prices, price.snapshot.billing_multiplier ?? '1').costUnits;
        known = await prepareConsumptionSettlement({ operationId: `consume:${request.id}`, requestId: request.id, userId: request.user_id,
          priceSnapshotJson: request.price_snapshot, usage, costUnits: cost });
      } catch {
        usage = { ...usage, quality: 'invalid', issues: ['unpriceable_usage'] };
      }
    }
    const unchangedPrice = request.price_snapshot;
    const result = known
      ? await prepare(database, `UPDATE requests SET usage_json=?,usage_quality='complete',cost_units=?,fingerprint=?,
          next_retry_at=CASE WHEN billing_status='settlement_pending' THEN next_retry_at ELSE ? END,
          retry_count=CASE WHEN billing_status='settlement_pending' THEN retry_count ELSE 0 END,
          billing_status='settlement_pending',updated_at=max(updated_at,?)
          WHERE id=? AND user_id=? AND price_snapshot=? AND billing_status IN ('awaiting_usage','usage_unknown','settlement_pending')
            AND (fingerprint IS NULL OR fingerprint=?)
            AND NOT EXISTS(SELECT 1 FROM billing_entries b WHERE b.request_id=requests.id AND b.kind='consumption')`,
        [known.usageSnapshotJson, unitsToSafeNumber(parseUnits(known.costUnits)), known.fingerprint, now, now,
          request.id, request.user_id, unchangedPrice, known.fingerprint]).run()
      : await prepare(database, `UPDATE requests SET usage_json=?,usage_quality=?,billing_status='usage_unknown',next_retry_at=NULL,
          updated_at=max(updated_at,?) WHERE id=? AND user_id=? AND price_snapshot=?
          AND billing_status IN ('awaiting_usage','usage_unknown') AND fingerprint IS NULL AND cost_units IS NULL
          AND NOT EXISTS(SELECT 1 FROM billing_entries b WHERE b.request_id=requests.id AND b.kind='consumption')`,
        [canonicalJson(usage), usage.quality, now, request.id, request.user_id, unchangedPrice]).run();
    const after = await read();
    if (after.has_ledger || after.billing_status === 'settled') return { saved: false, billingStatus: 'settled', fingerprint: after.fingerprint };
    if (known && result.changes === 0 && after.fingerprint !== null && after.fingerprint !== known.fingerprint) throw new ApiError('conflict');
    return { saved: result.changes === 1, billingStatus: after.billing_status, fingerprint: after.fingerprint };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('service_unavailable');
  }
}
