import type { UsageSnapshot } from '@sub2api/apicompat/types/shared';
import { MONEY_CURRENCY, MONEY_DECIMALS, parseUsdToUnits, unitsToSafeNumber } from './money';

export const BILLABLE_BUCKETS = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h', 'reasoning'] as const;
export type BillableBucket = typeof BILLABLE_BUCKETS[number];
export type BillableBuckets = Readonly<Record<BillableBucket, bigint>>;
/** USD per million tokens. Optional rates enable separate billing dimensions.
 * With no separate rate, an included dimension stays at the aggregate base rate,
 * even if its counter is unknown. An excluded positive dimension needs a rate;
 * an unknown counter needed for separate/excluded billing prevents exact pricing.
 * TTL rates opt into only their respective subsets; remaining writes use
 * cacheWrite. No missing price is interpreted as free.
 */
export type PriceTable = Readonly<{
  input: string;
  output: string;
} & Partial<Record<Exclude<BillableBucket, 'input' | 'output'>, string>>>;

export interface PricedBucket {
  readonly bucket: BillableBucket;
  readonly tokens: bigint;
  readonly usdPerMillionTokens: string;
  readonly unitsPerMillionTokens: bigint;
  /** Exact product, before dividing by one million. Never a rounded line cost. */
  readonly numerator: bigint;
}

export interface PriceResult {
  readonly currency: typeof MONEY_CURRENCY;
  readonly decimals: typeof MONEY_DECIMALS;
  readonly buckets: BillableBuckets;
  readonly items: readonly PricedBucket[];
  /** Base price products before applying the group multiplier. */
  readonly baseNumerator: bigint;
  /** Exact numerator after applying the multiplier, before final division. */
  readonly numerator: bigint;
  /** 1,000,000 multiplied by the exact multiplier denominator. */
  readonly denominator: bigint;
  readonly billingMultiplier: string;
  readonly rounding: 'half_up_after_sum';
  /** Positive charge magnitude, not the negative ledger delta. */
  readonly costUnits: bigint;
}

export class PricingError extends Error {
  constructor(public readonly code: 'unpriceable_usage' | 'invalid_price' | 'missing_price' | 'cost_overflow') {
    super(`Cannot price usage: ${code}`);
    this.name = 'PricingError';
  }
}

export const DEFAULT_BILLING_MULTIPLIER = '1' as const;
export const BILLING_MULTIPLIER_MAX_DECIMALS = 18;

export interface ParsedBillingMultiplier {
  readonly text: string;
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/** Parse an explicitly supplied group multiplier as decimal text, never through
 * a JavaScript number. Callers that read a legacy snapshot choose the default
 * string before calling this parser. */
export function parseBillingMultiplier(value: unknown): ParsedBillingMultiplier {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64 || value.trim() !== value
    || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) throw new PricingError('invalid_price');
  const dot = value.indexOf('.');
  const whole = dot < 0 ? value : value.slice(0, dot);
  const fraction = dot < 0 ? '' : value.slice(dot + 1);
  if (fraction.length > BILLING_MULTIPLIER_MAX_DECIMALS) throw new PricingError('invalid_price');
  let numerator: bigint;
  try { numerator = BigInt(`${whole}${fraction}`); } catch { throw new PricingError('invalid_price'); }
  const denominator = 10n ** BigInt(fraction.length);
  return Object.freeze({ text: value, numerator, denominator });
}

export function isValidBillingMultiplier(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { parseBillingMultiplier(value); return true; } catch { return false; }
}

export type BillingMultiplierInput = string | Readonly<{ billingMultiplier?: string }>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function count(value: unknown): bigint {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new PricingError('unpriceable_usage');
  }
  return BigInt(value);
}

/** Buckets describe charged quantities, not inferred provider counters. Missing
 * included details remain inside the base aggregate unless a separate rate is
 * enabled. TTL rates split only their selected subsets from aggregate writes.
 * Terminal state is deliberately irrelevant: truncated output can have complete
 * upstream usage, while a successful response can still have missing usage.
 */
