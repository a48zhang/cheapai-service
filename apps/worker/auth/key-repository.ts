import { prepare } from '../db';
import type { DbValue } from '../db';
import { ApiError } from '../http';
import { generateToken, getTokenDisplayPrefix, hashToken } from './tokens';

export interface CreatePlatformKeyInput {
  readonly operationId: string;
  readonly groupId?: string;
  readonly name: string;
  readonly expiresAt?: number | null;
  /** Omitted/null uses the selected group. Legacy explicit subsets are retained. */
  readonly allowedModels?: readonly string[] | null;
}

export interface PlatformKeyMetadata {
    readonly id: string;
    readonly userId: string;
    /** API Keys are group-bound; the shared web-chat identity is not. */
    readonly kind: 'api' | 'web_chat';
    readonly groupId: string | null;
    readonly groupName: string | null;
    readonly name: string;
    readonly displayPrefix: string | null;
    readonly status: 'active' | 'revoked';
    readonly allowedModels: readonly string[] | null;
    readonly expiresAt: number | null;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly version: number;
}

export type CreatePlatformKeyResult =
  | { readonly kind: 'created'; readonly key: PlatformKeyMetadata; readonly token: string }
  | { readonly kind: 'replayed'; readonly key: PlatformKeyMetadata };

interface StoredCreation {
  id: string; user_id: string; kind: 'api' | 'web_chat'; group_id: string | null; group_name: string | null;
  name: string; display_prefix: string | null; status: 'active' | 'revoked';
  allowed_models_json: string | null; expires_at: number | null; created_at: number; updated_at: number;
  version: number; creation_fingerprint: string | null;
}

export class PlatformKeyCreationConflict extends ApiError {
  constructor() { super('conflict'); this.name = 'PlatformKeyCreationConflict'; }
}

export class PlatformKeyCreationError extends Error {
  readonly code = 'key_owner_or_models_unavailable';
  constructor() {
    super('An active owner, group and permitted model selection are required.');
    this.name = 'PlatformKeyCreationError';
  }
}

