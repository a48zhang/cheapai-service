import { batch, prepare } from '../db';
import { ApiError } from '../http';
import type { PriceTable } from '../billing/pricing';
import { buildAuditStatement } from './audit';
import { getModelById, modelProjection as projection, decodeModelRow as view, invalidModelInput as invalid, modelInputObject as inputObject, modelInteger as integer, modelIdentifier as identifier, modelStatus, admissionUnits, validateModelPrices as prices } from '../catalog/models';
import type { ModelView, ModelRow } from '../catalog/models';
export { getModelById } from '../catalog/models';
export type { ModelView } from '../catalog/models';

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

const patchFields = ['status', 'sellPrices', 'admissionMinBalanceUnits', 'maxOutputTokens'] as const;

function auditContext(value: ModelAuditContext): ModelAuditContext {
  const input = inputObject(value, ['actorId', 'operationId', 'now']);
  return { actorId: identifier(input.actorId), operationId: identifier(input.operationId), now: integer(input.now, 0) };
}

function requireOneChange(database: D1Database) {
  // An intentional SQL error turns zero rows into a real same-batch rollback,
  // including any trigger side effects. Checking results after commit is too late.
  return prepare(database, "SELECT CASE WHEN changes() = 1 THEN 1 ELSE json_extract('{}', 'model_write_conflict') END AS matched");
}
function writeError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof Error && error.message.includes('model_write_conflict')) throw new ApiError('conflict');
  throw new ApiError('service_unavailable', { cause: error });
}
function auditFields(value: { status: 'active' | 'disabled'; priceVersion: number; admissionMinBalanceUnits: string; maxOutputTokens: number }) {
  // Record the model configuration metadata; existing request price snapshots
  // are never rewritten.
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
