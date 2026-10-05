import { batch, prepare } from '../../db';
import { ApiError } from '../../http';

export const DESKTOP_SECRET_CLEANUP_DEFAULT_LIMIT = 50;
export const DESKTOP_SECRET_CLEANUP_MAX_LIMIT = 100;

export interface DesktopSecretCleanupResult {
  keysCleared: number;
  more: boolean;
}

/** Clear only returnable Key for a bounded page of expired or
 * revoked desktop sessions. Session, Key and billing history stay in place.
 */
export async function cleanupExpiredDesktopSessionSecrets(
  database: D1Database,
  now: number,
  options: { limit?: number } = {},
): Promise<DesktopSecretCleanupResult> {
  const limit = options.limit ?? DESKTOP_SECRET_CLEANUP_DEFAULT_LIMIT;
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(limit)
      || limit < 1 || limit > DESKTOP_SECRET_CLEANUP_MAX_LIMIT) {
    throw new ApiError('invalid_request');
  }

  const eligible = "current_key IS NOT NULL AND (revoked_at IS NOT NULL OR expires_at <= ?)";
  const results = await batch(database, [
    prepare<{ id: string }>(database,
      `UPDATE desktop_sessions SET current_key = NULL, updated_at = MAX(updated_at, ?)
        WHERE id IN (
          SELECT id FROM desktop_sessions WHERE ${eligible}
          ORDER BY CASE WHEN revoked_at IS NOT NULL THEN revoked_at ELSE expires_at END, id
          LIMIT ?
        ) AND ${eligible}
        RETURNING id`,
      [now, now, limit, now]),
    prepare<{ pending: number }>(database,
      `SELECT EXISTS(SELECT 1 FROM desktop_sessions WHERE ${eligible}) AS pending`, [now]),
  ] as const);
  return { keysCleared: results[0].rows.length, more: results[1].rows[0]?.pending === 1 };
}
