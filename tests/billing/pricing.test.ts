import { describe, expect, it } from 'vitest';
import type { TokenCounts, UsageSemantics, UsageSnapshot } from '../../packages/apicompat/types/shared';
import { MAX_SAFE_UNITS } from '../../apps/worker/billing/money';
import { calculatePrice, normalizeUsageToBuckets, PricingError } from '../../apps/worker/billing/pricing';
import type { PriceTable } from '../../apps/worker/billing/pricing';

function usage(counts: TokenCounts = {}, semantics: Partial<UsageSemantics> = {}): UsageSnapshot {
  return {
    quality: 'complete', protocol: 'chat', issues: [], sources: [{ protocol: 'chat', path: 'usage' }],
    counts: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, ...counts },
    semantics: { cacheRead: 'included_in_input', cacheWrite: 'included_in_input', reasoning: 'included_in_output', cacheWriteTtl: 'subsets_of_cache_write', ...semantics },
  };
}
const rates: PriceTable = { input: '1', output: '2', cacheRead: '0.1', cacheWrite: '1.25', reasoning: '3' };
const ttlRates: PriceTable = { ...rates, cacheWrite5m: '1.5', cacheWrite1h: '2' };

describe('mutually exclusive billing buckets', () => {
  it('matches the architecture USD 0.002 = 200000 unit example', () => {
    expect(calculatePrice(usage(), { input: '1', output: '2' }).costUnits).toBe(200_000n);
  });

  it('prices input/output-only Responses at base rates without inventing missing counters', () => {
    const evidence: UsageSnapshot = {
      quality: 'complete', protocol: 'responses', counts: { inputTokens: 1000, outputTokens: 500 },
      semantics: { cacheRead: 'included_in_input', cacheWrite: 'included_in_input', reasoning: 'included_in_output', cacheWriteTtl: 'unknown' },
      sources: [{ protocol: 'responses', path: 'response.usage' }], issues: [],
    };
    const result = calculatePrice(evidence, { input: '1', output: '2' });
    expect(result.costUnits).toBe(200_000n);
    expect(result.buckets.input).toBe(1000n);
    expect(result.buckets.output).toBe(500n);
    expect(evidence.counts).toEqual({ inputTokens: 1000, outputTokens: 500 });
    for (const price of [{ input: '1', output: '2', cacheRead: '0.1' }, { input: '1', output: '2', reasoning: '3' }, { input: '1', output: '2', cacheWrite5m: '1.5' }]) {
      expect(() => calculatePrice(evidence, price)).toThrow(PricingError);
    }
    for (const semantics of [{ ...evidence.semantics, cacheRead: 'excluded_from_input' }, { ...evidence.semantics, reasoning: 'unknown' }]) {
      expect(() => calculatePrice({ ...evidence, semantics } as UsageSnapshot, { input: '1', output: '2' })).toThrow(PricingError);
    }
  });

  it('retains known included cache/reasoning counts in base buckets when differential rates are disabled', () => {
    const result = calculatePrice(usage({ cacheReadTokens: 200, cacheWriteTokens: 100, reasoningTokens: 50 }), { input: '1', output: '2' });
    expect(result.costUnits).toBe(200_000n);
    expect(result.items.map((item) => item.bucket)).toEqual(['input', 'output']);
  });

  it('requires every enabled TTL dimension and the generic remainder price', () => {
    expect(() => calculatePrice(usage({ cacheWriteTokens: 100, cacheWrite5mTokens: 30 }), ttlRates)).toThrow(PricingError);
    expect(() => calculatePrice(usage({ cacheWriteTokens: 100, cacheWrite5mTokens: 30 }), { input: '1', output: '2', cacheWrite5m: '1.5' })).toThrow(PricingError);
    expect(calculatePrice(usage({ cacheWriteTokens: 100, cacheWrite5mTokens: 30 }), rates).buckets.cacheWrite).toBe(100n);
  });

  it('normalizes included and excluded provider counters to the same billable tokens', () => {
    const included = usage({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 100, reasoningTokens: 50 });
    const excluded = usage({ inputTokens: 700, outputTokens: 450, cacheReadTokens: 200, cacheWriteTokens: 100, reasoningTokens: 50 }, { cacheRead: 'excluded_from_input', cacheWrite: 'excluded_from_input', reasoning: 'excluded_from_output' });
    expect(normalizeUsageToBuckets(included, rates)).toEqual({ input: 700n, output: 450n, cacheRead: 200n, cacheWrite: 100n, cacheWrite5m: 0n, cacheWrite1h: 0n, reasoning: 50n });
    expect(calculatePrice(included, rates).costUnits).toBe(189_500n);
    expect(calculatePrice(excluded, rates)).toEqual(calculatePrice(included, rates));
  });

  it('subtracts only included categories with mixed input semantics', () => {
    const result = normalizeUsageToBuckets(usage({ inputTokens: 300, cacheReadTokens: 100, cacheWriteTokens: 200 }, { cacheWrite: 'excluded_from_input' }), rates);
    expect(result.input).toBe(200n);
    expect(result.cacheWrite).toBe(200n);
  });

  it('partitions TTL subsets and charges the generic remainder exactly once', () => {
    const result = calculatePrice(usage({ inputTokens: 100, outputTokens: 0, cacheWriteTokens: 100, cacheWrite5mTokens: 30, cacheWrite1hTokens: 20 }), ttlRates);
    expect(result.buckets).toMatchObject({ input: 0n, cacheWrite: 50n, cacheWrite5m: 30n, cacheWrite1h: 20n });
    expect(result.costUnits).toBe(14_750n);
    const oneTtl = normalizeUsageToBuckets(usage({ cacheWriteTokens: 100, cacheWrite5mTokens: 30 }), { ...rates, cacheWrite5m: '1.5' });
    expect(oneTtl.cacheWrite).toBe(70n);
    expect(oneTtl.cacheWrite1h).toBe(0n);
  });

  it('needs no generic write price when TTL buckets exhaust all writes', () => {
    const result = calculatePrice(usage({ cacheWriteTokens: 100, cacheWrite5mTokens: 100 }), { input: '1', output: '2', cacheWrite5m: '1.5' });
    expect(result.buckets.cacheWrite).toBe(0n);
    expect(result.costUnits).toBe(205_000n);
  });

  it('rejects contradictory subset counts and unknown semantics with nonzero counts', () => {
    const bad = [
      usage({ cacheReadTokens: 800, cacheWriteTokens: 300 }), usage({ reasoningTokens: 501 }),
      usage({ cacheWriteTokens: 10, cacheWrite5mTokens: 6, cacheWrite1hTokens: 5 }),
      usage({ cacheReadTokens: 1 }, { cacheRead: 'unknown' }),
      usage({ cacheWriteTokens: 1 }, { cacheWrite: 'unknown' }),
      usage({ reasoningTokens: 1 }, { reasoning: 'unknown' }),
    ];
    for (const evidence of bad) expect(() => calculatePrice(evidence, rates)).toThrow(PricingError);
    expect(() => calculatePrice(usage({ cacheWriteTokens: 10, cacheWrite5mTokens: 5, cacheWrite1hTokens: 0 }, { cacheWriteTtl: 'unknown' }), ttlRates)).toThrow(PricingError);
  });

  it('accepts explicit zeros with irrelevant unknown inclusion semantics', () => {
    expect(calculatePrice(usage({}, { cacheRead: 'unknown', cacheWrite: 'unknown', reasoning: 'unknown', cacheWriteTtl: 'unknown' }), rates).costUnits).toBe(200_000n);
  });

  it('rejects missing aggregates, malformed counts, and unknown counting fields', () => {
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
      const evidence = usage() as Extract<UsageSnapshot, { quality: 'complete' }>;
      const counts = { ...evidence.counts } as Record<string, unknown>;
      delete counts[key];
      expect(() => normalizeUsageToBuckets({ ...evidence, counts } as unknown as UsageSnapshot, rates)).toThrow(PricingError);
    }
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1', null, undefined]) {
      expect(() => normalizeUsageToBuckets(usage({ cacheWrite1hTokens: value as number }), rates)).toThrow(PricingError);
    }
    expect(() => normalizeUsageToBuckets(usage({ audioTokens: 4 } as TokenCounts), rates)).toThrow(PricingError);
    expect(() => normalizeUsageToBuckets(usage({ totalTokens: -1 }), rates)).toThrow(PricingError);
  });

  it('rejects incomplete/invalid/unproven evidence, even with seemingly usable counts', () => {
    for (const quality of ['partial', 'invalid', 'missing', 'unknown']) {
      expect(() => calculatePrice({ ...usage(), quality } as UsageSnapshot, rates)).toThrow(PricingError);
    }
    for (const changes of [{ issues: ['conflict'] }, { sources: [] }, { sources: [{ protocol: 'chat', path: '' }] }, { semantics: {} }, { counts: null }]) {
      expect(() => calculatePrice({ ...usage(), ...changes } as UsageSnapshot, rates)).toThrow(PricingError);
    }
  });

  it('prices complete final usage after length truncation without terminal-state discounts', () => {
    const truncatedResponse = { finish_reason: 'length', usage: usage({ inputTokens: 100, outputTokens: 20 }) };
    expect(calculatePrice(truncatedResponse.usage, rates).costUnits).toBe(14_000n);
  });
});

