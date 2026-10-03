import { getModelById } from '../catalog/models';
import { BILLABLE_BUCKETS } from '../billing/pricing';
import type { PriceTable } from '../billing/pricing';
import { parseUsdToUnits } from '../billing/money';
import { DEFAULT_CONFIG } from '../config';
import { ApiError } from '../http';
import { readSnapshot, writeSnapshot } from './snapshot';
import type { Snapshot } from './snapshot';

export interface PriceData {
  readonly public_model_id: string;
  readonly price_version: number;
  /** Explicit USD rates per million tokens. Missing buckets are not free. */
  readonly sell_prices: PriceTable;
}
export interface PriceRead {
  readonly snapshot: Snapshot<PriceData>;
  readonly source: 'cache' | 'd1';
  readonly requiresAuthoritativeVersionCheck: true;
}
export interface PriceCacheOptions {
  maxAgeMs?: number;
  /** If final D1 admission already knows a different version, bypass that cache. */
  expectedPriceVersion?: number;
  now?: () => number;
}

export function priceCacheKey(publicModelId: string): string {
  if (typeof publicModelId !== 'string' || publicModelId.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(publicModelId)) throw new ApiError('invalid_request');
  return `v1:price:${encodeURIComponent(publicModelId)}`;
}

function validPrice(value: unknown, modelId: string): value is PriceData {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== 3 || data.public_model_id !== modelId ||
      typeof data.price_version !== 'number' || !Number.isSafeInteger(data.price_version) || data.price_version < 1 ||
      data.sell_prices === null || typeof data.sell_prices !== 'object' || Array.isArray(data.sell_prices)) return false;
  const prices = data.sell_prices as Record<string, unknown>;
  if (!Object.hasOwn(prices, 'input') || !Object.hasOwn(prices, 'output')) return false;
  try {
    for (const [bucket, rate] of Object.entries(prices)) {
      if (!(BILLABLE_BUCKETS as readonly string[]).includes(bucket) || parseUsdToUnits(rate) < 0n) return false;
    }
    return true;
  } catch { return false; }
}

/** Configuration cache only. Before dispatch, final D1 admission must check the
 * price version and model state and persist the chosen request price snapshot.
 * This never updates an in-flight request's prices or assumes cached enablement.
 */
export async function readPrices(
  database: D1Database,
  kv: KVNamespace,
  publicModelId: string,
  options: PriceCacheOptions = {},
): Promise<PriceRead | null> {
  const key = priceCacheKey(publicModelId);
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_CONFIG.routingCacheTtlMs;
  const expectedVersion = options.expectedPriceVersion;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0 ||
      (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1))) throw new ApiError('invalid_request');
  const clock = (): number => {
    const value = (options.now ?? Date.now)();
    if (!Number.isSafeInteger(value) || value < 0) throw new ApiError('service_unavailable');
    return value;
  };
  const validate = (value: unknown): value is PriceData => validPrice(value, publicModelId);
  const cached = await readSnapshot(kv, key, { now: clock(), maxAgeMs }, validate);
  if (cached) {
    const age = clock() - cached.observed_at;
    if (age >= 0 && age < maxAgeMs && (expectedVersion === undefined || expectedVersion === cached.data.price_version)) {
      return { snapshot: cached, source: 'cache', requiresAuthoritativeVersionCheck: true };
    }
  }
  const observedAt = clock();
  let data: PriceData;
  try {
    const model = await getModelById(database, publicModelId);
    if (model === null || model.status !== 'active') return null;
    data = { public_model_id: model.publicModelId, price_version: model.priceVersion, sell_prices: model.sellPrices };
    if (!validate(data)) throw new Error('Invalid D1 prices');
  } catch { throw new ApiError('service_unavailable'); }
  const snapshot: Snapshot<PriceData> = { schema_version: 1, observed_at: observedAt, data };
  // KV errors never undo/reject the authoritative configuration read.
  await writeSnapshot(kv, key, snapshot, { now: clock(), maxAgeMs }, validate);
  return { snapshot, source: 'd1', requiresAuthoritativeVersionCheck: true };
}