export function normalizeUsageToBuckets(usage: UsageSnapshot, prices: PriceTable): BillableBuckets {
  if (!record(usage) || usage.quality !== 'complete' || !record(usage.counts)
      || !record(usage.semantics) || !Array.isArray(usage.issues) || usage.issues.length !== 0
      || !Array.isArray(usage.sources) || usage.sources.length === 0
      || !['chat', 'responses', 'messages'].includes(usage.protocol)) {
    throw new PricingError('unpriceable_usage');
  }
  for (const source of usage.sources) {
    if (!record(source) || source.protocol !== usage.protocol || typeof source.path !== 'string' || source.path.trim() === '') {
      throw new PricingError('unpriceable_usage');
    }
  }
  const counts = usage.counts;
  const countKeys = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cacheWrite5mTokens', 'cacheWrite1hTokens', 'reasoningTokens'];
  for (const key of Reflect.ownKeys(counts)) {
    if (typeof key !== 'string' || !countKeys.includes(key)) throw new PricingError('unpriceable_usage');
    count((counts as Record<string, unknown>)[key]);
  }
  const input = count(counts.inputTokens);
  const output = count(counts.outputTokens);
  if (!record(prices)) throw new PricingError('invalid_price');
  const optionalCount = (key: keyof typeof counts): bigint | undefined =>
    Object.hasOwn(counts, key) ? count(counts[key]) : undefined;
  const readCount = optionalCount('cacheReadTokens');
  const writeCount = optionalCount('cacheWriteTokens');
  const reasoningCount = optionalCount('reasoningTokens');
  const semantics = usage.semantics;
  if (!['included_in_input', 'excluded_from_input', 'unknown'].includes(semantics.cacheRead)
      || !['included_in_input', 'excluded_from_input', 'unknown'].includes(semantics.cacheWrite)
      || !['included_in_output', 'excluded_from_output', 'unknown'].includes(semantics.reasoning)
      || !['subsets_of_cache_write', 'unknown'].includes(semantics.cacheWriteTtl)) {
    throw new PricingError('unpriceable_usage');
  }
  const enabled = (bucket: BillableBucket): boolean => Object.hasOwn(prices, bucket);
  function dimension(value: bigint | undefined, included: boolean, unknown: boolean, separate: boolean): bigint {
    if (unknown) {
      if (value === 0n) return 0n;
      throw new PricingError('unpriceable_usage');
    }
    if (included && !separate) return 0n; // Retained inside aggregate, not asserted absent.
    if (value === undefined) throw new PricingError('unpriceable_usage');
    if (!included && value > 0n && !separate) throw new PricingError('missing_price');
    return value;
  }
  const cacheRead = dimension(readCount, semantics.cacheRead === 'included_in_input', semantics.cacheRead === 'unknown', enabled('cacheRead'));
  const cacheWrite = dimension(writeCount, semantics.cacheWrite === 'included_in_input', semantics.cacheWrite === 'unknown', enabled('cacheWrite') || enabled('cacheWrite5m') || enabled('cacheWrite1h'));
  const reasoning = dimension(reasoningCount, semantics.reasoning === 'included_in_output', semantics.reasoning === 'unknown', enabled('reasoning'));
  const observed5m = optionalCount('cacheWrite5mTokens');
  const observed1h = optionalCount('cacheWrite1hTokens');
  if (writeCount !== undefined && semantics.cacheWriteTtl === 'subsets_of_cache_write'
      && (observed5m ?? 0n) + (observed1h ?? 0n) > writeCount) throw new PricingError('unpriceable_usage');
  function ttl(value: bigint | undefined, separate: boolean): bigint {
    if (!separate || cacheWrite === 0n) return 0n;
    if (semantics.cacheWriteTtl !== 'subsets_of_cache_write' || value === undefined) throw new PricingError('unpriceable_usage');
    return value;
  }
  const cacheWrite5m = ttl(observed5m, enabled('cacheWrite5m'));
  const cacheWrite1h = ttl(observed1h, enabled('cacheWrite1h'));
  const plainInput = input - (semantics.cacheRead === 'included_in_input' ? cacheRead : 0n)
    - (semantics.cacheWrite === 'included_in_input' ? cacheWrite : 0n);
  const plainOutput = output - (semantics.reasoning === 'included_in_output' ? reasoning : 0n);
  const genericWrites = cacheWrite - cacheWrite5m - cacheWrite1h;
  // Known contradictory subsets are invalid even if no differential rate uses them.
  if ((semantics.cacheRead === 'included_in_input' ? readCount ?? 0n : 0n)
      + (semantics.cacheWrite === 'included_in_input' ? writeCount ?? 0n : 0n) > input
      || (semantics.reasoning === 'included_in_output' && reasoningCount !== undefined && reasoningCount > output)) {
    throw new PricingError('unpriceable_usage');
  }
  if (plainInput < 0n || plainOutput < 0n || genericWrites < 0n) throw new PricingError('unpriceable_usage');
  // totalTokens has no inclusion semantics in P01. Validate its scalar shape
  // above, but never use it to replace or charge the input/output evidence.
  return Object.freeze({ input: plainInput, output: plainOutput, cacheRead, cacheWrite: genericWrites, cacheWrite5m, cacheWrite1h, reasoning });
}

