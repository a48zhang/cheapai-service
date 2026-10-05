import type { InternalPlatformKeyAuth } from '../auth/key-repository';
import { prepare } from '../db';
import { ApiError } from '../http';
import { parseUnits } from './money';

export interface BalanceAdmission {
  readonly userId: string;
  readonly keyId: string;
  readonly groupId: string;
  readonly publicModelId: string;
  readonly balanceUnits: string;
  readonly admissionMinBalanceUnits: string;
  readonly priceVersion: number;
  readonly userVersion: number;
  readonly keyVersion: number;
  readonly groupVersion: number;
  /** The exact group multiplier observed with the authoritative group row. */
  readonly billingMultiplier: string;
  readonly source: 'd1';
  /** G03 still checks selected channel/versions and registers before sending. */
  readonly requiresAuthoritativeRegistration: true;
}

export interface BalanceAdmissionOptions {
  /** Entry point is supplied by trusted server code, never the HTTP body. */
  readonly source?: 'api' | 'web_chat';
  /** The selected group for this request. It must match subject.group.id. */
  readonly groupId?: string;
}

interface AdmissionRow {
  key_user_id: string; key_status: string; key_created_at: number; expires_at: number | null;
  allowed_models_json: string | null; key_version: number; user_status: string; user_version: number;
  group_id: string; group_status: string; group_version: number; balance_units: string;
  model_status: string | null; admission_min_balance_units: string | null; price_version: number | null;
}
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 128 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const multiplier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value);
const missingMultiplierColumn = (error: unknown): boolean => error instanceof Error
  && /(?:no such column|has no column named)[^\n]*billing_multiplier/i.test(error.message);

/**
 * Accept only the trusted A27 result from internal code, never a body-supplied
 * subject. Re-read current D1 identity/model/balance instead of treating the A27
 * projection or C15 BalanceRead as authorization. C15 explicitly requires this
 * authoritative step; no KV call is needed once D1 supplies the balance here.
 * This read neither reserves funds nor replaces G03's final request registration.
 * Channel/group routing permissions remain C16/G03 responsibilities.
 */
export async function checkBalanceAdmission(database: D1Database, subject: InternalPlatformKeyAuth, publicModelId: string, now: number,
  options: BalanceAdmissionOptions = {}): Promise<BalanceAdmission> {
  if (!Number.isSafeInteger(now) || now < 0 || !identifier(publicModelId)) throw new ApiError('invalid_request');
  if (!subject || !identifier(subject.user?.id) || !identifier(subject.key?.id) || !identifier(subject.group?.id)
    || subject.key.userId !== subject.user.id) throw new ApiError('unauthorized');
  const userId = subject.user.id;
  const keyId = subject.key.id;
  const groupId = options.groupId ?? subject.group.id;
  if (!identifier(groupId) || groupId !== subject.group.id) throw new ApiError('forbidden');
  const keyProjection = subject.key as unknown as { groupId?: unknown; kind?: unknown };
  const boundGroup = keyProjection.groupId;
  const source = options.source ?? (keyProjection.kind === 'web_chat' || boundGroup === null ? 'web_chat' : 'api');
  if (source !== 'api' && source !== 'web_chat') throw new ApiError('invalid_request');
  // Ordinary API identities are fixed to their Key's group. A web-chat
  // identity deliberately has no group and receives the selected group only
  // for this request. An explicit kind, when provided by the Key module, is
  // checked as well so a trusted caller cannot relabel the identity.
  if (source === 'api' && (boundGroup !== groupId || keyProjection.kind === 'web_chat')) throw new ApiError('unauthorized');
  if (source === 'web_chat' && (boundGroup !== null || keyProjection.kind === 'api')) throw new ApiError('unauthorized');
  let row: AdmissionRow | null;
  try {
    row = await prepare<AdmissionRow>(database, `SELECT k.user_id AS key_user_id,k.status AS key_status,k.created_at AS key_created_at,
      k.expires_at,k.allowed_models_json,k.version AS key_version,u.status AS user_status,u.version AS user_version,
      g.id AS group_id,g.status AS group_status,g.version AS group_version,CAST(u.balance_units AS TEXT) AS balance_units,
      m.status AS model_status,CAST(m.admission_min_balance_units AS TEXT) AS admission_min_balance_units,m.price_version
      FROM api_keys k JOIN users u ON u.id=k.user_id JOIN groups g ON g.id=?
      JOIN user_group_access access ON access.user_id=u.id AND access.group_id=g.id
      JOIN groups owner_group ON owner_group.id=u.group_id AND owner_group.status='active'
      LEFT JOIN models m ON m.public_model_id=? WHERE k.id=? AND u.id=? AND g.id=?
        AND ((?='api' AND k.kind='api' AND k.group_id=?) OR (?='web_chat' AND k.kind='web_chat' AND k.group_id IS NULL))`,
      [groupId, publicModelId, keyId, userId, groupId, source, groupId, source]).first();
  } catch (error) { throw new ApiError('service_unavailable', { cause: error }); }
  if (!row || row.key_user_id !== userId || row.group_id !== groupId || row.key_status !== 'active'
    || row.user_status !== 'active' || row.group_status !== 'active' || row.key_created_at > now
    || (row.expires_at !== null && row.expires_at <= now)) throw new ApiError('unauthorized');
  if (row.model_status !== 'active') throw new ApiError('forbidden');
  let models: unknown = null;
  try {
    if (row.allowed_models_json !== null) {
      models = JSON.parse(row.allowed_models_json);
      if (!Array.isArray(models) || !models.every(identifier)) throw new Error();
    }
  } catch (error) { throw new ApiError('service_unavailable', { cause: error }); }
  if (Array.isArray(models) && !models.includes(publicModelId)) throw new ApiError('forbidden');
  let balance: bigint;
  let minimum: bigint;
  try {
    balance = parseUnits(row.balance_units);
    minimum = parseUnits(row.admission_min_balance_units);
    if (minimum < 0n || ![row.price_version, row.user_version, row.key_version, row.group_version].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1)) throw new Error();
  } catch (error) { throw new ApiError('service_unavailable', { cause: error }); }
  if (balance <= 0n || balance < minimum) throw new ApiError('insufficient_balance');
  let billingMultiplier = '1';
  try {
    const value = await prepare<{ billing_multiplier: unknown }>(database,
      'SELECT billing_multiplier FROM groups WHERE id=?', [groupId]).first();
    if (value === null || !multiplier(value.billing_multiplier)) throw new Error('invalid billing multiplier');
    billingMultiplier = value.billing_multiplier;
  } catch (error) {
    // The fallback is only for pre-0020 local schemas. Once the multiplier
    // column exists, malformed or unavailable data fails closed; it is never
    // interpreted as a free group.
    if (!missingMultiplierColumn(error)) throw new ApiError('service_unavailable', { cause: error });
  }
  return Object.freeze({ userId, keyId, groupId, publicModelId, balanceUnits: balance.toString(), admissionMinBalanceUnits: minimum.toString(),
    priceVersion: row.price_version as number, userVersion: row.user_version, keyVersion: row.key_version, groupVersion: row.group_version,
    billingMultiplier, source: 'd1', requiresAuthoritativeRegistration: true });
}
