import type { Protocol } from '@sub2api/apicompat/types/shared';
import { batch, prepare } from '../db';
import type { DbStatement } from '../db';
import { ApiError } from '../http';
import { readPriceSnapshot } from '../billing/fingerprint';

export type ExecutionStatus = 'admitted' | 'succeeded' | 'failed' | 'cancelled' | 'abandoned';
export type RequestSource = 'api' | 'web_chat';
export interface RequestRecord {
  id: string; user_id: string; api_key_id: string; channel_id: string; public_model_id: string;
  upstream_model: string; downstream_protocol: Protocol; upstream_protocol: Protocol; price_snapshot: string;
  execution_status: ExecutionStatus; billing_status: string; created_at: number; started_at: number | null; finished_at: number | null;
  /** Optional keeps old in-memory fixtures readable; 0023 returns both fields. */
  group_id?: string | null; source?: RequestSource;
}
export interface RequestRegistrationInput {
  userId: string; keyId: string; groupId: string; channelId: string; downstreamProtocol: Protocol;
  /** Server-selected entry point; never copied from a client request body. */
  source?: RequestSource;
  priceSnapshotJson: string;
  versions: { user: number; key: number; group: number; channel: number; mapping: number };
  now: number;
}
export interface PreparedRequestRegistration {
  readonly requestId: string;
  readonly statements: readonly [DbStatement<RequestRecord>, DbStatement];
  /** Rebind time after waiting for leases, retaining UUID and selected facts. */
  refreshTime(now: number): PreparedRequestRegistration;
}
const projection = 'id,user_id,api_key_id,channel_id,public_model_id,upstream_model,downstream_protocol,upstream_protocol,price_snapshot,execution_status,billing_status,created_at,started_at,finished_at,group_id,source';
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) throw new ApiError('invalid_request');
  return value;
}
function time(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new ApiError('invalid_request');
  return value;
}
function source(value: unknown): RequestSource {
  if (value !== 'api' && value !== 'web_chat') throw new ApiError('invalid_request');
  return value;
}

/** Generates an INTERNAL UUID before leases are acquired. Execute both returned
 * statements in one batch, optionally alongside other admission statements.
 * Zero matching rows becomes a SQL failure so every same-batch write rolls back.
 * No request body, Authorization, raw Key or arbitrary error text is accepted.
 */
export function prepareRequestRegistration(database: D1Database, input: RequestRegistrationInput): PreparedRequestRegistration {
  return buildRegistration(database, input, crypto.randomUUID());
}

function buildRegistration(database: D1Database, input: RequestRegistrationInput, requestId: string): PreparedRequestRegistration {
  const userId = id(input.userId); const keyId = id(input.keyId); const groupId = id(input.groupId); const channelId = id(input.channelId);
  const requestSource = source(input.source ?? 'api');
  const now = time(input.now);
  if (!['chat', 'responses', 'messages'].includes(input.downstreamProtocol)) throw new ApiError('invalid_request');
  const versions = input.versions;
  if (!versions || ![versions.user, versions.key, versions.group, versions.channel, versions.mapping].every(value => Number.isSafeInteger(value) && value >= 1)) throw new ApiError('invalid_request');
  let price: ReturnType<typeof readPriceSnapshot>;
  try { price = readPriceSnapshot(input.priceSnapshotJson); } catch { throw new ApiError('invalid_request'); }
  const facts = price.snapshot;
  const statement = prepare<RequestRecord>(database, `INSERT INTO requests
    (id,user_id,api_key_id,channel_id,public_model_id,upstream_model,downstream_protocol,upstream_protocol,price_snapshot,group_id,source,created_at,updated_at)
    SELECT ?,u.id,k.id,c.id,m.public_model_id,cm.upstream_model,?,cm.protocol,?,?,?, ?,?
    FROM api_keys k JOIN users u ON u.id=k.user_id JOIN groups g ON g.id=?
    JOIN user_group_access access ON access.user_id=u.id AND access.group_id=g.id
    JOIN groups owner_group ON owner_group.id=u.group_id AND owner_group.status='active'
    JOIN channel_groups cg ON cg.group_id=g.id JOIN channels c ON c.id=cg.channel_id
    JOIN channel_models cm ON cm.channel_id=c.id JOIN models m ON m.public_model_id=cm.public_model_id
    WHERE k.id=? AND u.id=? AND g.id=? AND c.id=? AND m.public_model_id=? AND cm.protocol=? AND cm.upstream_model=?
      AND ((?='api' AND k.kind='api' AND k.group_id=g.id) OR (?='web_chat' AND k.kind='web_chat' AND k.group_id IS NULL))
      AND k.status='active' AND u.status='active' AND g.status='active' AND c.status='active' AND m.status='active'
      AND k.created_at<=? AND (k.expires_at IS NULL OR k.expires_at>?)
      AND (k.allowed_models_json IS NULL OR EXISTS(SELECT 1 FROM json_each(k.allowed_models_json) WHERE value=m.public_model_id))
      AND u.balance_units>0 AND u.balance_units>=m.admission_min_balance_units
      AND (
        (? IS NULL AND ? IS NULL AND ? IS NULL AND ?='api' AND g.billing_multiplier='1')
        OR (?=g.id AND ?=g.version AND COALESCE(?, '1')=g.billing_multiplier)
      )
      AND u.version=? AND k.version=? AND g.version=? AND c.config_version=? AND cm.config_version=? AND m.price_version=?
      AND (SELECT count(*) FROM json_each(m.sell_prices_json))=(SELECT count(*) FROM json_each(?))
      AND NOT EXISTS(SELECT 1 FROM json_each(?) p WHERE json_extract(m.sell_prices_json,'$.'||p.key) IS NOT p.value)
    RETURNING ${projection}`,
  [requestId, input.downstreamProtocol, price.json, groupId, requestSource, now, now, groupId, keyId, userId, groupId, channelId,
    facts.public_model_id, facts.upstream_protocol, facts.upstream_model,
    requestSource, requestSource, now, now,
    facts.group_id ?? null, facts.group_version ?? null, facts.billing_multiplier ?? null, requestSource,
    facts.group_id ?? null, facts.group_version ?? null, facts.billing_multiplier ?? null,
    versions.user, versions.key, versions.group, versions.channel, versions.mapping, facts.price_version,
    JSON.stringify(facts.sell_prices), JSON.stringify(facts.sell_prices)]);
  const guard = prepare(database, "SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('{}','request_registration_conflict') END");
  const selected: RequestRegistrationInput = { userId, keyId, groupId, channelId, source: requestSource, downstreamProtocol: input.downstreamProtocol,
    priceSnapshotJson: price.json, versions: { ...versions }, now };
  return { requestId, statements: [statement, guard], refreshTime: nextNow => buildRegistration(database, { ...selected, now: nextNow }, requestId) };
}

