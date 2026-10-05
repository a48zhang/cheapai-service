import { ApiError } from '../../http';
import { batch, prepare } from '../../db';
import { getTokenDisplayPrefix, hashToken } from '../tokens';
import { findDesktopSessionByHash } from './session-repository';
import type { StoredDesktopSession } from './types';
import { DesktopSessionAuthError } from './authenticate';

function requireNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new ApiError('service_unavailable');
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get('Authorization');
  if (authorization === null || authorization.length > 256) {
    throw new DesktopSessionAuthError('invalid_token');
  }
  const match = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(authorization);
  if (!match?.[1]) throw new DesktopSessionAuthError('invalid_token');
  try {
    getTokenDisplayPrefix('desktopSession', match[1]);
  } catch {
    throw new DesktopSessionAuthError('invalid_token');
  }
  return match[1];
}

/** Revoke the session identified by the presented Bearer token, including an
 * expired/already-revoked token so retries remain idempotent. One D1 batch
 * revokes all Keys owned by only this session and clears its returnable credential.
 */
export async function logoutDesktopSession(
  database: D1Database,
  request: Request,
  now: number,
): Promise<void> {
  requireNow(now);
  const token = bearerToken(request);
  let tokenHash: string;
  try {
    tokenHash = await hashToken('desktopSession', token);
  } catch (error) {
    throw new ApiError('service_unavailable', { cause: error });
  }

  let session: StoredDesktopSession | null;
  try {
    session = await findDesktopSessionByHash(database, tokenHash);
  } catch (error) {
    throw new ApiError('service_unavailable', { cause: error });
  }
  if (session === null) throw new DesktopSessionAuthError('invalid_token');

  try {
    await batch(database, [
      prepare(database,
        `UPDATE api_keys
            SET status = 'revoked', updated_at = MAX(updated_at, ?),
                version = CASE WHEN version < 9007199254740991 THEN version + 1 ELSE version END
          WHERE desktop_session_id = ? AND user_id = ? AND status = 'active'`,
        [now, session.id, session.user_id]),
      prepare(database,
        `UPDATE desktop_sessions
            SET revoked_at = COALESCE(revoked_at, ?),
                updated_at = CASE
                  WHEN revoked_at IS NULL OR current_key IS NOT NULL THEN MAX(updated_at, ?)
                  ELSE updated_at
                END,
                current_key = NULL
          WHERE id = ? AND user_id = ?`,
        [now, now, session.id, session.user_id]),
    ]);
  } catch (error) {
    throw new ApiError('service_unavailable', { cause: error });
  }
}
