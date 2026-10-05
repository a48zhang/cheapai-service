import { prepare } from '../../db';
import { DESKTOP_SESSION_TTL_MS } from './types';
import type { StoredDesktopSession } from './types';
import { generateToken, hashToken } from '../tokens';

export interface IssuedDesktopSession {
  /** Raw bearer is returned only to the private login response path. */
  token: string;
  session: StoredDesktopSession;
}

export class DesktopSessionCreationError extends Error {
  readonly code = 'user_inactive_or_group_unavailable';

  constructor() {
    super('An active user with an authorized default group is required to create a desktop session.');
    this.name = 'DesktopSessionCreationError';
  }
}

function requireId(id: string): void {
  if (typeof id !== 'string' || !id.trim() || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new TypeError('Invalid desktop session or user ID.');
  }
}

function requireHash(hash: string): void {
  if (typeof hash !== 'string' || hash.length !== 64 || !/^[0-9a-f]{64}$/.test(hash)) {
    throw new TypeError('Expected a SHA-256 desktop token hash.');
  }
}

function requireTime(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Expected a nonnegative safe integer timestamp.');
}

/** Generate a fresh, purpose-separated bearer and persist only its digest.
 * The conditional insert rechecks both the user and its current default group.
 */
export async function createDesktopSession(
  database: D1Database,
  userId: string,
  now: number,
): Promise<IssuedDesktopSession> {
  requireId(userId);
  requireTime(now);
  const expiresAt = now + DESKTOP_SESSION_TTL_MS;
  requireTime(expiresAt);

  const token = generateToken('desktopSession');
  const tokenHash = await hashToken('desktopSession', token);
  const id = crypto.randomUUID();
  const result = await prepare<StoredDesktopSession>(database,
    `INSERT INTO desktop_sessions
       (id, token_hash, user_id, expires_at, revoked_at, current_key_id,
        current_key, key_generation, created_at, updated_at)
     SELECT ?, ?, u.id, ?, NULL, NULL, NULL, 0, ?, ?
       FROM users u
       JOIN groups g ON g.id = u.group_id AND g.status = 'active'
       JOIN user_group_access access ON access.user_id = u.id AND access.group_id = u.group_id
      WHERE u.id = ? AND u.status = 'active'
     RETURNING id, token_hash, user_id, expires_at, revoked_at, current_key_id,
       current_key, key_generation, created_at`,
    [id, tokenHash, expiresAt, now, now, userId]).run();
  const session = result.rows[0];
  if (result.changes !== 1 || !session) throw new DesktopSessionCreationError();
  return { token, session };
}

/** Read by the purpose-specific digest only; callers never pass a raw token. */
export async function findDesktopSessionByHash(
  database: D1Database,
  tokenHash: string,
): Promise<StoredDesktopSession | null> {
  requireHash(tokenHash);
  return prepare<StoredDesktopSession>(database,
    `SELECT id, token_hash, user_id, expires_at, revoked_at, current_key_id,
       current_key, key_generation, created_at
       FROM desktop_sessions WHERE token_hash = ?`, [tokenHash]).first();
}

/** Revoke only the session just issued/authorized for this user. */
export async function revokeDesktopSession(
  database: D1Database,
  sessionId: string,
  userId: string,
  now: number,
): Promise<boolean> {
  requireId(sessionId);
  requireId(userId);
  requireTime(now);
  const result = await prepare(database,
    `UPDATE desktop_sessions SET revoked_at = ?, updated_at = ?
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    [now, now, sessionId, userId]).run();
  return result.changes === 1;
}

export interface DesktopAuthUserRow {
  id: string;
  email_normalized: string;
  role: 'user' | 'admin';
  status: 'active' | 'disabled';
  group_id: string;
  group_status: 'active' | 'disabled' | null;
  balance_units: string;
  email_verified_at: number | null;
  authorized_group_id: string | null;
}

/** Current user/default-group state from the session's stored user ID. */
export async function findDesktopAuthUserById(
  database: D1Database,
  userId: string,
): Promise<DesktopAuthUserRow | null> {
  requireId(userId);
  return prepare<DesktopAuthUserRow>(database,
    `SELECT u.id, u.email_normalized, u.role, u.status, u.group_id,
       g.status AS group_status, CAST(u.balance_units AS TEXT) AS balance_units,
       u.email_verified_at, access.group_id AS authorized_group_id
       FROM users u
       LEFT JOIN groups g ON g.id = u.group_id
       LEFT JOIN user_group_access access ON access.user_id = u.id AND access.group_id = u.group_id
      WHERE u.id = ?`, [userId]).first();
}
