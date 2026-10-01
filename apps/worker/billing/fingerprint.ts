import type { UsageSnapshot } from '@sub2api/apicompat/types/shared';
import type { Protocol } from '@sub2api/apicompat/types/shared';
import { BILLABLE_BUCKETS, normalizeUsageToBuckets, parseBillingMultiplier } from './pricing';
import type { PriceTable } from './pricing';
import { MONEY_CURRENCY, MONEY_DECIMALS, parseUnits, parseUsdToUnits } from './money';

export const CANONICAL_JSON_VERSION = 1;
export const PRICE_SNAPSHOT_VERSION = 1;
export const BILLING_CALCULATION_VERSION = 1;
export const SETTLEMENT_FINGERPRINT_VERSION = 1;
export const CANONICAL_JSON_LIMITS = Object.freeze({ depth: 64, nodes: 100_000, bytes: 1_048_576 });

export class FingerprintError extends Error {
  constructor(public readonly code: 'invalid_json' | 'json_too_large' | 'invalid_snapshot' | 'invalid_facts' | 'unsupported_version') {
    super(`Cannot prepare billing fingerprint: ${code}`);
    this.name = 'FingerprintError';
  }
}

/**
 * Version 1: finite JSON numbers use ECMAScript JSON spelling; strings retain
 * their code points; object keys sort by UTF-16 ordinal order, never locale.
 * Object members are emitted directly so integer-like keys are not reordered
 * by JSON.stringify(object). Arrays retain order. No coercion/toJSON/getters.
 * BigInt amounts must be converted explicitly at the settlement boundary.
 */
export function canonicalJson(value: unknown, version: number = CANONICAL_JSON_VERSION): string {
  if (version !== CANONICAL_JSON_VERSION) throw new FingerprintError('unsupported_version');
  const chunks: string[] = [];
  const ancestors = new WeakSet<object>();
  const encoder = new TextEncoder();
  let nodes = 0;
  let bytes = 0;
  const emit = (chunk: string): void => {
    bytes += encoder.encode(chunk).byteLength;
    if (bytes > CANONICAL_JSON_LIMITS.bytes) throw new FingerprintError('json_too_large');
    chunks.push(chunk);
  };
  const quoted = (text: string): string => {
    if (text.length > CANONICAL_JSON_LIMITS.bytes) throw new FingerprintError('json_too_large');
    return JSON.stringify(text);
  };
  const visit = (entry: unknown, depth: number): void => {
    if (++nodes > CANONICAL_JSON_LIMITS.nodes || depth > CANONICAL_JSON_LIMITS.depth) throw new FingerprintError('json_too_large');
    if (entry === null) { emit('null'); return; }
    if (typeof entry === 'string') { emit(quoted(entry)); return; }
    if (typeof entry === 'boolean') { emit(entry ? 'true' : 'false'); return; }
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw new FingerprintError('invalid_json');
      emit(JSON.stringify(entry)); return;
    }
    if (typeof entry !== 'object' || ancestors.has(entry)) throw new FingerprintError('invalid_json');
    const array = Array.isArray(entry);
    const prototype = Object.getPrototypeOf(entry);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new FingerprintError('invalid_json');
    const keys = Reflect.ownKeys(entry);
    if (keys.length > CANONICAL_JSON_LIMITS.nodes) throw new FingerprintError('json_too_large');
    if (keys.some(key => typeof key !== 'string')) throw new FingerprintError('invalid_json');
    ancestors.add(entry);
    try {
      if (array) {
        const length = Object.getOwnPropertyDescriptor(entry, 'length')?.value as unknown;
        if (typeof length !== 'number' || keys.length !== length + 1) throw new FingerprintError('invalid_json');
        emit('[');
        for (let index = 0; index < length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(entry, String(index));
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new FingerprintError('invalid_json');
          if (index) emit(',');
          visit(descriptor.value, depth + 1);
        }
        emit(']');
      } else {
        emit('{');
        const sorted = (keys as string[]).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
        sorted.forEach((key, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(entry, key);
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new FingerprintError('invalid_json');
          if (index) emit(',');
          emit(quoted(key)); emit(':'); visit(descriptor.value, depth + 1);
        });
        emit('}');
      }
    } finally { ancestors.delete(entry); }
  };
  try { visit(value, 0); return chunks.join(''); }
  catch (error) {
    if (error instanceof FingerprintError) throw error;
    throw new FingerprintError('invalid_json');
  }
}

