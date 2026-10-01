import type { UsageSnapshot, Protocol } from '@sub2api/apicompat/types/shared';
import { batch, prepare } from '../db';
import { ApiError } from '../http';
import { buildSettlementFingerprint, readPriceSnapshot } from './fingerprint';
import { MONEY_CURRENCY, parseUnits, unitsToSafeNumber } from './money';

export interface ConsumptionSettlementInput {
  readonly operationId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly priceSnapshotJson: string;
  readonly usage: UsageSnapshot;
  /** Positive charge magnitude calculated by B02; never a floating-point number. */
  readonly costUnits: string | bigint;
}
export interface PreparedConsumptionSettlement {
  readonly operationId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly publicModelId: string;
  readonly upstreamModel: string;
  readonly upstreamProtocol: Protocol;
  readonly costUnits: string;
  readonly deltaUnits: string;
  readonly fingerprint: string;
  readonly priceSnapshotJson: string;
  readonly usageSnapshotJson: string;
}
export interface ConsumptionEntry {
  readonly id: string;
  readonly operationId: string;
  readonly kind: 'consumption';
  readonly userId: string;
  readonly requestId: string;
  readonly currency: typeof MONEY_CURRENCY;
  readonly deltaUnits: string;
  readonly costUnits: string;
  readonly fingerprint: string;
  readonly usageSnapshotJson: string;
  readonly priceSnapshotJson: string;
  readonly createdAt: number;
}
export interface ConsumptionSettlementResult {
  readonly entry: ConsumptionEntry;
  /** existing includes a write whose acknowledgement was lost but then recovered. */
  readonly outcome: 'inserted' | 'existing';
}

interface LedgerRow {
  id: string; operation_id: string; kind: string; user_id: string; request_id: string | null;
  currency: string; delta_units: number; fingerprint: string; usage_snapshot: string | null;
  price_snapshot: string | null; created_by: string | null; reason: string | null; created_at: number;
}
const projection = 'id,operation_id,kind,user_id,request_id,currency,delta_units,fingerprint,usage_snapshot,price_snapshot,created_by,reason,created_at';

/** Pure preparation is available to B13/B14 for stable pending/retry evidence. */
export async function prepareConsumptionSettlement(value: ConsumptionSettlementInput): Promise<PreparedConsumptionSettlement> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error();
    const allowed = ['operationId', 'userId', 'requestId', 'priceSnapshotJson', 'usage', 'costUnits'];
    const copied: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !allowed.includes(key)) throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || descriptor.value === undefined) throw new Error();
      copied[key] = descriptor.value;
    }
    if (allowed.some(key => !Object.hasOwn(copied, key))) throw new Error();
    const input = copied as unknown as ConsumptionSettlementInput;
    const cost = parseUnits(typeof input.costUnits === 'bigint' ? input.costUnits.toString() : input.costUnits);
    if (cost < 0n) throw new Error();
    const price = readPriceSnapshot(input.priceSnapshotJson);
    const prepared = await buildSettlementFingerprint({ kind: 'consumption', operationId: input.operationId,
      userId: input.userId, requestId: input.requestId, priceSnapshotJson: price.json, usage: input.usage,
      deltaUnits: -cost, createdBy: null, reason: null });
    if (prepared.priceSnapshotJson === null || prepared.usageSnapshotJson === null) throw new Error();
    return Object.freeze({ operationId: input.operationId, userId: input.userId, requestId: input.requestId,
      publicModelId: price.snapshot.public_model_id, upstreamModel: price.snapshot.upstream_model,
      upstreamProtocol: price.snapshot.upstream_protocol, costUnits: cost.toString(), deltaUnits: prepared.deltaUnits,
      fingerprint: prepared.fingerprint, priceSnapshotJson: prepared.priceSnapshotJson, usageSnapshotJson: prepared.usageSnapshotJson });
  } catch { throw new ApiError('invalid_request'); }
}