describe('price validation and aggregate half-up rounding', () => {
  it('applies a decimal group multiplier to the summed numerator before one final rounding', () => {
    const result = calculatePrice(usage({ inputTokens: 25_000_000, outputTokens: 25_000_000 }),
      { input: '0.00000001', output: '0.00000001' }, '0.01');
    expect(result.baseNumerator).toBe(50_000_000n);
    expect(result.numerator).toBe(50_000_000n);
    expect(result.denominator).toBe(100_000_000n);
    expect(result.billingMultiplier).toBe('0.01');
    // Two exact 0.25-unit line contributions sum to 0.5 and round to one.
    expect(result.costUnits).toBe(1n);
  });

  it('rejects malformed multipliers instead of treating them as one or free', () => {
    for (const multiplier of [null, '01', '-1', '1e2', '0.', `0.${'1'.repeat(19)}`]) {
      expect(() => calculatePrice(usage(), { input: '1', output: '2' }, multiplier as never)).toThrow(PricingError);
    }
  });

  it('requires explicit prices and permits explicitly configured zero rates', () => {
    const evidence = usage({ cacheReadTokens: 1 }, { cacheRead: 'excluded_from_input' });
    expect(() => calculatePrice(evidence, { input: '1', output: '2' })).toThrow(PricingError);
    expect(calculatePrice(evidence, { input: '0', output: '0', cacheRead: '0' }).costUnits).toBe(0n);
    expect(() => calculatePrice(usage({ inputTokens: 0, outputTokens: 0 }), {} as PriceTable)).toThrow(PricingError);
    for (const rate of ['-1', 'NaN', '1e2', '0.000000001', 1, undefined]) {
      expect(() => calculatePrice(usage(), { input: '1', output: '2', cacheRead: rate } as PriceTable)).toThrow(PricingError);
    }
    expect(() => calculatePrice(usage(), { ...rates, extra: '0' } as PriceTable)).toThrow(PricingError);
  });

  it('rounds below/at/above half a unit only after all products are summed', () => {
    for (const [tokens, expected] of [[499_999, 0n], [500_000, 1n], [500_001, 1n]] as const) {
      expect(calculatePrice(usage({ inputTokens: tokens, outputTokens: 0 }), { input: '0.00000001', output: '0' }).costUnits).toBe(expected);
    }
    // 0.4 + 0.4 units => 1, although rounding each line separately would yield 0.
    const result = calculatePrice(usage({ inputTokens: 400_000, outputTokens: 400_000 }), { input: '0.00000001', output: '0.00000001' });
    expect(result.numerator).toBe(800_000n);
    expect(result.denominator).toBe(1_000_000n);
    expect(result.costUnits).toBe(1n);
    // 0.5 + 0.5 units => 1, although per-line rounding would overcharge 2.
    expect(calculatePrice(usage({ inputTokens: 500_000, outputTokens: 500_000 }), { input: '0.00000001', output: '0.00000001' }).costUnits).toBe(1n);
  });

  it('keeps huge intermediates exact and enforces the final safe integer boundary', () => {
    const prices = { input: '90071992.54740991', output: '0' };
    expect(calculatePrice(usage({ inputTokens: 1_000_000, outputTokens: 0 }), prices).costUnits).toBe(MAX_SAFE_UNITS);
    expect(() => calculatePrice(usage({ inputTokens: 1_000_001, outputTokens: 0 }), prices)).toThrow(PricingError);
    const result = calculatePrice(usage({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 }), { input: '0.00000001', output: '0' });
    expect(result.costUnits).toBe((MAX_SAFE_UNITS + 500_000n) / 1_000_000n);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.buckets)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
  });
});
