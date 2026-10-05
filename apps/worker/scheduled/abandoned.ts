import { DEFAULT_CONFIG } from '../config';
import { prepare } from '../db';
import { ApiError } from '../http';

export interface AbandonedScanOptions {
  readonly limit?: number;
  readonly requestMaxDurationMs?: number;
  readonly graceMs?: number;
}
export interface AbandonedScanResult { readonly selected: number; readonly abandoned: number; readonly skipped: number }
interface Candidate { id: string; user_id: string; created_at: number; started_at: number | null }

/**
 * One bounded scan of awaiting usage, using the billing-status index prefix.
 * Started calls age from started_at; unstarted registrations age from created_at.
 * Only admitted/nonterminal calls are marked. Never manufacture usage or costs,
 * touch successful executions, or downgrade pending/settled billing evidence.
 */
export async function markAbandonedRequests(database: D1Database, now: number, options: AbandonedScanOptions = {}): Promise<AbandonedScanResult> {
  const limit = options.limit ?? 20;
  const duration = options.requestMaxDurationMs ?? DEFAULT_CONFIG.requestMaxDurationMs;
  const grace = options.graceMs ?? DEFAULT_CONFIG.abandonedRequestGraceMs;
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(duration) || duration < 1
    || !Number.isSafeInteger(grace) || grace < 0 || !Number.isSafeInteger(duration + grace)
    || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError('invalid_request');
  const cutoff = now - duration - grace;
  if (cutoff <= 0) return { selected: 0, abandoned: 0, skipped: 0 };
  try {
    const candidates = (await prepare<Candidate>(database, `SELECT id,user_id,created_at,started_at FROM requests
      WHERE billing_status='awaiting_usage' AND execution_status='admitted' AND finished_at IS NULL
        AND usage_quality IN ('missing','partial','invalid') AND fingerprint IS NULL AND cost_units IS NULL
        AND COALESCE(started_at,created_at)<?
        AND NOT EXISTS(SELECT 1 FROM billing_entries b WHERE b.request_id=requests.id AND b.kind='consumption')
      ORDER BY created_at,id LIMIT ?`, [cutoff, limit]).all()).rows;
    let abandoned = 0;
    for (const candidate of candidates) {
      const result = await prepare(database, `UPDATE requests SET execution_status='abandoned',billing_status='usage_unknown',
        finished_at=?,updated_at=max(updated_at,?),next_retry_at=NULL,
        error_code='request_abandoned',error_message='Request exceeded its duration and grace period without complete usage.'
        WHERE id=? AND user_id=? AND created_at=? AND started_at IS ?
          AND billing_status='awaiting_usage' AND execution_status='admitted' AND finished_at IS NULL
          AND usage_quality IN ('missing','partial','invalid') AND fingerprint IS NULL AND cost_units IS NULL
          AND COALESCE(started_at,created_at)<?
          AND NOT EXISTS(SELECT 1 FROM billing_entries b WHERE b.request_id=requests.id AND b.kind='consumption')`,
        [now, now, candidate.id, candidate.user_id, candidate.created_at, candidate.started_at, cutoff]).run();
      if (result.changes === 1) abandoned++;
    }
    return { selected: candidates.length, abandoned, skipped: candidates.length - abandoned };
  } catch (error) { throw new ApiError('service_unavailable', { cause: error }); }
}
