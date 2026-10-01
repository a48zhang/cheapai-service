import { batch, prepare } from '../db';
import { ApiError } from '../http';
import { buildAuditStatement } from '../admin/audit';
import { buildSettlementFingerprint } from './fingerprint';
import { parseUnits, unitsToSafeNumber } from './money';

export interface BalanceAdjustmentInput {
  readonly kind: 'adjustment' | 'grant';
  readonly operationId: string;
  readonly userId: string;
  readonly deltaUnits: string | bigint;
  readonly reason: string;
  readonly requestId?: string | null;
}
export interface BalanceAdjustmentEntry {
  readonly id: string;
  readonly operationId: string;
  readonly kind: 'adjustment' | 'grant';
  readonly userId: string;
  readonly requestId: string | null;
  readonly deltaUnits: string;
  readonly currency: 'USD';
  readonly fingerprint: string;
  readonly createdBy: string;
  readonly reason: string;
  readonly createdAt: number;
}
export interface BalanceAdjustmentResult { readonly entry: BalanceAdjustmentEntry; readonly outcome: 'inserted' | 'existing' }
interface PreparedAdjustment {
  kind: 'adjustment' | 'grant'; operationId: string; userId: string; requestId: string | null;
  deltaUnits: string; reason: string; actorId: string; fingerprint: string;
}
interface EntryRow {
  id: string; operation_id: string; kind: string; user_id: string; request_id: string | null; currency: string;
  delta_units: number; fingerprint: string; created_by: string | null; reason: string | null; created_at: number;
  usage_snapshot: string | null; price_snapshot: string | null;
}
const projection = 'id,operation_id,kind,user_id,request_id,currency,delta_units,fingerprint,created_by,reason,created_at,usage_snapshot,price_snapshot';
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length <= 128
  && /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value) && !/(?:s2a_(?:key|session|invite)_|sk-|bearer|-----BEGIN)/i.test(value);

async function prepareAdjustment(value: BalanceAdjustmentInput, trustedAdminId: string): Promise<PreparedAdjustment> {
  try {
    if (!identifier(trustedAdminId) || !value || typeof value !== 'object' || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error();
    const input: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !['kind', 'operationId', 'userId', 'deltaUnits', 'reason', 'requestId'].includes(key)) throw new Error();
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field || !('value' in field) || !field.enumerable || field.value === undefined) throw new Error();
      input[key] = field.value;
    }
    if ((input.kind !== 'adjustment' && input.kind !== 'grant') || !identifier(input.operationId) || !identifier(input.userId)
      || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 4096) throw new Error();
    const requestId = Object.hasOwn(input, 'requestId') ? input.requestId : null;
    if (requestId !== null && !identifier(requestId)) throw new Error();
    const units = parseUnits(typeof input.deltaUnits === 'bigint' ? input.deltaUnits.toString() : input.deltaUnits);
    const fingerprint = await buildSettlementFingerprint({ kind: input.kind, operationId: input.operationId, userId: input.userId,
      requestId, deltaUnits: units, priceSnapshotJson: null, usage: null, createdBy: trustedAdminId, reason: input.reason });
    return { kind: input.kind, operationId: input.operationId, userId: input.userId, requestId, deltaUnits: fingerprint.deltaUnits,
      reason: input.reason, actorId: trustedAdminId, fingerprint: fingerprint.fingerprint };
  } catch { throw new ApiError('invalid_request'); }
}

async function requireCurrentAdmin(database: D1Database, actorId: string): Promise<void> {
  let actor: { id: string } | null;
  try { actor = await prepare<{ id: string }>(database, "SELECT id FROM users WHERE id=? AND role='admin' AND status='active'", [actorId]).first(); }
  catch { throw new ApiError('service_unavailable'); }
  if (!actor) throw new ApiError('forbidden');
}