export interface PriceSnapshotInput {
  readonly publicModelId: string;
  readonly upstreamModel: string;
  readonly upstreamProtocol: Protocol;
  readonly priceVersion: number;
  readonly sellPrices: PriceTable;
  /** Optional on purpose: old API requests did not carry a group identity. */
  readonly groupId?: string;
  readonly groupVersion?: number;
  readonly billingMultiplier?: string;
}
export interface PriceSnapshot {
  readonly schema_version: typeof PRICE_SNAPSHOT_VERSION;
  readonly canonical_json_version: typeof CANONICAL_JSON_VERSION;
  readonly calculation_version: typeof BILLING_CALCULATION_VERSION;
  readonly currency: typeof MONEY_CURRENCY;
  readonly decimals: typeof MONEY_DECIMALS;
  readonly tokens_per_price_unit: 1_000_000;
  readonly rounding: 'half_up_after_sum';
  readonly public_model_id: string;
  readonly upstream_model: string;
  readonly upstream_protocol: Protocol;
  readonly price_version: number;
  readonly sell_prices: PriceTable;
  /** New snapshots bind the selected group; old snapshots omit these fields. */
  readonly group_id?: string;
  readonly group_version?: number;
  readonly billing_multiplier?: string;
}
export interface StoredPriceSnapshot {
  readonly snapshot: PriceSnapshot;
  /** Store once on requests; reuse this exact text for the ledger and retries. */
  readonly json: string;
}

function dataFields(value: unknown, allowed: readonly string[], code: 'invalid_snapshot' | 'invalid_facts'): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new FingerprintError(code);
  const output: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key)) throw new FingerprintError(code);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || descriptor.value === undefined) throw new FingerprintError(code);
    output[key] = descriptor.value;
  }
  return output;
}
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

function copyPrices(value: unknown): PriceTable {
  const input = dataFields(value, BILLABLE_BUCKETS, 'invalid_snapshot');
  if (!Object.hasOwn(input, 'input') || !Object.hasOwn(input, 'output')) throw new FingerprintError('invalid_snapshot');
  const output: Record<string, string> = Object.create(null);
  for (const bucket of BILLABLE_BUCKETS) {
    if (!Object.hasOwn(input, bucket)) continue;
    try { if (parseUsdToUnits(input[bucket]) < 0n) throw new Error(); }
    catch { throw new FingerprintError('invalid_snapshot'); }
    output[bucket] = input[bucket] as string;
  }
  return Object.freeze(output) as PriceTable;
}

function snapshot(input: PriceSnapshotInput): PriceSnapshot {
  if (!id(input.publicModelId) || !id(input.upstreamModel) || !['chat', 'responses', 'messages'].includes(input.upstreamProtocol)
    || !Number.isSafeInteger(input.priceVersion) || input.priceVersion < 1) throw new FingerprintError('invalid_snapshot');
  if (input.groupId !== undefined && !id(input.groupId)) throw new FingerprintError('invalid_snapshot');
  if (input.groupVersion !== undefined && (!Number.isSafeInteger(input.groupVersion) || input.groupVersion < 1)) throw new FingerprintError('invalid_snapshot');
  let billingMultiplier: string | undefined;
  if (input.billingMultiplier !== undefined) {
    try { billingMultiplier = parseBillingMultiplier(input.billingMultiplier).text; }
    catch { throw new FingerprintError('invalid_snapshot'); }
  }
  const value: PriceSnapshot = { schema_version: PRICE_SNAPSHOT_VERSION, canonical_json_version: CANONICAL_JSON_VERSION,
    calculation_version: BILLING_CALCULATION_VERSION, currency: MONEY_CURRENCY, decimals: MONEY_DECIMALS,
    tokens_per_price_unit: 1_000_000, rounding: 'half_up_after_sum', public_model_id: input.publicModelId,
    upstream_model: input.upstreamModel, upstream_protocol: input.upstreamProtocol, price_version: input.priceVersion,
    sell_prices: copyPrices(input.sellPrices),
    ...(input.groupId === undefined ? {} : { group_id: input.groupId }),
    ...(input.groupVersion === undefined ? {} : { group_version: input.groupVersion }),
    ...(billingMultiplier === undefined ? {} : { billing_multiplier: billingMultiplier }) };
  return Object.freeze(value);
}

/** Copy a selected model's actual PriceTable, then serialize exactly once. No timestamp. */
export function createPriceSnapshot(input: PriceSnapshotInput): StoredPriceSnapshot {
  const fields = dataFields(input, ['publicModelId', 'upstreamModel', 'upstreamProtocol', 'priceVersion', 'sellPrices', 'groupId', 'groupVersion', 'billingMultiplier'], 'invalid_snapshot');
  const value = snapshot(fields as unknown as PriceSnapshotInput);
  return Object.freeze({ snapshot: value, json: canonicalJson(value) });
}

