import { prepare } from '../db';
import { ApiError } from '../http';
import { BILLABLE_BUCKETS } from '../billing/pricing';
import type { PriceTable } from '../billing/pricing';
import { parseUnits, parseUsdToUnits, unitsToSafeNumber } from '../billing/money';

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

interface ModelRow {
  public_model_id: string; status: 'active' | 'disabled'; sell_prices_json: string; price_version: number;
  admission_min_balance_units: number; max_output_tokens: number;
  created_at: number; updated_at: number;
}

const projection = 'public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at';
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
  } catch (error) { throw new ApiError('service_unavailable', { cause: error }); } // Corrupt stored prices must never become free.
}

/** Reads validate stored prices too; malformed configuration is unavailable. */
export async function getModelById(database: D1Database, publicModelId: string): Promise<ModelView | null> {
  const id = identifier(publicModelId);
  try {
    const row = await prepare<ModelRow>(database, `SELECT ${projection} FROM models WHERE public_model_id=?`, [id]).first();
    return row ? view(row) : null;
  } catch (error) { throw new ApiError('service_unavailable', { cause: error }); }
}

export type { ModelRow };
export { projection as modelProjection, view as decodeModelRow, invalid as invalidModelInput, inputObject as modelInputObject, integer as modelInteger, identifier as modelIdentifier, modelStatus, admissionUnits, prices as validateModelPrices };
