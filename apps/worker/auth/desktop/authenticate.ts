import { ApiError } from '../../http';
import { hashToken, TokenFormatError } from '../tokens';
import { findDesktopAuthUserById, findDesktopSessionByHash } from './session-repository';
import type { DesktopAuthUserRow } from './session-repository';
import type { StoredDesktopSession, DesktopSessionFailureReason } from './types';
import type { PublicUser } from '../users';

export interface AuthenticatedDesktopSession {
  /** Publicly safe identity fields only; hashes and Key credentials stay private. */
  session: Pick<StoredDesktopSession, 'id' | 'user_id' | 'expires_at'>;
  user: PublicUser;
}

/** Invalid, expired and revoked credentials share HTTP unauthorized status while
 * retaining an internal stable reason for the desktop route/error adapter.
 * A disabled/unavailable default group maps to forbidden.
 */
export class DesktopSessionAuthError extends ApiError {
  readonly status: 401 | 403;

  constructor(readonly reason: DesktopSessionFailureReason) {
    super(reason === 'group_unavailable' ? 'forbidden' : 'unauthorized');
    this.name = 'DesktopSessionAuthError';
    this.status = reason === 'group_unavailable' ? 403 : 401;
  }
}

function invalid(): never {
  throw new DesktopSessionAuthError('invalid_token');
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get('Authorization');
  if (authorization === null || authorization.length > 256) return invalid();
  const match = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(authorization);
  if (!match?.[1]) return invalid();
  return match[1];
}

function publicUser(row: DesktopAuthUserRow): PublicUser {
  return {
    id: row.id,
    email_normalized: row.email_normalized,
    role: row.role,
    status: row.status,
    group_id: row.group_id,
    group_status: row.group_status as 'active' | 'disabled',
    balance_units: row.balance_units,
    email_verified_at: row.email_verified_at,
  };
}

/** Authenticate only from the desktop Bearer token. No client user ID, Cookie,
 * body field or API-Key header can select the identity. Database/crypto errors
 * remain 503 and are never disguised as expired or invalid credentials.
 */
export async function authenticateDesktopSession(
  database: D1Database,
  request: Request,
  now: number,
): Promise<AuthenticatedDesktopSession> {
  if (!Number.isSafeInteger(now) || now < 0) throw new ApiError('service_unavailable');

  const token = bearerToken(request);
  let tokenHash: string;
  try {
    tokenHash = await hashToken('desktopSession', token);
  } catch (error) {
    if (error instanceof TokenFormatError) return invalid();
    throw new ApiError('service_unavailable', { cause: error });
  }

  let session: StoredDesktopSession | null;
  try {
    session = await findDesktopSessionByHash(database, tokenHash);
  } catch (error) {
    throw new ApiError('service_unavailable', { cause: error });
  }
  if (session === null) throw new DesktopSessionAuthError('invalid_token');
  if (!Number.isSafeInteger(session.expires_at) || !Number.isSafeInteger(session.created_at)
      || (session.revoked_at !== null && !Number.isSafeInteger(session.revoked_at))) {
    throw new ApiError('service_unavailable');
  }
  if (session.revoked_at !== null) throw new DesktopSessionAuthError('session_revoked');
  if (session.expires_at <= now || session.created_at > now) {
    throw new DesktopSessionAuthError('session_expired');
  }

  let account: DesktopAuthUserRow | null;
  try {
    account = await findDesktopAuthUserById(database, session.user_id);
  } catch (error) {
    throw new ApiError('service_unavailable', { cause: error });
  }
  if (account === null || account.status !== 'active') {
    throw new DesktopSessionAuthError('user_inactive');
  }
  if (account.group_status !== 'active' || account.authorized_group_id !== account.group_id) {
    throw new DesktopSessionAuthError('group_unavailable');
  }

  return {
    session: { id: session.id, user_id: session.user_id, expires_at: session.expires_at },
    user: publicUser(account),
  };
}
