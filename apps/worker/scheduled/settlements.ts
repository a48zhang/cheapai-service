import { logError } from '../logging';
import type { UsageSnapshot } from '@sub2api/apicompat/types/shared';
import { prepare } from '../db';
import { ApiError } from '../http';
import { getRequest } from '../gateway/request-repository';
import { readPriceSnapshot } from '../billing/fingerprint';
import { calculatePrice } from '../billing/pricing';
import { prepareConsumptionSettlement } from '../billing/settlement-repository';
import { settleRequest } from '../billing/settlement';

export const MAX_SCHEDULED_SETTLEMENT_ROUNDS = 5;
export const SETTLEMENT_BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000] as const;
export interface ScheduledSettlementOptions { readonly limit?: number; readonly budgetMs?: number }
export interface ScheduledSettlementResult {
  selected: number; claimed: number; settled: number; pending: number; skipped: number; invalid: number;
  /** Caller may attach unresolved D1 operations to its execution context. */
  inFlight: Promise<void>[];
}
interface Candidate {
  id: string; user_id: string; retry_count: number; next_retry_at: number;
  usage_quality: string; usage_json: string | null; cost_units: number | null; fingerprint: string | null;
}

/**
 * One bounded indexed batch, no upstream generation. Claim a round using CAS
 * before calling B13; a crashed claim consumes a round and leaves its backoff.
 * Five rounds maximum, then next_retry_at=NULL retains manual-review evidence.
 */
export async function retryPendingSettlements(database: D1Database, now: number, options: ScheduledSettlementOptions = {}): Promise<ScheduledSettlementResult> {
  const limit = options.limit ?? 20;
  const budget = options.budgetMs ?? 25_000;
  if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - 3_600_000
    || !Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(budget) || budget < 1 || budget > 30_000) throw new ApiError('invalid_request');
  const started = performance.now();
  const summary: ScheduledSettlementResult = { selected: 0, claimed: 0, settled: 0, pending: 0, skipped: 0, invalid: 0, inFlight: [] };
  let candidates: Candidate[];
  try {
    candidates = (await prepare<Candidate>(database, `SELECT id,user_id,retry_count,next_retry_at,usage_quality,usage_json,cost_units,fingerprint
      FROM requests WHERE billing_status='settlement_pending' AND next_retry_at IS NOT NULL AND next_retry_at<=? AND retry_count<?
      ORDER BY next_retry_at,id LIMIT ?`, [now, MAX_SCHEDULED_SETTLEMENT_ROUNDS, limit]).all()).rows;
  } catch (error) { throw new ApiError('service_unavailable', { cause: error }); }
  summary.selected = candidates.length;
  for (const candidate of candidates) {
    if (performance.now() - started >= budget) break;
    const round = candidate.retry_count + 1;
    const next = round < MAX_SCHEDULED_SETTLEMENT_ROUNDS ? now + SETTLEMENT_BACKOFF_MS[round - 1]! : null;
    try {
      const claim = await prepare(database, `UPDATE requests SET retry_count=retry_count+1,next_retry_at=?,updated_at=max(updated_at,?)
        WHERE id=? AND user_id=? AND billing_status='settlement_pending' AND retry_count=? AND next_retry_at=? AND next_retry_at<=?
          AND NOT EXISTS(SELECT 1 FROM billing_entries b WHERE b.request_id=requests.id AND b.kind='consumption')`,
        [next, now, candidate.id, candidate.user_id, candidate.retry_count, candidate.next_retry_at, now]).run();
      if (claim.changes !== 1) { summary.skipped++; continue; }
      summary.claimed++;
      const request = await getRequest(database, candidate.id, candidate.user_id);
      if (!request) { summary.skipped++; continue; }
      let usage: UsageSnapshot;
      try {
        if (candidate.usage_quality !== 'complete' || candidate.usage_json === null || candidate.fingerprint === null
          || !Number.isSafeInteger(candidate.cost_units) || candidate.cost_units === null || candidate.cost_units < 0) throw new Error();
        usage = JSON.parse(candidate.usage_json) as UsageSnapshot;
        const price = readPriceSnapshot(request.price_snapshot);
        const cost = calculatePrice(usage, price.snapshot.sell_prices, price.snapshot.billing_multiplier ?? '1').costUnits;
        const checked = await prepareConsumptionSettlement({ operationId: `consume:${candidate.id}`, requestId: candidate.id, userId: candidate.user_id,
          priceSnapshotJson: request.price_snapshot, usage, costUnits: cost });
        if (checked.costUnits !== String(candidate.cost_units) || checked.fingerprint !== candidate.fingerprint
          || checked.usageSnapshotJson !== candidate.usage_json) throw new Error();
      } catch (error) {
        logError('Scheduled settlement evidence read failed', error, { request_id: candidate.id });
        await prepare(database, `UPDATE requests SET next_retry_at=NULL,error_code='settlement_evidence_invalid',
          error_message='Saved settlement evidence requires manual review.'
          WHERE id=? AND user_id=? AND billing_status='settlement_pending' AND retry_count=?
            AND NOT EXISTS(SELECT 1 FROM billing_entries b WHERE b.request_id=requests.id AND b.kind='consumption')`,
          [candidate.id, candidate.user_id, round]).run();
        summary.invalid++; continue;
      }
      const remaining = Math.floor(budget - (performance.now() - started));
      if (remaining < 1) { summary.pending++; break; }
      const result = await settleRequest(database, request, usage, { maxAttempts: 1, budgetMs: Math.min(6000, remaining), retryDelayMs: 0, now: () => now });
      if (result.status === 'settled') {
        summary.settled++;
        await prepare(database, "UPDATE requests SET next_retry_at=NULL WHERE id=? AND user_id=? AND billing_status='settled' AND fingerprint=?",
          [candidate.id, candidate.user_id, candidate.fingerprint]).run();
      } else {
        summary.pending++;
        if (result.inFlight) summary.inFlight.push(result.inFlight);
      }
    } catch (error) {
      logError('Scheduled settlement retry failed', error, { request_id: candidate.id, round });
      // Keep the already persisted round/backoff; never restore an old state over
      // a late settlement. SQL/transport errors can still represent a committed debit.
      summary.pending++;
      if (error instanceof ApiError && error.code === 'conflict') {
        await prepare(database, `UPDATE requests SET next_retry_at=NULL WHERE id=? AND user_id=? AND billing_status='settlement_pending'
          AND retry_count=? AND NOT EXISTS(SELECT 1 FROM billing_entries b WHERE b.request_id=requests.id AND b.kind='consumption')`,
          [candidate.id, candidate.user_id, round]).run();
      }
    }
  }
  return summary;
}
