import { batch, prepare } from '../db';
import { ApiError } from '../http';
import { BILLABLE_BUCKETS } from '../billing/pricing';
import type { PriceTable } from '../billing/pricing';
import { parseUnits, parseUsdToUnits, unitsToSafeNumber } from '../billing/money';
import { buildAuditStatement } from './audit';

export interface ModelView {
  readonly publicModelId: string;
  readonly status: 'active' | 'disabled';
  /** USD per million tokens, compatible with B02 PriceTable. */
  readonly sellPrices: PriceTable;
  /** Optimistic version for every model configuration mutation. */
  readonly priceVersion: number;
  /** Canonical integer units string, not USD and not a floating-point amount. */
  readonly admissionMinBalanceUnits: string;
  readonly maxOutputTokens: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateModelInput {
  readonly publicModelId: string;
  readonly status?: 'active' | 'disabled';
  readonly sellPrices: PriceTable;
  readonly admissionMinBalanceUnits: string;
  readonly maxOutputTokens: number;
}

/** sellPrices is a full replacement, never a partial merge or implicit zero. */
export type ModelPatch = Partial<Omit<CreateModelInput, 'publicModelId'>>;
export interface ModelAuditContext { readonly actorId: string; readonly operationId: string; readonly now: number }

interface ModelRow {
  public_model_id: string; status: 'active' | 'disabled'; sell_prices_json: string; price_version: number;
  admission_min_balance_units: number; max_output_tokens: number;
  created_at: number; updated_at: number;
}

const projection = 'public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at';
const patchFields = ['status', 'sellPrices', 'admissionMinBalanceUnits', 'maxOutputTokens'] as const;

function invalid(): never { throw new ApiError('invalid_request'); }
function inputObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid();
  const output: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || descriptor.value === undefined) invalid();
    output[key] = descriptor.value;
  }
  return output;
}
function integer(value: unknown, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) invalid();
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value)) invalid();
  return value;
}
function modelStatus(value: unknown): 'active' | 'disabled' {
  if (value !== 'active' && value !== 'disabled') invalid();
  return value;
}
function admissionUnits(value: unknown): number {
  try {
    const units = parseUnits(value);
    if (units < 0n) invalid();
    return unitsToSafeNumber(units);
  } catch { return invalid(); }
}

/**
 * Required input/output rates and every optional rate are exact nonnegative USD
 * strings. Absence of an optional rate leaves included usage at its base rate;
 * excluded positive usage still needs a configured rate in B02. TTL rates only
 * price their own subsets. No omitted dimension is stored as a free price.
 */
function prices(value: unknown): PriceTable {
  const input = inputObject(value, BILLABLE_BUCKETS);
  if (!Object.hasOwn(input, 'input') || !Object.hasOwn(input, 'output')) invalid();
  const output: Record<string, string> = Object.create(null);
  for (const bucket of BILLABLE_BUCKETS) {
    if (!Object.hasOwn(input, bucket)) continue;
    const rate = input[bucket];
    try { if (parseUsdToUnits(rate) < 0n) invalid(); } catch { return invalid(); }
    output[bucket] = rate as string;
  }
  return Object.freeze(output) as PriceTable;
}

function auditContext(value: ModelAuditContext): ModelAuditContext {
  const input = inputObject(value, ['actorId', 'operationId', 'now']);
  return { actorId: identifier(input.actorId), operationId: identifier(input.operationId), now: integer(input.now, 0) };
}

function view(row: ModelRow): ModelView {
  try {
    const sellPrices = prices(JSON.parse(row.sell_prices_json));
    const maxOutputTokens = integer(row.max_output_tokens, 1);
    if (row.updated_at < row.created_at) invalid();
    return Object.freeze({
      publicModelId: identifier(row.public_model_id), status: modelStatus(row.status), sellPrices,
      priceVersion: integer(row.price_version, 1), admissionMinBalanceUnits: String(integer(row.admission_min_balance_units, 0)),
      maxOutputTokens, createdAt: integer(row.created_at, 0), updatedAt: integer(row.updated_at, 0),
    });
  } catch { throw new ApiError('service_unavailable'); } // Corrupt stored prices must never become free.
}

function requireOneChange(database: D1Database) {
  // An intentional SQL error turns zero rows into a real same-batch rollback,
  // including any trigger side effects. Checking results after commit is too late.
  return prepare(database, "SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('{}', 'model_write_conflict') END AS matched");
}
function writeError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof Error && error.message.includes('model_write_conflict')) throw new ApiError('conflict');
  throw new ApiError('service_unavailable');
}
function auditFields(value: { status: 'active' | 'disabled'; priceVersion: number; admissionMinBalanceUnits: string; maxOutputTokens: number }) {
  // O01 permits these structured fields, not arbitrary price JSON. Version and
  // limits remain visible; existing request price snapshots are never rewritten.
  return { status: value.status, price_version: value.priceVersion, admission_min_balance_units: admissionUnits(value.admissionMinBalanceUnits), max_output_tokens: value.maxOutputTokens };
}

