import { prepare } from '../db';
import type { DbStatement, DbValue } from '../db';
import { generateToken, getTokenDisplayPrefix, hashToken } from './tokens';
import type { CreatePlatformKeyInput } from './key-repository';

export interface PlatformKeyCreationInsertRow {
  readonly id: string;
  readonly group_id: string;
  readonly group_name: string;
}

export interface PlatformKeyCreationCandidate {
  readonly id: string;
  readonly userId: string;
  readonly token: string;
  readonly name: string;
  readonly displayPrefix: string;
  readonly allowedModels: readonly string[] | null;
  readonly expiresAt: number | null;
  readonly createdAt: number;
  readonly desktopSessionId: string | null;
}

/** A trusted SQL condition for callers that compose this insert in a D1 batch. */
export interface PlatformKeyCreationGuard {
  /** Static SQL authored by the caller; all data belongs in values. */
  readonly sql: string;
  readonly values?: readonly DbValue[];
}

export interface PlatformKeyCreationOptions {
  /** A trusted predicate that makes this insert conditional on caller state. */
  readonly insertGuard?: PlatformKeyCreationGuard;
  /** Binds a desktop Key at insertion time; omitted for ordinary platform Keys. */
  readonly desktopSessionId?: string;
}

export interface PreparedPlatformKeyCreation {
  /** Run this statement directly, or include it in the matching D1 batch. */
  readonly statement: DbStatement<PlatformKeyCreationInsertRow>;
  readonly candidate: PlatformKeyCreationCandidate;
  readonly operationId: string;
  readonly fingerprint: string;
}

function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function time(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Generate a candidate Key and prepare its authorization-checked insertion
 * without committing it. A caller may include the returned DbStatement in a
 * D1 batch with related writes. A guard is a trusted, static SQL predicate used
 * to make the insertion conditional on that caller's state transition; values
 * remain bound parameters. A zero-row guard is still a successful SQL write
 * result, so batch callers must inspect their results and encode invariants in
 * all relevant statements.
 */
export async function preparePlatformKeyCreation(
  database: D1Database,
  trustedOwnerId: string,
  input: CreatePlatformKeyInput,
  now: number,
  options: PlatformKeyCreationOptions = {},
): Promise<PreparedPlatformKeyCreation> {
  if (!validText(trustedOwnerId, 128)) throw new TypeError('Invalid Key owner.');
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid Key input.');
  if (typeof input.operationId !== 'string' || !input.operationId.length || input.operationId.length > 128
    || /[^A-Za-z0-9_.:-]/u.test(input.operationId)) throw new TypeError('Invalid creation operation ID.');
  if (typeof input.name !== 'string' || input.name.length > 256 || /[\u0000-\u001f\u007f]/u.test(input.name)) throw new TypeError('Invalid Key name.');
  const name = input.name.trim().normalize('NFC');
  if (!validText(name, 128) || /s2a_(?:key|session|invite|desktop)_[A-Za-z0-9_-]{43}/u.test(name)) throw new TypeError('Invalid Key name.');
  if (!time(now)) throw new TypeError('Invalid creation timestamp.');
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt !== null && !time(expiresAt)) throw new TypeError('Invalid Key expiry.');
  const groupId = input.groupId ?? null;
  if (groupId !== null && !validText(groupId, 128)) throw new TypeError('Invalid Key group.');
  const selection = input.allowedModels === undefined ? null : input.allowedModels;
  if (selection !== null && (!Array.isArray(selection)
    || !Array.from(selection).every(model => validText(model, 128)) || new Set(selection).size !== selection.length)) {
    throw new TypeError('Invalid Key model selection.');
  }
  const guard = options.insertGuard;
  const desktopSessionId = options.desktopSessionId ?? null;

  // Copy caller-controlled values before awaiting crypto/DB operations.
  const operationId = input.operationId;
  const allowedModels = selection === null ? null : [...selection].sort();
  const allowedJson = allowedModels === null ? null : JSON.stringify(allowedModels);
  const insertGuard = guard?.sql.trim() ?? '1=1';
  const guardValues = guard?.values === undefined ? [] : [...guard.values];
  const desktopSessionColumn = desktopSessionId === null ? '' : ', desktop_session_id';
  const desktopSessionValue = desktopSessionId === null ? '' : ', ?';
  const fingerprintBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    JSON.stringify(['platform-key-create', 2, name, expiresAt, allowedModels, groupId]),
  )));
  const fingerprint = Array.from(fingerprintBytes, byte => byte.toString(16).padStart(2, '0')).join('');
  const token = generateToken('apiKey');
  const keyHash = await hashToken('apiKey', token);
  const displayPrefix = getTokenDisplayPrefix('apiKey', token);
  const id = crypto.randomUUID();
  const statement = prepare<PlatformKeyCreationInsertRow>(database, `
    INSERT INTO api_keys
      (id, user_id, key_hash, display_prefix, name, status, expires_at,
       allowed_models_json, created_at, updated_at, version, creation_operation_id, creation_fingerprint, group_id, kind${desktopSessionColumn})
    SELECT ?, u.id, ?, ?, ?, 'active', ?, ?, ?, ?, 1, ?, ?, g.id, 'api'${desktopSessionValue}
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
      AND (${insertGuard})
    ON CONFLICT(user_id, creation_operation_id) WHERE creation_operation_id IS NOT NULL DO NOTHING
    RETURNING id,group_id,(SELECT name FROM groups WHERE groups.id=api_keys.group_id) AS group_name`, [id, keyHash, displayPrefix, name, expiresAt, allowedJson,
    now, now, operationId, fingerprint, ...(desktopSessionId === null ? [] : [desktopSessionId]), groupId, trustedOwnerId, now, now, expiresAt, expiresAt, now, allowedJson, ...guardValues]);

  return {
    statement,
    candidate: { id, userId: trustedOwnerId, token, name, displayPrefix, allowedModels, expiresAt, createdAt: now, desktopSessionId },
    operationId,
    fingerprint,
  };
}