export function calculatePrice(usage: UsageSnapshot, prices: PriceTable,
  multiplierInput: BillingMultiplierInput = DEFAULT_BILLING_MULTIPLIER): PriceResult {
  const buckets = normalizeUsageToBuckets(usage, prices);
  if (!record(prices)) throw new PricingError('invalid_price');
  for (const key of Reflect.ownKeys(prices)) {
    if (typeof key !== 'string' || !(BILLABLE_BUCKETS as readonly string[]).includes(key)) {
      throw new PricingError('invalid_price');
    }
  }
  const items: PricedBucket[] = [];
  let numerator = 0n;
  for (const bucket of BILLABLE_BUCKETS) {
    if (!Object.hasOwn(prices, bucket)) {
      if (bucket === 'input' || bucket === 'output' || buckets[bucket] > 0n) throw new PricingError('missing_price');
      continue;
    }
    const rate = prices[bucket];
    let unitsPerMillionTokens: bigint;
    try {
      unitsPerMillionTokens = parseUsdToUnits(rate);
      if (unitsPerMillionTokens < 0n) throw new PricingError('invalid_price');
    } catch {
      throw new PricingError('invalid_price');
    }
    const product = buckets[bucket] * unitsPerMillionTokens;
    numerator += product;
    items.push(Object.freeze({ bucket, tokens: buckets[bucket], usdPerMillionTokens: rate as string, unitsPerMillionTokens, numerator: product }));
  }
  let multiplier: ParsedBillingMultiplier;
  try {
    let value: unknown = DEFAULT_BILLING_MULTIPLIER;
    if (multiplierInput !== undefined) {
      if (typeof multiplierInput === 'string') value = multiplierInput;
      else if (multiplierInput !== null && typeof multiplierInput === 'object' && !Array.isArray(multiplierInput)) {
        value = Object.hasOwn(multiplierInput, 'billingMultiplier')
          ? (multiplierInput as Readonly<Record<string, unknown>>).billingMultiplier : DEFAULT_BILLING_MULTIPLIER;
        if (value === undefined) throw new PricingError('invalid_price');
      } else throw new PricingError('invalid_price');
    }
    multiplier = parseBillingMultiplier(value);
  } catch (error) {
    if (error instanceof PricingError) throw error;
    throw new PricingError('invalid_price');
  }
  const baseNumerator = numerator;
  numerator *= multiplier.numerator;
  const denominator = 1_000_000n * multiplier.denominator;
  const costUnits = (numerator + denominator / 2n) / denominator;
  try { unitsToSafeNumber(costUnits); } catch { throw new PricingError('cost_overflow'); }
  return Object.freeze({ currency: MONEY_CURRENCY, decimals: MONEY_DECIMALS, buckets, items: Object.freeze(items), baseNumerator,
    numerator, denominator, billingMultiplier: multiplier.text, rounding: 'half_up_after_sum', costUnits });
}