function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}
function time(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * trustedOwnerId comes from authenticated server context, never request-body
 * ownership. Authorization and insert are one D1 statement, not read-then-write.
 * Current model access means active public model + active channel mapped to the
 * owner's active group. A Key's restrictions must still be intersected with
 * current owner access at EVERY gateway admission; creation is not a grant.
 *
 * D16 scopes operation IDs to owners. Only a winning insertion returns a secret;
 * replay returns CURRENT metadata even after expiry/revocation/ordinary edits.
 * Replays require an active owner/group but confer no new model permissions.
 * Original fingerprint is immutable and excludes retry time and mutable state.
 * No automatic retry or audit write is hidden here. All unrelated DB errors
 * propagate; only the explicit owner/operation unique conflict is absorbed.
 */
export async function createPlatformKey(
  database: D1Database,
  trustedOwnerId: string,
  input: CreatePlatformKeyInput,
  now: number,
): Promise<CreatePlatformKeyResult> {
  if (!validText(trustedOwnerId, 128)) throw new TypeError('Invalid Key owner.');
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid Key input.');
  for (const field of Object.keys(input)) if (!['operationId', 'name', 'expiresAt', 'allowedModels', 'groupId'].includes(field)) throw new TypeError('Unknown Key input field.');
  if (typeof input.operationId !== 'string' || !input.operationId.length || input.operationId.length > 128
    || /[^A-Za-z0-9_.:-]/u.test(input.operationId)) throw new TypeError('Invalid creation operation ID.');
  if (typeof input.name !== 'string' || input.name.length > 256 || /[\u0000-\u001f\u007f]/u.test(input.name)) throw new TypeError('Invalid Key name.');
  const name = input.name.trim().normalize('NFC');
  if (!validText(name, 128) || /s2a_(?:key|session|invite)_[A-Za-z0-9_-]{43}/u.test(name)) throw new TypeError('Invalid Key name.');
  if (!time(now)) throw new TypeError('Invalid creation timestamp.');
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt !== null && !time(expiresAt)) throw new TypeError('Invalid Key expiry.');
  const groupId = input.groupId ?? null;
  if (groupId !== null && !validText(groupId, 128)) throw new TypeError('Invalid Key group.');
  const selection = input.allowedModels === undefined ? null : input.allowedModels;
  if (selection !== null && (!Array.isArray(selection) || selection.length > 100
    || !Array.from(selection).every(model => validText(model, 128)) || new Set(selection).size !== selection.length)) {
    throw new TypeError('Invalid Key model selection.');
  }
  // Copy all caller-controlled values before awaiting crypto/DB operations.
  const operationId = input.operationId;
  const allowedModels = selection === null ? null : [...selection].sort();
  const allowedJson = allowedModels === null ? null : JSON.stringify(allowedModels);
  const fingerprintBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    JSON.stringify(['platform-key-create', 2, name, expiresAt, allowedModels, groupId]),
  )));
  const fingerprint = Array.from(fingerprintBytes, byte => byte.toString(16).padStart(2, '0')).join('');
  const token = generateToken('apiKey');
  const keyHash = await hashToken('apiKey', token);
  const displayPrefix = getTokenDisplayPrefix('apiKey', token);
  const id = crypto.randomUUID();
  const result = await prepare<{ id: string; group_id: string; group_name: string }>(database, `
    INSERT INTO api_keys
      (id, user_id, key_hash, display_prefix, name, status, expires_at,
       allowed_models_json, created_at, updated_at, version, creation_operation_id, creation_fingerprint, group_id, kind)
    SELECT ?, u.id, ?, ?, ?, 'active', ?, ?, ?, ?, 1, ?, ?, g.id, 'api'
    FROM users u JOIN groups g ON g.id = COALESCE(?, u.group_id)
    JOIN user_group_access a ON a.user_id=u.id AND a.group_id=g.id
    JOIN groups owner_group ON owner_group.id=u.group_id AND owner_group.status='active'
    WHERE u.id = ? AND u.status = 'active' AND g.status = 'active'
      AND u.created_at <= ? AND g.created_at <= ?
      AND (? IS NULL OR ? > ?)
      AND NOT EXISTS (
        SELECT 1 FROM json_each(?) requested
        WHERE NOT EXISTS (
          SELECT 1 FROM models m
          JOIN channel_models cm ON cm.public_model_id = m.public_model_id
          JOIN channels c ON c.id = cm.channel_id
          JOIN channel_groups cg ON cg.channel_id = c.id
          WHERE m.public_model_id = requested.value AND m.status = 'active'
            AND c.status = 'active' AND cg.group_id = g.id
        )
      )
    ON CONFLICT(user_id, creation_operation_id) WHERE creation_operation_id IS NOT NULL DO NOTHING
    RETURNING id,group_id,(SELECT name FROM groups WHERE groups.id=api_keys.group_id) AS group_name`, [id, keyHash, displayPrefix, name, expiresAt, allowedJson,
    now, now, operationId, fingerprint, groupId, trustedOwnerId, now, now, expiresAt, expiresAt, now, allowedJson]).run();
  if (result.changes === 1 && result.rows[0]?.id === id) return { kind: 'created', token, key: {
    id, userId: trustedOwnerId, kind: 'api', groupId: result.rows[0].group_id, groupName: result.rows[0].group_name, name, displayPrefix, status: 'active', allowedModels,
    expiresAt, createdAt: now, updatedAt: now, version: 1,
  } };
  if (result.changes !== 0 || result.rows.length !== 0) throw new Error('Unexpected Key insertion result.');
  const existing = await prepare<StoredCreation>(database, `
    SELECT k.id,k.user_id,k.kind,k.name,k.display_prefix,k.status,k.allowed_models_json,k.expires_at,
      k.created_at,k.updated_at,k.version,k.creation_fingerprint,k.group_id,
      (SELECT name FROM groups WHERE id=k.group_id) AS group_name
    FROM api_keys k JOIN users u ON u.id=k.user_id JOIN groups g ON g.id=u.group_id
    WHERE k.user_id=? AND k.kind='api' AND k.creation_operation_id=? AND u.status='active' AND g.status='active'
      AND u.created_at<=? AND g.created_at<=?`, [trustedOwnerId, operationId, now, now]).first();
  if (existing) {
    if (existing.creation_fingerprint !== fingerprint) throw new PlatformKeyCreationConflict();
    return { kind: 'replayed', key: readPlatformKeyMetadata(existing) };
  }
  if (expiresAt !== null && expiresAt <= now) throw new TypeError('Key expiry must be after creation.');
  throw new PlatformKeyCreationError();
}

export class PlatformKeyStorageError extends Error {
  readonly code = 'invalid_stored_platform_key';
  constructor() { super('Stored platform Key data is invalid.'); this.name = 'PlatformKeyStorageError'; }
}