function matchingEntry(row: LedgerRow, expected: PreparedConsumptionSettlement): ConsumptionEntry {
  if (row.kind !== 'consumption' || row.operation_id !== expected.operationId || row.user_id !== expected.userId
    || row.request_id !== expected.requestId || row.currency !== MONEY_CURRENCY || row.fingerprint !== expected.fingerprint
    || row.price_snapshot !== expected.priceSnapshotJson || row.usage_snapshot !== expected.usageSnapshotJson
    || !Number.isSafeInteger(row.delta_units) || String(row.delta_units) !== expected.deltaUnits
    || row.created_by !== null || row.reason !== null) throw new ApiError('conflict');
  if (typeof row.id !== 'string' || !row.id || !Number.isSafeInteger(row.created_at) || row.created_at < 0) throw new ApiError('service_unavailable');
  return Object.freeze({ id: row.id, operationId: row.operation_id, kind: 'consumption', userId: row.user_id,
    requestId: expected.requestId, currency: MONEY_CURRENCY, deltaUnits: expected.deltaUnits, costUnits: expected.costUnits,
    fingerprint: row.fingerprint, priceSnapshotJson: expected.priceSnapshotJson, usageSnapshotJson: expected.usageSnapshotJson,
    createdAt: row.created_at });
}

async function lookup(database: D1Database, expected: PreparedConsumptionSettlement): Promise<ConsumptionEntry | null> {
  try {
    // Both independent uniqueness constraints matter. An operation belonging to
    // another user/kind, or another operation for this request, is a conflict.
    const result = await prepare<LedgerRow>(database, `SELECT ${projection} FROM billing_entries
      WHERE operation_id=? OR (kind='consumption' AND request_id=?) LIMIT 2`, [expected.operationId, expected.requestId]).all();
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1 || !result.rows[0]) throw new ApiError('conflict');
    return matchingEntry(result.rows[0], expected);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('service_unavailable');
  }
}

/** Read-only reconciliation after an uncertain submission; never initiates a debit. */
export async function findConsumptionSettlement(database: D1Database, input: ConsumptionSettlementInput): Promise<ConsumptionEntry | null> {
  return lookup(database, await prepareConsumptionSettlement(input));
}

/**
 * One write attempt only. D13 atomically changes ledger/balance/request; this
 * repository never updates balances or overwrites entries. It does not require
 * positive balance, active credentials or today's model prices for incurred use.
 * A service_unavailable outcome MAY have committed: B13 must retain the same
 * operation/facts, reconcile or retry them, never generate a new debit identity.
 */
export async function settleConsumption(database: D1Database, input: ConsumptionSettlementInput, now: number): Promise<ConsumptionSettlementResult> {
  if (!Number.isSafeInteger(now) || now < 0) throw new ApiError('invalid_request');
  const expected = await prepareConsumptionSettlement(input);
  const existing = await lookup(database, expected);
  if (existing) return { entry: existing, outcome: 'existing' };
  const delta = unitsToSafeNumber(parseUnits(expected.deltaUnits));
  try {
    const result = await batch(database, [
      prepare<LedgerRow>(database, `INSERT INTO billing_entries
        (id,operation_id,kind,user_id,request_id,currency,delta_units,fingerprint,usage_snapshot,price_snapshot,created_by,reason,created_at)
        SELECT ?,?,'consumption',r.user_id,r.id,'USD',?,?,?,?,NULL,NULL,?
        FROM requests r JOIN api_keys k ON k.id=r.api_key_id
        WHERE r.id=? AND r.user_id=? AND k.user_id=? AND r.price_snapshot=?
          AND r.public_model_id=? AND r.upstream_model=? AND r.upstream_protocol=?
        RETURNING ${projection}`,
      [crypto.randomUUID(), expected.operationId, delta, expected.fingerprint, expected.usageSnapshotJson, expected.priceSnapshotJson, now,
        expected.requestId, expected.userId, expected.userId, expected.priceSnapshotJson, expected.publicModelId, expected.upstreamModel, expected.upstreamProtocol]),
      // Zero-row INSERT SELECT is not success. Throw inside the batch so trigger
      // side effects also roll back, instead of finding the mismatch after commit.
      prepare(database, "SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('{}','consumption_request_conflict') END AS matched"),
    ] as const);
    const row = result[0].rows[0];
    if (!row) throw new ApiError('service_unavailable');
    return { entry: matchingEntry(row, expected), outcome: 'inserted' };
  } catch (error) {
    // Trigger order can report 'settled request' instead of a UNIQUE violation;
    // an acknowledgement can also fail after commit. Reconcile all write errors.
    const committed = await lookup(database, expected);
    if (committed) return { entry: committed, outcome: 'existing' };
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && (error.message.includes('consumption_request_conflict')
      || error.message.includes('billing_request_mismatch_or_settled'))) throw new ApiError('conflict');
    throw new ApiError('service_unavailable');
  }
}