/** Caller authorizes the administrator. No HTTP, channel mappings or request writes. */
export async function createModel(database: D1Database, input: CreateModelInput, context: ModelAuditContext): Promise<ModelView> {
  const values = inputObject(input, ['publicModelId', ...patchFields]);
  const audit = auditContext(context);
  const id = identifier(values.publicModelId);
  const sellPrices = prices(values.sellPrices);
  const minimum = admissionUnits(values.admissionMinBalanceUnits);
  const maximum = integer(values.maxOutputTokens, 1);
  const status = modelStatus(Object.hasOwn(values, 'status') ? values.status : 'active');
  try {
    const result = await batch(database, [
      prepare<ModelRow>(database, `INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at)
        VALUES (?,?,?,1,?,?,?,?) ON CONFLICT(public_model_id) DO NOTHING RETURNING ${projection}`,
      [id, status, JSON.stringify(sellPrices), minimum, maximum, audit.now, audit.now]),
      requireOneChange(database),
      buildAuditStatement(database, { actor_id: audit.actorId, operation_id: audit.operationId, created_at: audit.now,
        action: 'model.create', target_type: 'model', target_id: id,
        changes: { after: auditFields({ status, priceVersion: 1, admissionMinBalanceUnits: String(minimum), maxOutputTokens: maximum }) } }),
    ] as const);
    const saved = result[0].rows[0];
    if (!saved) throw new ApiError('service_unavailable');
    return view(saved);
  } catch (error) { return writeError(error); }
}

/** Reads validate stored prices too; malformed configuration is unavailable. */
export async function getModelById(database: D1Database, publicModelId: string): Promise<ModelView | null> {
  const id = identifier(publicModelId);
  try {
    const row = await prepare<ModelRow>(database, `SELECT ${projection} FROM models WHERE public_model_id=?`, [id]).first();
    return row ? view(row) : null;
  } catch { throw new ApiError('service_unavailable'); }
}

/** All changed fields share the priceVersion CAS because models has no second version. */
export async function updateModel(database: D1Database, publicModelId: string, expectedPriceVersion: number, patch: ModelPatch, context: ModelAuditContext): Promise<ModelView> {
  const id = identifier(publicModelId);
  integer(expectedPriceVersion, 1);
  if (expectedPriceVersion === Number.MAX_SAFE_INTEGER) throw new ApiError('conflict');
  const values = inputObject(patch, patchFields);
  if (Object.keys(values).length === 0) invalid();
  const audit = auditContext(context);
  const current = await getModelById(database, id);
  if (!current) throw new ApiError('not_found');
  if (current.priceVersion !== expectedPriceVersion) throw new ApiError('conflict');
  const sellPrices = Object.hasOwn(values, 'sellPrices') ? prices(values.sellPrices) : current.sellPrices;
  const minimum = Object.hasOwn(values, 'admissionMinBalanceUnits') ? admissionUnits(values.admissionMinBalanceUnits) : admissionUnits(current.admissionMinBalanceUnits);
  const maximum = Object.hasOwn(values, 'maxOutputTokens') ? integer(values.maxOutputTokens, 1) : current.maxOutputTokens;
  const status = Object.hasOwn(values, 'status') ? modelStatus(values.status) : current.status;
  try {
    const result = await batch(database, [
      prepare<ModelRow>(database, `UPDATE models SET status=?,sell_prices_json=?,price_version=price_version+1,
        admission_min_balance_units=?,max_output_tokens=?,updated_at=max(updated_at,?)
        WHERE public_model_id=? AND price_version=? RETURNING ${projection}`,
      [status, JSON.stringify(sellPrices), minimum, maximum, audit.now, id, expectedPriceVersion]),
      requireOneChange(database),
      buildAuditStatement(database, { actor_id: audit.actorId, operation_id: audit.operationId, created_at: audit.now,
        action: 'model.update', target_type: 'model', target_id: id,
        changes: { before: auditFields(current), after: auditFields({ status, priceVersion: expectedPriceVersion + 1, admissionMinBalanceUnits: String(minimum), maxOutputTokens: maximum }) } }),
    ] as const);
    const saved = result[0].rows[0];
    if (!saved) throw new ApiError('service_unavailable');
    return view(saved);
  } catch (error) { return writeError(error); }
}