/** Validate persisted facts, but never replace the original stored JSON text. */
export function readPriceSnapshot(json: string): StoredPriceSnapshot {
  if (typeof json !== 'string' || new TextEncoder().encode(json).byteLength > CANONICAL_JSON_LIMITS.bytes) throw new FingerprintError('invalid_snapshot');
  try {
    const value = dataFields(JSON.parse(json), ['schema_version', 'canonical_json_version', 'calculation_version', 'currency', 'decimals', 'tokens_per_price_unit', 'rounding', 'public_model_id', 'upstream_model', 'upstream_protocol', 'price_version', 'sell_prices', 'group_id', 'group_version', 'billing_multiplier'], 'invalid_snapshot');
    if (value.schema_version !== PRICE_SNAPSHOT_VERSION || value.canonical_json_version !== CANONICAL_JSON_VERSION || value.calculation_version !== BILLING_CALCULATION_VERSION) throw new FingerprintError('unsupported_version');
    if (value.currency !== MONEY_CURRENCY || value.decimals !== MONEY_DECIMALS || value.tokens_per_price_unit !== 1_000_000 || value.rounding !== 'half_up_after_sum') throw new FingerprintError('invalid_snapshot');
    const parsed = snapshot({ publicModelId: value.public_model_id, upstreamModel: value.upstream_model, upstreamProtocol: value.upstream_protocol, priceVersion: value.price_version, sellPrices: value.sell_prices,
      ...(value.group_id === undefined ? {} : { groupId: value.group_id }),
      ...(value.group_version === undefined ? {} : { groupVersion: value.group_version }),
      ...(value.billing_multiplier === undefined ? {} : { billingMultiplier: value.billing_multiplier }) } as PriceSnapshotInput);
    return Object.freeze({ snapshot: parsed, json });
  } catch (error) {
    if (error instanceof FingerprintError) throw error;
    throw new FingerprintError('invalid_snapshot');
  }
}

/** Explicit nulls fix the fact envelope. Retry attempt/time and row IDs are not facts. */
export interface SettlementFacts {
  readonly kind: 'consumption' | 'adjustment' | 'grant';
  readonly operationId: string;
  readonly userId: string;
  readonly requestId: string | null;
  readonly priceSnapshotJson: string | null;
  readonly usage: UsageSnapshot | null;
  /** Signed ledger delta, not positive consumption cost. Numbers are rejected. */
  readonly deltaUnits: string | bigint;
  readonly createdBy: string | null;
  readonly reason: string | null;
}
export interface PreparedSettlementFingerprint {
  readonly version: typeof SETTLEMENT_FINGERPRINT_VERSION;
  readonly fingerprint: string;
  readonly deltaUnits: string;
  readonly priceSnapshotJson: string | null;
  readonly usageSnapshotJson: string | null;
}

/**
 * B02/the caller computes the amount; this function binds it without recomputing
 * or rounding it. Consumption usage must nevertheless be complete/priceable.
 * All usage evidence is included, including source/raw/cache/reasoning details.
 * The original price JSON is hashed as text and returned unchanged for D13.
 */
export async function buildSettlementFingerprint(facts: SettlementFacts): Promise<PreparedSettlementFingerprint> {
  const keys = ['kind', 'operationId', 'userId', 'requestId', 'priceSnapshotJson', 'usage', 'deltaUnits', 'createdBy', 'reason'] as const;
  const input = dataFields(facts, keys, 'invalid_facts');
  if (keys.some(key => !Object.hasOwn(input, key)) || !['consumption', 'adjustment', 'grant'].includes(input.kind as string)
    || !id(input.operationId) || !id(input.userId) || (input.requestId !== null && !id(input.requestId))
    || (input.createdBy !== null && !id(input.createdBy)) || (input.reason !== null && (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 4096))) throw new FingerprintError('invalid_facts');
  let units: bigint;
  try { units = parseUnits(typeof input.deltaUnits === 'bigint' ? input.deltaUnits.toString() : input.deltaUnits); }
  catch { throw new FingerprintError('invalid_facts'); }
  const deltaUnits = units.toString();
  const price = input.priceSnapshotJson === null ? null : readPriceSnapshot(input.priceSnapshotJson as string);
  const usageSnapshotJson = input.usage === null ? null : canonicalJson(input.usage);
  if (input.kind === 'consumption') {
    if (input.requestId === null || price === null || usageSnapshotJson === null || units > 0n) throw new FingerprintError('invalid_facts');
    try {
      const usage = JSON.parse(usageSnapshotJson) as UsageSnapshot;
      if (usage.protocol !== price.snapshot.upstream_protocol) throw new Error();
      normalizeUsageToBuckets(usage, price.snapshot.sell_prices);
    } catch { throw new FingerprintError('invalid_facts'); }
  } else if (input.reason === null || input.createdBy === null || (input.kind === 'grant' && units <= 0n)) throw new FingerprintError('invalid_facts');
  const canonical = canonicalJson({
    domain: 'sub2api.billing.settlement', fingerprint_version: SETTLEMENT_FINGERPRINT_VERSION,
    canonical_json_version: CANONICAL_JSON_VERSION, calculation_version: BILLING_CALCULATION_VERSION,
    currency: MONEY_CURRENCY, decimals: MONEY_DECIMALS, kind: input.kind,
    operation_id: input.operationId, user_id: input.userId, request_id: input.requestId,
    created_by: input.createdBy, reason: input.reason, delta_units: deltaUnits,
    price_snapshot_json: price?.json ?? null, usage_snapshot_json: usageSnapshotJson,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return Object.freeze({ version: SETTLEMENT_FINGERPRINT_VERSION, fingerprint: `sha256:v1:${hex}`, deltaUnits,
    priceSnapshotJson: price?.json ?? null, usageSnapshotJson });
}
