import { batch, prepare } from '../db';
import { ApiError } from '../http';

export const IDENTITY_CLEANUP_DEFAULT_LIMIT = 50;
export const IDENTITY_CLEANUP_MAX_LIMIT = 100;
export interface IdentityCleanupResult {
  cutoff: number;
  sessionsDeleted: number;
  challengesDeleted: number;
  moreSessions: boolean;
  moreChallenges: boolean;
}

/** One indexed page per table, at most 2*limit deletions per invocation. Callers
 * choose whether/when to schedule another page; this function never loops.
 * Only expired sessions/challenges are eligible (including expiry==cutoff).
 * No registration codes/batches, API Keys, requests, audits or ledger are touched.
 */
export async function cleanupExpiredIdentityData(database: D1Database, now: number,
  options: { limit?: number } = {}): Promise<IdentityCleanupResult> {
  const limit = options.limit ?? IDENTITY_CLEANUP_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > IDENTITY_CLEANUP_MAX_LIMIT) {
    throw new ApiError('invalid_request');
  }
  // Selection and expiry recheck share each DELETE statement. A concurrently
  // refreshed challenge cannot be removed based on an earlier application read.
  const results = await batch(database, [
    prepare<{ id: string }>(database, `DELETE FROM sessions WHERE id IN
      (SELECT id FROM sessions WHERE expires_at<=? ORDER BY expires_at,id LIMIT ?) AND expires_at<=? RETURNING id`, [now, limit, now]),
    prepare<{ id: string }>(database, `DELETE FROM email_challenges WHERE id IN
      (SELECT id FROM email_challenges WHERE expires_at<=? ORDER BY expires_at,id LIMIT ?) AND expires_at<=? RETURNING id`, [now, limit, now]),
    prepare<{ pending: number }>(database, 'SELECT EXISTS(SELECT 1 FROM sessions WHERE expires_at<=?) AS pending', [now]),
    prepare<{ pending: number }>(database, 'SELECT EXISTS(SELECT 1 FROM email_challenges WHERE expires_at<=?) AS pending', [now]),
  ] as const);
  return { cutoff: now, sessionsDeleted: results[0].rows.length, challengesDeleted: results[1].rows.length,
    moreSessions: results[2].rows[0]?.pending === 1, moreChallenges: results[3].rows[0]?.pending === 1 };
}