/** Validate and project a stored key row; raw credential columns are ignored. */
export function readPlatformKeyMetadata(value: unknown): PlatformKeyMetadata {
  if (value === null || typeof value !== 'object') throw new PlatformKeyStorageError();
  const row = value as Record<string, unknown>;
  const kind = row.kind === undefined ? 'api' : row.kind;
  if ((kind !== 'api' && kind !== 'web_chat')
    || !validText(row.id, 128) || !validText(row.user_id, 128) || !validText(row.name, 128)
    || /s2a_(?:key|session|invite)_[A-Za-z0-9_-]{43}/u.test(row.name)
    || (row.status !== 'active' && row.status !== 'revoked')
    || !time(row.created_at) || !time(row.updated_at) || row.updated_at < row.created_at
    || !time(row.version) || row.version < 1
    || (row.expires_at !== null && (!time(row.expires_at) || row.expires_at <= row.created_at))) throw new PlatformKeyStorageError();
  if (kind === 'api') {
    if (!validText(row.group_id, 128) || !validText(row.group_name, 128)
      || typeof row.display_prefix !== 'string' || row.display_prefix.length !== 16
      || !/^s2a_key_[A-Za-z0-9_-]{8}$/.test(row.display_prefix)) throw new PlatformKeyStorageError();
  } else if (row.group_id !== null || row.group_name !== null || row.display_prefix !== null
    || row.expires_at !== null || row.allowed_models_json !== null) throw new PlatformKeyStorageError();
  let models: unknown;
  if (row.allowed_models_json === null) models = null;
  else {
    if (typeof row.allowed_models_json !== 'string' || row.allowed_models_json.length > 32_768) throw new PlatformKeyStorageError();
    try { models = JSON.parse(row.allowed_models_json) as unknown; } catch { throw new PlatformKeyStorageError(); }
    if (!Array.isArray(models) || models.length > 100 || !models.every(model => validText(model, 128))
      || new Set(models).size !== models.length) throw new PlatformKeyStorageError();
  }
  return { id: row.id, userId: row.user_id, kind, groupId: row.group_id as string | null, groupName: row.group_name as string | null, name: row.name, displayPrefix: row.display_prefix as string | null,
    status: row.status, allowedModels: models as string[] | null, expiresAt: row.expires_at,
    createdAt: row.created_at, updatedAt: row.updated_at, version: row.version };
}

const keyColumns = `k.id,k.user_id,k.kind,k.name,k.display_prefix,k.status,k.allowed_models_json,
  k.expires_at,k.created_at,k.updated_at,k.version,k.group_id,
  (SELECT name FROM groups WHERE id=k.group_id) AS group_name`;
const ownerJoin = 'FROM api_keys k JOIN users u ON u.id=k.user_id JOIN groups g ON g.id=u.group_id';
const activeOwner = "u.status='active' AND g.status='active' AND u.created_at<=? AND g.created_at<=?";

function requireReadScope(ownerId: string, now: number): void {
  if (!validText(ownerId, 128) || !time(now)) throw new TypeError('Invalid Key read scope.');
}

/** Public self-service read: an expired/revoked Key remains visible to its active owner. */
export async function findPlatformKeyById(database: D1Database, trustedOwnerId: string, keyId: string, now: number): Promise<PlatformKeyMetadata | null> {
  requireReadScope(trustedOwnerId, now);
  if (!validText(keyId, 128)) throw new TypeError('Invalid Key ID.');
  const row = await prepare<Record<string, unknown>>(database,
    `SELECT ${keyColumns} ${ownerJoin} WHERE k.user_id=? AND k.id=? AND k.kind='api' AND ${activeOwner} AND k.created_at<=?`,
    [trustedOwnerId, keyId, now, now, now]).first();
  return row === null ? null : readPlatformKeyMetadata(row);
}

export type PlatformKeyListState = 'all' | 'active' | 'expired' | 'revoked';
export interface PlatformKeyListOptions {
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly state?: PlatformKeyListState;
}
export interface PlatformKeyPage {
  readonly items: readonly PlatformKeyMetadata[];
  readonly nextCursor: string | null;
}