function match(row: EntryRow, expected: PreparedAdjustment): BalanceAdjustmentEntry {
  if (row.operation_id !== expected.operationId || row.kind !== expected.kind || row.user_id !== expected.userId
    || row.request_id !== expected.requestId || row.currency !== 'USD' || !Number.isSafeInteger(row.delta_units)
    || String(row.delta_units) !== expected.deltaUnits || row.fingerprint !== expected.fingerprint
    || row.created_by !== expected.actorId || row.reason !== expected.reason || row.usage_snapshot !== null || row.price_snapshot !== null) throw new ApiError('conflict');
  if (!row.id || !Number.isSafeInteger(row.created_at) || row.created_at < 0) throw new ApiError('service_unavailable');
  return Object.freeze({ id: row.id, operationId: expected.operationId, kind: expected.kind, userId: expected.userId,
    requestId: expected.requestId, deltaUnits: expected.deltaUnits, currency: 'USD', fingerprint: expected.fingerprint,
    createdBy: expected.actorId, reason: expected.reason, createdAt: row.created_at });
}

async function lookup(database: D1Database, expected: PreparedAdjustment): Promise<BalanceAdjustmentEntry | null> {
  try {
    const row = await prepare<EntryRow>(database, `SELECT ${projection} FROM billing_entries WHERE operation_id=?`, [expected.operationId]).first();
    return row ? match(row, expected) : null;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('service_unavailable');
  }
}

/** Read-only resolution of unknown commit outcomes. Actor comes from trusted admin auth. */
export async function findBalanceAdjustment(database: D1Database, input: BalanceAdjustmentInput, trustedAdminId: string): Promise<BalanceAdjustmentEntry | null> {
  const expected = await prepareAdjustment(input, trustedAdminId);
  await requireCurrentAdmin(database, expected.actorId);
  return lookup(database, expected);
}

/**
 * Append a signed adjustment or positive grant; zero adjustments are explicit
 * audited no-ops. No prior ledger/request row is changed or deleted. D13 alone
 * applies the balance delta, including a negative resulting balance. One insert
 * attempt only; service_unavailable may mean committed and must be reconciled
 * using the same operation/facts. No cache arithmetic or new retry identity.
 */
export async function adjustBalance(database: D1Database, input: BalanceAdjustmentInput, trustedAdminId: string, now: number): Promise<BalanceAdjustmentResult> {
  if (!Number.isSafeInteger(now) || now < 0) throw new ApiError('invalid_request');
  const expected = await prepareAdjustment(input, trustedAdminId);
  await requireCurrentAdmin(database, expected.actorId);
  const existing = await lookup(database, expected);
  if (existing) return { entry: existing, outcome: 'existing' };
  const delta = unitsToSafeNumber(parseUnits(expected.deltaUnits));
  try {
    const result = await batch(database, [
      prepare<EntryRow>(database, `INSERT INTO billing_entries
        (id,operation_id,kind,user_id,request_id,currency,delta_units,fingerprint,usage_snapshot,price_snapshot,created_by,reason,created_at)
        SELECT ?,?,?,owner.id,?,'USD',?,?,NULL,NULL,actor.id,?,?
        FROM users owner JOIN users actor ON actor.id=? AND actor.role='admin' AND actor.status='active'
        WHERE owner.id=? AND (? IS NULL OR EXISTS(SELECT 1 FROM requests r WHERE r.id=? AND r.user_id=owner.id))
        RETURNING ${projection}`,
      [crypto.randomUUID(), expected.operationId, expected.kind, expected.requestId, delta, expected.fingerprint,
        expected.reason, now, expected.actorId, expected.userId, expected.requestId, expected.requestId]),
      prepare(database, "SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('{}','balance_adjustment_rejected') END AS matched"),
      buildAuditStatement(database, { actor_id: expected.actorId, operation_id: expected.operationId, created_at: now,
        action: expected.kind === 'grant' ? 'balance.grant' : 'balance.adjustment', target_type: 'user', target_id: expected.userId,
        changes: { delta_units: delta } }),
    ] as const);
    const row = result[0].rows[0];
    if (!row) throw new ApiError('service_unavailable');
    return { entry: match(row, expected), outcome: 'inserted' };
  } catch (error) {
    const committed = await lookup(database, expected);
    if (committed) return { entry: committed, outcome: 'existing' };
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.message.includes('balance_adjustment_rejected')) throw new ApiError('conflict');
    throw new ApiError('service_unavailable');
  }
}
