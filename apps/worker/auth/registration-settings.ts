import { buildAuditStatement } from '../admin/audit';
import { ConfigError, parseRuntimeConfig } from '../config';
import type { RuntimeConfig } from '../config';
import { batch, prepare } from '../db';
import { ApiError } from '../http';

export type RegistrationSettings = Pick<RuntimeConfig, 'registrationMode' | 'emailVerificationEnabled'>;
export interface RegistrationSettingsSnapshot extends RegistrationSettings {
  version: number | null;
  updatedAt: number | null;
  valid: boolean;
}
type Readiness = { emailAvailable?: boolean };
interface SettingsRow { value_json: string; version: number; updated_at: number }
const closed: RegistrationSettings = { registrationMode: 'closed', emailVerificationEnabled: true };
function fields(input: unknown, complete: boolean): Partial<RegistrationSettings> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('invalid_request');
  const value = input as Partial<RegistrationSettings>;
  const output: Partial<RegistrationSettings> = {};
  if (value.registrationMode !== undefined) output.registrationMode = value.registrationMode;
  if (value.emailVerificationEnabled !== undefined) output.emailVerificationEnabled = value.emailVerificationEnabled;
  if (!Object.keys(output).length || (complete && (output.registrationMode === undefined || output.emailVerificationEnabled === undefined))) {
    throw new ApiError('invalid_request');
  }
  return output;
}
function validated(input: unknown, readiness: Readiness): RegistrationSettings {
  const config = parseRuntimeConfig(fields(input, true), readiness);
  return { registrationMode: config.registrationMode, emailVerificationEnabled: config.emailVerificationEnabled };
}
function stored(row: SettingsRow, readiness: Readiness): RegistrationSettings {
  if (typeof row.value_json !== 'string' || row.value_json.length > 2048) throw new ApiError('invalid_request');
  return validated(JSON.parse(row.value_json), readiness);
}
function safeVersion(value: number): boolean { return Number.isSafeInteger(value) && value >= 1; }
function fetchRow(database: D1Database) {
  return prepare<SettingsRow>(database, 'SELECT value_json,version,updated_at FROM settings WHERE key=?', ['registration']).first();
}

/** Missing/corrupt/unready settings expose closed registration, never open defaults. */
export async function readRegistrationSettings(database: D1Database, readiness: Readiness = {}): Promise<RegistrationSettingsSnapshot> {
  const row = await fetchRow(database);
  const metadata = { version: row && safeVersion(row.version) ? row.version : null,
    updatedAt: row && Number.isSafeInteger(row.updated_at) && row.updated_at >= 0 ? row.updated_at : null };
  if (!row || metadata.version === null || metadata.updatedAt === null) return { ...closed, ...metadata, valid: false };
  try { return { ...stored(row, readiness), ...metadata, valid: true }; }
  catch { return { ...closed, ...metadata, valid: false }; }
}

/** Returns only an existing active default group; A18 must recheck it in INSERT. */
export async function readDefaultGroupId(database: D1Database): Promise<string | null> {
  const row = await prepare<{ value_json: string }>(database, 'SELECT value_json FROM settings WHERE key=?', ['default_group_id']).first();
  if (!row || typeof row.value_json !== 'string' || row.value_json.length > 1024) return null;
  let id: unknown;
  try { id = JSON.parse(row.value_json); } catch { return null; }
  if (typeof id !== 'string' || id.length === 0 || id.trim() !== id || /[\u0000-\u001f\u007f]/.test(id)) return null;
  const group = await prepare<{ id: string }>(database, 'SELECT id FROM groups WHERE id=? AND status=?', [id, 'active']).first();
  return group?.id ?? null;
}

export interface RegistrationSettingsUpdate {
  patch: Partial<RegistrationSettings>;
  expectedVersion: number;
  /** Trusted authenticated administrator; endpoint authorization is required. */
  actorId: string;
  operationId: string;
  now: number;
}

function isConflictGuard(error: unknown): boolean {
  // Only the explicit SQL assertion below can overflow: version is bounded first,
  // and the update/audit inserts contain no other overflowing arithmetic.
  for (let depth = 0; depth < 4 && error instanceof Error; depth++, error = error.cause) {
    if (error.message.includes('integer overflow')) return true;
  }
  return false;
}

/** Version update + SQL assertion + O01 audit form one native atomic D1 batch. */
export async function updateRegistrationSettings(
  database: D1Database, input: RegistrationSettingsUpdate, readiness: Readiness = {},
): Promise<RegistrationSettingsSnapshot> {
  if (!safeVersion(input.expectedVersion) || input.expectedVersion >= Number.MAX_SAFE_INTEGER
    || !Number.isSafeInteger(input.now) || input.now < 0) throw new ApiError('invalid_request');
  let patch: Partial<RegistrationSettings>;
  try { patch = fields(input.patch, false); }
  catch { throw new ApiError('invalid_request'); }
  const row = await fetchRow(database);
  if (!row || row.version !== input.expectedVersion) throw new ApiError('conflict');
  let before = closed;
  // Parse stored policy independent of transient readiness. Validate the new policy
  // with the real readiness below so partial updates preserve the other field.
  try { before = stored(row, { emailAvailable: true }); } catch { /* repair from safe closed policy */ }
  let after: RegistrationSettings;
  try { after = validated({ ...before, ...patch }, readiness); }
  catch (error) {
    if (error instanceof ConfigError || error instanceof ApiError) throw new ApiError('invalid_request');
    throw error;
  }
  const audit = buildAuditStatement(database, {
    actor_id: input.actorId, action: 'registration.settings.update', target_type: 'settings', target_id: 'registration',
    operation_id: input.operationId, created_at: input.now,
    changes: {
      before: { registration_mode: before.registrationMode, email_verification_enabled: before.emailVerificationEnabled },
      after: { registration_mode: after.registrationMode, email_verification_enabled: after.emailVerificationEnabled },
    },
  });
  try {
    await batch(database, [
      prepare(database, 'UPDATE settings SET value_json=?,version=version+1,updated_at=? WHERE key=? AND version=?',
        [JSON.stringify(after), input.now, 'registration', input.expectedVersion]),
      // RAISE is unavailable outside triggers. SQLite integer overflow is a hard
      // SQL error, unlike division by zero; it rolls back a zero-row update before
      // audit insertion. This also catches an unexpected BEFORE UPDATE IGNORE.
      prepare(database, 'SELECT CASE WHEN changes() = 1 THEN 1 ELSE abs(-9223372036854775808) END AS version_guard'),
      audit,
    ]);
  } catch (error) {
    if (isConflictGuard(error)) throw new ApiError('conflict');
    throw error;
  }
  return { ...after, version: input.expectedVersion + 1, updatedAt: input.now, valid: true };
}
