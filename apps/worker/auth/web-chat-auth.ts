import { prepare } from '../db';
import { ApiError } from '../http';
import { readPlatformKeyMetadata } from './key-repository';
import type { InternalPlatformKeyAuth } from './key-repository';

/** A web-chat identity is an internal projection, never an HTTP credential. */
export type WebChatAuthFailure = 'unauthorized' | 'authentication_unavailable';

export class WebChatAuthError extends ApiError {
  constructor(readonly reason: WebChatAuthFailure, options?: ErrorOptions) {
    super(reason === 'authentication_unavailable' ? 'service_unavailable' : 'unauthorized', options);
    this.name = 'WebChatAuthError';
  }
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

interface WebChatRow {
  id: string; user_id: string; kind: 'web_chat'; name: string; display_prefix: null;
  status: 'active' | 'revoked'; allowed_models_json: null; expires_at: null;
  created_at: number; updated_at: number; version: number; group_id: null; group_name: null;
  user_status: string; user_role: string; user_version: number; balance_units: string;
  concurrency_limit: number; rpm_limit: number;
  selected_group_id: string; selected_group_name: string; selected_group_status: string; selected_group_version: number;
}

function failure(reason: WebChatAuthFailure): never {
  throw new WebChatAuthError(reason);
}

function readWebChatAuth(row: WebChatRow, userId: string, groupId: string, now: number): InternalPlatformKeyAuth {
  let key;
  try {
    key = readPlatformKeyMetadata(row);
  } catch {
    return failure('authentication_unavailable');
  }
  if (key.kind !== 'web_chat' || key.userId !== userId || key.groupId !== null || key.groupName !== null
    || key.displayPrefix !== null || key.status !== 'active' || key.expiresAt !== null || key.createdAt > now
    || row.user_status !== 'active' || !['user', 'admin'].includes(row.user_role)
    || row.selected_group_id !== groupId || row.selected_group_status !== 'active'
    || !validTime(row.user_version) || row.user_version < 1
    || !validTime(row.selected_group_version) || row.selected_group_version < 1
    || !validTime(row.concurrency_limit) || row.concurrency_limit < 1
    || !validTime(row.rpm_limit) || row.rpm_limit < 1
    || typeof row.balance_units !== 'string' || !/^-?\d+$/u.test(row.balance_units)
    || !Number.isSafeInteger(Number(row.balance_units))) return failure('authentication_unavailable');
  return Object.freeze({
    key: Object.freeze({ ...key, allowedModels: null }),
    user: Object.freeze({ id: userId, status: 'active', role: row.user_role as 'user' | 'admin', version: row.user_version,
      balanceUnits: row.balance_units, concurrencyLimit: row.concurrency_limit, rpmLimit: row.rpm_limit }),
    // The selected group is request-scoped authorization. It is intentionally
    // separate from key.groupId, which remains NULL for this shared identity.
    group: Object.freeze({ id: groupId, status: 'active', version: row.selected_group_version }),
  });
}

/**
 * Resolve the shared per-user web-chat Key and the group selected for this
 * request. The caller must pass the user ID obtained from a validated session;
 * this function never reads identity from a request header or body. Every call
 * rechecks user status, owner-group status, selected-group status, and the
 * user_group_access grant. A virtual Key is created once, concurrently safely,
 * with NULL credentials and NULL group_id.
 */
export async function authenticateWebChat(
  database: D1Database,
  userId: string,
  groupId: string,
  now: number,
): Promise<InternalPlatformKeyAuth> {
  if (!identifier(userId) || !identifier(groupId) || !validTime(now)) failure('unauthorized');
  const keyId = crypto.randomUUID();
  try {
    await prepare(database, `
      INSERT INTO api_keys
        (id,user_id,key_hash,display_prefix,name,status,expires_at,allowed_models_json,
         created_at,updated_at,version,creation_operation_id,creation_fingerprint,group_id,kind)
      SELECT ?,u.id,NULL,NULL,'Web chat','active',NULL,NULL,?,?,1,NULL,NULL,NULL,'web_chat'
      FROM users u
      JOIN groups owner_group ON owner_group.id=u.group_id AND owner_group.status='active'
      JOIN groups selected_group ON selected_group.id=? AND selected_group.status='active'
      JOIN user_group_access access ON access.user_id=u.id AND access.group_id=selected_group.id AND access.created_at<=?
      WHERE u.id=? AND u.status='active' AND u.created_at<=? AND selected_group.created_at<=?
      ON CONFLICT(user_id) WHERE kind='web_chat' DO NOTHING`,
    [keyId, now, now, groupId, now, userId, now, now]).run();

    const row = await prepare<WebChatRow>(database, `
      SELECT k.id,k.user_id,k.kind,k.name,k.display_prefix,k.status,k.allowed_models_json,
        k.expires_at,k.created_at,k.updated_at,k.version,k.group_id,NULL AS group_name,
        u.status AS user_status,u.role AS user_role,u.version AS user_version,
        CAST(u.balance_units AS TEXT) AS balance_units,u.concurrency_limit,u.rpm_limit,
        selected_group.id AS selected_group_id,selected_group.name AS selected_group_name,
        selected_group.status AS selected_group_status,selected_group.version AS selected_group_version
      FROM api_keys k
      JOIN users u ON u.id=k.user_id
      JOIN groups owner_group ON owner_group.id=u.group_id AND owner_group.status='active'
      JOIN groups selected_group ON selected_group.id=? AND selected_group.status='active'
      JOIN user_group_access access ON access.user_id=u.id AND access.group_id=selected_group.id AND access.created_at<=?
      WHERE k.user_id=? AND k.kind='web_chat' AND k.status='active'
        AND k.created_at<=? AND k.expires_at IS NULL
        AND u.status='active' AND u.created_at<=?`,
    [groupId, now, userId, now, now]).first();
    if (!row) failure('unauthorized');
    return readWebChatAuth(row, userId, groupId, now);
  } catch (error) {
    if (error instanceof WebChatAuthError) throw error;
    throw new WebChatAuthError('authentication_unavailable', { cause: error });
  }
}
