import { prepare } from '../db';

/** Internal storage record, never an HTTP response. Neither raw token nor hash is returned. */
export interface StoredSession {
  id: string;
  user_id: string;
  expires_at: number;
  created_at: number;
}

export interface CreateSessionInput {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: number;
}

export class SessionCreationError extends Error {
  readonly code = 'user_inactive_or_missing';

  constructor() {
    super('An active user is required to create a session.');
    this.name = 'SessionCreationError';
  }
}

function requireId(id: string): void {
  if (typeof id !== 'string' || !id.trim() || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new TypeError('Invalid session or user ID.');
  }
}

function requireHash(hash: string): void {
  if (typeof hash !== 'string' || hash.length !== 64 || !/^[0-9a-f]{64}$/.test(hash)) {
    throw new TypeError('Expected a SHA-256 token hash.');
  }
}

function requireTime(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Expected a nonnegative safe integer timestamp.');
}

/** Caller hashes an A03/F13 token before invoking this repository. No raw-token API. */
export async function createSession(
  database: D1Database,
  input: CreateSessionInput,
  now: number,
): Promise<StoredSession> {
  requireId(input.id);
  requireId(input.userId);
  requireHash(input.tokenHash);
  requireTime(now);
  requireTime(input.expiresAt);
  if (input.expiresAt <= now) throw new TypeError('Session expiry must be after creation.');
  // The active-user check and insert are one SQL statement, closing the gap
  // between password verification and a concurrent user disable operation.
  const result = await prepare<StoredSession>(database,
    `INSERT INTO sessions (id, token_hash, user_id, expires_at, revoked_at, created_at)
     SELECT ?, ?, u.id, ?, NULL, ? FROM users u WHERE u.id = ? AND u.status = ?
     RETURNING id, user_id, expires_at, created_at`,
    [input.id, input.tokenHash, input.expiresAt, now, input.userId, 'active']).run();
  const session = result.rows[0];
  if (result.changes !== 1 || !session) throw new SessionCreationError();
  return session;
}

/** Fixed expiry: reads do not update timestamps or extend a session's lifetime. */
export async function findActiveSessionByHash(
  database: D1Database,
  tokenHash: string,
  now: number,
): Promise<StoredSession | null> {
  requireHash(tokenHash);
  requireTime(now);
  return prepare<StoredSession>(database,
    `SELECT s.id, s.user_id, s.expires_at, s.created_at FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
       AND s.created_at <= ? AND u.status = ?`, [tokenHash, now, now, 'active']).first();
}

/** Current-session revocation is scoped to the trusted authenticated user ID. */
export async function revokeSession(
  database: D1Database,
  sessionId: string,
  userId: string,
  now: number,
): Promise<boolean> {
  requireId(sessionId);
  requireId(userId);
  requireTime(now);
  const result = await prepare(database,
    'UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    [now, sessionId, userId]).run();
  return result.changes === 1;
}

/** Internal account-security operation; caller authorizes the target user. */
export async function revokeUserSessions(database: D1Database, userId: string, now: number): Promise<number> {
  requireId(userId);
  requireTime(now);
  return (await prepare(database,
    'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [now, userId]).run()).changes;
}