function cursorEncode(value: readonly unknown[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Descending created_at/id keyset pagination. Cursor pins creation/expiry asOf,
 * owner and state, but is not an authentication credential: SQL always uses the
 * authenticated owner. Concurrent revocations/edits are visible, not MVCC snapshots.
 */
export async function listPlatformKeys(database: D1Database, trustedOwnerId: string, options: PlatformKeyListOptions, now: number): Promise<PlatformKeyPage> {
  requireReadScope(trustedOwnerId, now);
  if (options === null || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !['limit', 'cursor', 'state'].includes(key))) throw new TypeError('Invalid Key list options.');
  const limit = options.limit ?? 20;
  const state = options.state ?? 'all';
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !['all', 'active', 'expired', 'revoked'].includes(state)) throw new TypeError('Invalid Key list options.');
  let asOf = now;
  let afterTime: number | null = null;
  let afterId: string | null = null;
  if (options.cursor != null) {
    try {
      if (typeof options.cursor !== 'string' || !options.cursor.length || options.cursor.length > 1024 || /[^A-Za-z0-9_-]/u.test(options.cursor)) throw new Error();
      const bytes = Uint8Array.from(atob(options.cursor.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
      const tuple: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
      if (!Array.isArray(tuple) || tuple.length !== 6 || cursorEncode(tuple) !== options.cursor
        || tuple[0] !== 1 || tuple[1] !== trustedOwnerId || tuple[2] !== state
        || !time(tuple[3]) || tuple[3] > now || !time(tuple[4]) || tuple[4] > tuple[3] || !validText(tuple[5], 128)) throw new Error();
      asOf = tuple[3]; afterTime = tuple[4]; afterId = tuple[5];
    } catch { throw new TypeError('Invalid or mismatched Key cursor.'); }
  }
  const filter = state === 'active' ? "k.status='active' AND (k.expires_at IS NULL OR k.expires_at>?)"
    : state === 'expired' ? "k.status='active' AND k.expires_at<=?"
    : state === 'revoked' ? "k.status='revoked'" : '1=1';
  const values: DbValue[] = [trustedOwnerId, now, now, asOf];
  if (state === 'active' || state === 'expired') values.push(asOf);
  values.push(afterTime, afterTime, afterTime, afterId, limit + 1);
  const result = await prepare<Record<string, unknown>>(database, `SELECT ${keyColumns} ${ownerJoin}
    WHERE k.user_id=? AND k.kind='api' AND ${activeOwner} AND k.created_at<=? AND ${filter}
      AND (? IS NULL OR k.created_at<? OR (k.created_at=? AND k.id<?))
    ORDER BY k.created_at DESC,k.id DESC LIMIT ?`, values).all();
  const checked = result.rows.map(readPlatformKeyMetadata);
  const items = checked.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: checked.length > limit && last
    ? cursorEncode([1, trustedOwnerId, state, asOf, last.createdAt, last.id]) : null };
}

export interface InternalPlatformKeyAuth {
  readonly key: PlatformKeyMetadata;
  readonly user: {
    readonly id: string; readonly status: 'active'; readonly role: 'user' | 'admin'; readonly version: number;
    readonly balanceUnits: string; readonly concurrencyLimit: number; readonly rpmLimit: number;
  };
  readonly group: { readonly id: string; readonly status: 'active'; readonly version: number };
}

/**
 * Internal admission lookup only. Excludes expired/revoked/future Keys and inactive
 * owners/groups; A27 must still enforce requested-model access and concurrency.
 * Never returns token, key hash, password, or creation idempotency metadata.
 */
export async function findInternalPlatformKeyByHash(database: D1Database, keyHash: string, now: number): Promise<InternalPlatformKeyAuth | null> {
  if (typeof keyHash !== 'string' || !/^[a-f0-9]{64}$/.test(keyHash) || keyHash.length !== 64 || !time(now)) throw new TypeError('Invalid Key lookup.');
  const row = await prepare<Record<string, unknown>>(database, `SELECT ${keyColumns},
    u.status AS user_status,u.role AS user_role,u.version AS user_version,
    CAST(u.balance_units AS TEXT) AS balance_units,u.concurrency_limit,u.rpm_limit,
    g.id AS group_id,g.status AS group_status,g.version AS group_version
    FROM api_keys k JOIN users u ON u.id=k.user_id JOIN groups g ON g.id=k.group_id
    JOIN user_group_access access ON access.user_id=u.id AND access.group_id=g.id
    JOIN groups owner_group ON owner_group.id=u.group_id AND owner_group.status='active' WHERE k.kind='api' AND k.key_hash=? AND ${activeOwner}
      AND k.status='active' AND k.created_at<=? AND (k.expires_at IS NULL OR k.expires_at>?)`,
    [keyHash, now, now, now, now]).first();
  if (row === null) return null;
  const key = readPlatformKeyMetadata(row);
  if (row.user_status !== 'active' || row.group_status !== 'active' || !validText(row.group_id, 128)
    || !['user', 'admin'].includes(String(row.user_role))
    || !time(row.user_version) || row.user_version < 1 || !time(row.group_version) || row.group_version < 1
    || !time(row.concurrency_limit) || row.concurrency_limit < 1 || !time(row.rpm_limit) || row.rpm_limit < 1
    || typeof row.balance_units !== 'string' || !/^-?\d+$/.test(row.balance_units)
    || !Number.isSafeInteger(Number(row.balance_units))) throw new PlatformKeyStorageError();
  return { key,
    user: { id: key.userId, status: 'active', role: row.user_role as 'user' | 'admin', version: row.user_version,
      balanceUnits: row.balance_units, concurrencyLimit: row.concurrency_limit, rpmLimit: row.rpm_limit },
    group: { id: row.group_id, status: 'active', version: row.group_version },
  };
}

export interface PlatformKeyPatch {
  readonly groupId?: string;
  readonly name?: string;
  readonly expiresAt?: number | null;
  readonly allowedModels?: readonly string[] | null;
}
export type PlatformKeyUpdateResult =
  | { readonly kind: 'updated'; readonly key: PlatformKeyMetadata }
  | { readonly kind: 'not_updated' };
export type PlatformKeyRevokeResult =
  | { readonly kind: 'revoked' | 'already_revoked'; readonly key: PlatformKeyMetadata }
  | { readonly kind: 'not_revoked' };

function mutationScope(ownerId: string, keyId: string, version: number, now: number): void {
  requireReadScope(ownerId, now);
  if (!validText(keyId, 128) || !time(version) || version < 1) throw new TypeError('Invalid Key mutation identity/version.');
}
const returningKeyColumns = keyColumns.replaceAll('k.', '');

/**
 * Only owner-editable fields. The pre-read validates stored data; it is not a
 * lock or the authorization decision. The UPDATE repeats owner/group/model
 * checks and CAS atomically. Missing/foreign/inactive/stale/revoked Keys all
 * produce not_updated, with no existence oracle and no partial field update.
 * Expired active Keys may have expiry explicitly extended; revoked Keys cannot.
 */
export async function updatePlatformKey(database: D1Database, trustedOwnerId: string, keyId: string,
  expectedVersion: number, patch: PlatformKeyPatch, now: number): Promise<PlatformKeyUpdateResult> {
  mutationScope(trustedOwnerId, keyId, expectedVersion, now);
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)
    || !Object.keys(patch).length || Object.keys(patch).some(field => !['name', 'expiresAt', 'allowedModels', 'groupId'].includes(field))) throw new TypeError('Invalid Key patch.');
  const changeGroup = Object.hasOwn(patch, 'groupId');
  const selectedGroup = changeGroup ? patch.groupId : null;
  if (changeGroup && !validText(selectedGroup,128)) throw new TypeError('Invalid Key group.');
  const changeName = Object.hasOwn(patch, 'name');
  const changeExpiry = Object.hasOwn(patch, 'expiresAt');
  const changeModels = Object.hasOwn(patch, 'allowedModels');
  let name: string | null = null;
  if (changeName) {
    if (typeof patch.name !== 'string' || patch.name.length > 256 || /[\u0000-\u001f\u007f]/u.test(patch.name)) throw new TypeError('Invalid Key name.');
    name = patch.name.trim().normalize('NFC');
    if (!validText(name, 128) || /s2a_(?:key|session|invite)_[A-Za-z0-9_-]{43}/u.test(name)) throw new TypeError('Invalid Key name.');
  }
  let expiry: number | null = null;
  if (changeExpiry) {
    if (patch.expiresAt !== null && (!time(patch.expiresAt) || patch.expiresAt <= now)) throw new TypeError('Key expiry must be after update time.');
    expiry = patch.expiresAt;
  }
  let modelsJson: string | null = null;
  if (changeModels) {
    const models = patch.allowedModels;
    if (models !== null && (!Array.isArray(models) || models.length > 100
      || !Array.from(models).every(model => validText(model, 128)) || new Set(models).size !== models.length)) throw new TypeError('Invalid Key model selection.');
    modelsJson = models === null ? null : JSON.stringify([...models].sort());
  }
  const current = await findPlatformKeyById(database, trustedOwnerId, keyId, now);
  if (!current || current.status !== 'active' || current.version !== expectedVersion || current.updatedAt > now) return { kind: 'not_updated' };
  const result = await prepare<Record<string, unknown>>(database, `UPDATE api_keys SET
      group_id=CASE WHEN ?=1 THEN ? ELSE group_id END,
      name=CASE WHEN ?=1 THEN ? ELSE name END,
      expires_at=CASE WHEN ?=1 THEN ? ELSE expires_at END,
      allowed_models_json=CASE WHEN ?=1 THEN ? ELSE allowed_models_json END,
      updated_at=?,version=version+1
    WHERE id=? AND user_id=? AND kind='api' AND status='active' AND version=? AND version<9007199254740991
      AND created_at<=? AND updated_at<=?
      AND EXISTS (SELECT 1 FROM users u JOIN groups g ON g.id=CASE WHEN ?=1 THEN ? ELSE api_keys.group_id END
        JOIN user_group_access access ON access.user_id=u.id AND access.group_id=g.id
        WHERE u.id=api_keys.user_id AND ${activeOwner}
          AND EXISTS(SELECT 1 FROM groups owner_group WHERE owner_group.id=u.group_id AND owner_group.status='active')
          AND NOT EXISTS (SELECT 1 FROM json_each(CASE WHEN ?=1 THEN ? ELSE api_keys.allowed_models_json END) requested
            WHERE NOT EXISTS (SELECT 1 FROM models m
              JOIN channel_models cm ON cm.public_model_id=m.public_model_id
              JOIN channels c ON c.id=cm.channel_id JOIN channel_groups cg ON cg.channel_id=c.id
              WHERE m.public_model_id=requested.value AND m.status='active' AND c.status='active' AND cg.group_id=g.id)))
    RETURNING ${returningKeyColumns}`, [Number(changeGroup), selectedGroup ?? null, Number(changeName), name, Number(changeExpiry), expiry, Number(changeModels || changeGroup), modelsJson,
    now, keyId, trustedOwnerId, expectedVersion, now, now, Number(changeGroup), selectedGroup ?? null, now, now, Number(changeModels || changeGroup), modelsJson]).run();
  if (result.changes === 0 && result.rows.length === 0) return { kind: 'not_updated' };
  if (result.changes !== 1 || !result.rows[0]) throw new Error('Unexpected Key update result.');
  return { kind: 'updated', key: readPlatformKeyMetadata(result.rows[0]) };
}

