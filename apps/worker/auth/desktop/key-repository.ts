import { batch, prepare } from '../../db';
import type { DbStatement } from '../../db';
import { ApiError } from '../../http';
import { preparePlatformKeyCreation } from '../key-creation';
import type { PlatformKeyCreationGuard, PreparedPlatformKeyCreation } from '../key-creation';

export type DesktopKeyFailureReason =
  | 'session_expired'
  | 'session_revoked'
  | 'user_inactive'
  | 'group_unavailable'
  | 'key_revoked'
  | 'binding_unavailable'
  | 'key_creation_unavailable';

export class DesktopKeyError extends ApiError {
  constructor(readonly reason: DesktopKeyFailureReason) {
    super(reason === 'binding_unavailable' ? 'service_unavailable'
      : reason === 'session_expired' || reason === 'session_revoked' || reason === 'user_inactive' ? 'unauthorized'
        : reason === 'key_creation_unavailable' ? 'service_unavailable' : 'forbidden');
    this.name = 'DesktopKeyError';
  }
}

export interface DesktopSessionKeyState {
  id: string;
  user_id: string;
  expires_at: number;
  revoked_at: number | null;
  current_key_id: string | null;
  current_key: string | null;
  key_generation: number;
  created_at: number;
  user_status: string | null;
  user_created_at: number | null;
  default_group_id: string | null;
  default_group_status: string | null;
  default_group_created_at: number | null;
  authorized_default_group_id: string | null;
  key_id: string | null;
  key_user_id: string | null;
  key_kind: string | null;
  key_hash: string | null;
  key_status: string | null;
  key_expires_at: number | null;
  key_desktop_session_id: string | null;
  key_group_id: string | null;
  key_group_status: string | null;
  authorized_key_group_id: string | null;
  key_created_at: number | null;
  key_updated_at: number | null;
  key_version: number | null;
}

/** Read the authenticated session, its owner/group state and its bound Key. */
export async function findDesktopSessionKeyState(
  database: D1Database,
  sessionId: string,
): Promise<DesktopSessionKeyState | null> {
  return prepare<DesktopSessionKeyState>(database, `
    SELECT s.id,s.user_id,s.expires_at,s.revoked_at,s.current_key_id,s.current_key,
      s.key_generation,s.created_at,u.status AS user_status,u.group_id AS default_group_id,
      u.created_at AS user_created_at,default_group.status AS default_group_status,
      default_group.created_at AS default_group_created_at,default_access.group_id AS authorized_default_group_id,
      k.id AS key_id,k.user_id AS key_user_id,k.kind AS key_kind,k.key_hash AS key_hash,k.status AS key_status,
      k.expires_at AS key_expires_at,k.desktop_session_id AS key_desktop_session_id,
      k.group_id AS key_group_id,key_group.status AS key_group_status,
      key_access.group_id AS authorized_key_group_id,k.created_at AS key_created_at,
      k.updated_at AS key_updated_at,k.version AS key_version
    FROM desktop_sessions s
    LEFT JOIN users u ON u.id=s.user_id
    LEFT JOIN groups default_group ON default_group.id=u.group_id
    LEFT JOIN user_group_access default_access ON default_access.user_id=u.id AND default_access.group_id=u.group_id
    LEFT JOIN api_keys k ON k.id=s.current_key_id
    LEFT JOIN groups key_group ON key_group.id=k.group_id
    LEFT JOIN user_group_access key_access ON key_access.user_id=k.user_id AND key_access.group_id=k.group_id
    WHERE s.id=?`, [sessionId]).first();
}

function sessionStateGuard(state: DesktopSessionKeyState, now: number): PlatformKeyCreationGuard {
  const priorKeyCondition = state.current_key_id === null ? '' : `
    AND EXISTS (
      SELECT 1 FROM api_keys prior_key
      JOIN groups prior_group ON prior_group.id=prior_key.group_id AND prior_group.status='active'
      JOIN user_group_access prior_access ON prior_access.user_id=prior_key.user_id AND prior_access.group_id=prior_key.group_id
      WHERE prior_key.id=? AND prior_key.user_id=s.user_id AND prior_key.desktop_session_id=s.id
        AND prior_key.kind='api' AND prior_key.status='active'
        AND prior_key.expires_at=? AND prior_key.expires_at<=? AND prior_key.group_id=?
    )`;
  const priorValues = state.current_key_id === null ? [] : [
    state.current_key_id, state.key_expires_at, now, state.key_group_id,
  ];
  return {
    sql: `EXISTS (
      SELECT 1 FROM desktop_sessions s
      JOIN users owner ON owner.id=s.user_id AND owner.status='active'
      JOIN groups default_group ON default_group.id=owner.group_id AND default_group.status='active'
      JOIN user_group_access default_access ON default_access.user_id=owner.id AND default_access.group_id=owner.group_id
      WHERE s.id=? AND s.user_id=? AND s.created_at=? AND s.expires_at=? AND s.expires_at>?
        AND s.revoked_at IS NULL AND s.key_generation=?
        AND s.current_key_id IS ? AND s.current_key IS ?${priorKeyCondition}
    )`,
    values: [state.id, state.user_id, state.created_at, state.expires_at, now, state.key_generation,
      state.current_key_id, state.current_key, ...priorValues],
  };
}