/** Convenience commit; G03 may instead include statements in its own batch. */
export async function commitRequestRegistration(database: D1Database, registration: PreparedRequestRegistration): Promise<RequestRecord> {
  try {
    const result = await batch(database, registration.statements);
    const row = result[0].rows[0];
    if (!row) throw new ApiError('conflict');
    return row;
  } catch (error) {
    for (let cause = error, depth = 0; cause instanceof Error && depth < 4; cause = cause.cause, depth++) {
      if (cause.message.includes('request_registration_conflict') || cause.message.includes('UNIQUE constraint failed: requests.id')) throw new ApiError('conflict');
    }
    if (error instanceof ApiError) throw error;
    throw new ApiError('service_unavailable', { cause: error });
  }
}

/** Reads are always user-scoped; this is internal metadata, not an HTTP payload. */
export async function getRequest(database: D1Database, requestId: string, userId: string): Promise<RequestRecord | null> {
  return prepare<RequestRecord>(database, `SELECT ${projection} FROM requests WHERE id=? AND user_id=?`, [id(requestId), id(userId)]).first();
}

export async function markRequestStarted(database: D1Database, requestId: string, userId: string, now: number): Promise<boolean> {
  const result = await prepare(database, `UPDATE requests SET started_at=?,updated_at=max(updated_at,?)
    WHERE id=? AND user_id=? AND execution_status='admitted' AND started_at IS NULL AND created_at<=?`,
  [time(now), now, id(requestId), id(userId), now]).run();
  return result.changes === 1;
}

const errors = { upstream_error: 'Upstream request failed.', client_cancelled: 'Client cancelled the request.',
  request_timeout: 'Request timed out.', internal_error: 'Request processing failed.' } as const;
export interface FinishRequestInput {
  status: Exclude<ExecutionStatus, 'admitted'>;
  upstreamRequestId?: string;
  responseId?: string;
  errorCode?: keyof typeof errors;
}
function upstreamId(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new ApiError('invalid_request');
  return value;
}

/** One-way admitted -> terminal CAS. Late start/finish events cannot overwrite
 * terminal results. Billing/usage stay untouched: missing usage is never zero.
 */
export async function finishRequest(database: D1Database, requestId: string, userId: string, finish: FinishRequestInput, now: number): Promise<boolean> {
  if (!['succeeded', 'failed', 'cancelled', 'abandoned'].includes(finish.status) ||
      (finish.errorCode !== undefined && !Object.hasOwn(errors, finish.errorCode))) throw new ApiError('invalid_request');
  const result = await prepare(database, `UPDATE requests SET execution_status=?,finished_at=?,updated_at=max(updated_at,?),
    upstream_request_id=?,response_id=?,error_code=?,error_message=?
    WHERE id=? AND user_id=? AND execution_status='admitted' AND finished_at IS NULL AND created_at<=? AND (started_at IS NULL OR started_at<=?)`,
  [finish.status, time(now), now, upstreamId(finish.upstreamRequestId), upstreamId(finish.responseId), finish.errorCode ?? null,
    finish.errorCode === undefined ? null : errors[finish.errorCode], id(requestId), id(userId), now, now]).run();
  return result.changes === 1;
}