/**
 * Expiry/model changes never prevent revocation. CAS controls the first write;
 * retries/concurrent revocations return already_revoked without another write.
 * The original updated_at/version remain intact on that idempotent path.
 */
export async function revokePlatformKey(database: D1Database, trustedOwnerId: string, keyId: string,
  expectedVersion: number, now: number): Promise<PlatformKeyRevokeResult> {
  mutationScope(trustedOwnerId, keyId, expectedVersion, now);
  const current = await findPlatformKeyById(database, trustedOwnerId, keyId, now);
  if (!current) return { kind: 'not_revoked' };
  if (current.status === 'revoked') return { kind: 'already_revoked', key: current };
  if (current.version !== expectedVersion || current.updatedAt > now) return { kind: 'not_revoked' };
  const result = await prepare<Record<string, unknown>>(database, `UPDATE api_keys
    SET status='revoked',updated_at=?,version=version+1
    WHERE id=? AND user_id=? AND kind='api' AND status='active' AND version=? AND version<9007199254740991
      AND created_at<=? AND updated_at<=?
      AND EXISTS (SELECT 1 FROM users u JOIN groups g ON g.id=u.group_id WHERE u.id=api_keys.user_id AND ${activeOwner})
    RETURNING ${returningKeyColumns}`, [now, keyId, trustedOwnerId, expectedVersion, now, now, now, now]).run();
  if (result.changes === 1 && result.rows[0]) return { kind: 'revoked', key: readPlatformKeyMetadata(result.rows[0]) };
  if (result.changes !== 0 || result.rows.length !== 0) throw new Error('Unexpected Key revocation result.');
  const reread = await findPlatformKeyById(database, trustedOwnerId, keyId, now);
  return reread?.status === 'revoked' ? { kind: 'already_revoked', key: reread } : { kind: 'not_revoked' };
}

// Keep the internal chat boundary available from the Key module used by the
// service layer while the implementation remains in its dedicated auth file.
export { authenticateWebChat, WebChatAuthError } from './web-chat-auth';