/** Prepare a normal, default-group API Key whose INSERT is guarded by session CAS state. */
export async function prepareDesktopSessionKeyCreation(
  database: D1Database,
  state: DesktopSessionKeyState,
  now: number,
  expiresAt: number,
): Promise<PreparedPlatformKeyCreation> {
  return preparePlatformKeyCreation(database, state.user_id, {
    operationId: `desktop:${crypto.randomUUID()}`,
    name: 'Desktop session key',
    expiresAt,
    allowedModels: null,
  }, now, {
    desktopSessionId: state.id,
    insertGuard: sessionStateGuard(state, now),
  });
}

export type DesktopKeyCommitResult = { readonly kind: 'committed' } | { readonly kind: 'not_committed' };

/**
 * Insert the candidate, CAS the session pointer/credential, and revoke the old
 * naturally expired Key in one D1 batch. The final guarded cleanup revokes an
 * inserted candidate if an unexpected zero-row CAS leaves it unbound; D1 does
 * not roll a batch back for a zero-row update.
 */
export async function commitDesktopSessionKeyCreation(
  database: D1Database,
  state: DesktopSessionKeyState,
  now: number,
  creation: PreparedPlatformKeyCreation,
): Promise<DesktopKeyCommitResult> {
  const guard = sessionStateGuard(state, now);
  const candidate = creation.candidate;
  const bind = prepare(database, `
    UPDATE desktop_sessions SET current_key_id=?,current_key=?,key_generation=key_generation+1,updated_at=?
    WHERE id=? AND user_id=? AND key_generation=? AND current_key_id IS ? AND current_key IS ?
      AND ${guard.sql}
      AND EXISTS (
        SELECT 1 FROM api_keys candidate
        JOIN users owner ON owner.id=candidate.user_id AND owner.status='active' AND owner.group_id=candidate.group_id
        JOIN groups candidate_group ON candidate_group.id=candidate.group_id AND candidate_group.status='active'
        JOIN user_group_access candidate_access ON candidate_access.user_id=candidate.user_id AND candidate_access.group_id=candidate.group_id
        WHERE candidate.id=? AND candidate.user_id=desktop_sessions.user_id
          AND candidate.desktop_session_id=desktop_sessions.id AND candidate.kind='api'
          AND candidate.status='active' AND candidate.expires_at=?
      )`, [candidate.id, candidate.token, now, state.id, state.user_id, state.key_generation,
    state.current_key_id, state.current_key, ...(guard.values ?? []), candidate.id, candidate.expiresAt]);
  const statements: DbStatement<unknown>[] = [creation.statement, bind];
  if (state.current_key_id !== null) {
    statements.push(prepare(database, `
      UPDATE api_keys SET status='revoked',updated_at=?,version=version+1
      WHERE id=? AND user_id=? AND desktop_session_id=? AND kind='api' AND status='active'
        AND expires_at=? AND expires_at<=?
        AND EXISTS (
          SELECT 1 FROM desktop_sessions current_session
          WHERE current_session.id=? AND current_session.current_key_id=?
            AND current_session.current_key=?
        )`, [now, state.current_key_id, state.user_id, state.id, state.key_expires_at, now,
      state.id, candidate.id, candidate.token]));
  }
  const cleanup = prepare(database, `
    UPDATE api_keys SET status='revoked',updated_at=?,version=version+1
    WHERE id=? AND user_id=? AND desktop_session_id=? AND kind='api' AND status='active'
      AND NOT EXISTS (
        SELECT 1 FROM desktop_sessions current_session
        WHERE current_session.id=? AND current_session.current_key_id=?
          AND current_session.current_key=?
      )`, [now, candidate.id, state.user_id, state.id, state.id, candidate.id, candidate.token]);
  statements.push(cleanup);

  const results = await batch(database, statements);
  const inserted = results[0];
  const bound = results[1];
  const priorKeyRevoked = state.current_key_id === null ? null : results[2];
  const cleanedOrphan = results[results.length - 1];
  if (inserted === undefined || bound === undefined || cleanedOrphan === undefined
    || (state.current_key_id !== null && priorKeyRevoked === undefined)) {
    throw new DesktopKeyError('binding_unavailable');
  }
  const priorKeyRevokedResult = priorKeyRevoked ?? null;
  if (inserted.changes === 0 && bound.changes === 0 && cleanedOrphan.changes === 0
    && (priorKeyRevokedResult === null || priorKeyRevokedResult.changes === 0)) return { kind: 'not_committed' };
  if (inserted.changes === 1 && bound.changes === 0 && cleanedOrphan.changes === 1
    && (priorKeyRevokedResult === null || priorKeyRevokedResult.changes === 0)) return { kind: 'not_committed' };
  if (inserted.changes === 1 && bound.changes === 1 && cleanedOrphan.changes === 0
    && (priorKeyRevokedResult === null || priorKeyRevokedResult.changes === 1)) return { kind: 'committed' };
  throw new DesktopKeyError('binding_unavailable');
}
