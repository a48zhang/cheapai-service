import { describe, expect, it, vi } from 'vitest';
import { buildSettlementFingerprint, canonicalJson, createPriceSnapshot, readPriceSnapshot, FingerprintError } from '../../apps/worker/billing/fingerprint';
import type { PriceSnapshotInput, SettlementFacts } from '../../apps/worker/billing/fingerprint';
import type { UsageSnapshot } from '../../packages/apicompat/types/shared';

// Original synthetic facts. These tests perform no DB writes or provider calls.
const priceInput = (): PriceSnapshotInput => ({ publicModelId: 'public-model', upstreamModel: 'provider-model', upstreamProtocol: 'chat', priceVersion: 1, sellPrices: { input: '1', output: '2' } });
const usage = (): UsageSnapshot => ({ quality: 'complete', protocol: 'chat',
  counts: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  semantics: { cacheRead: 'included_in_input', cacheWrite: 'included_in_input', reasoning: 'included_in_output', cacheWriteTtl: 'subsets_of_cache_write' },
  sources: [{ protocol: 'chat', path: 'usage', raw: { prompt_tokens: 1000, completion_tokens: 500 } }], issues: [],
});
const facts = (): SettlementFacts => ({ kind: 'consumption', operationId: 'consume-request-one', userId: 'user-one', requestId: 'request-one',
  priceSnapshotJson: createPriceSnapshot(priceInput()).json, usage: usage(), deltaUnits: '-200000', createdBy: null, reason: null,
});

describe('canonical JSON version 1', () => {
  it('sorts keys ordinally including integer-like and non-ASCII keys', () => {
    const input = { z: [3, 1, 2], '2': 2, '10': 10, ä: 'accent', a: 'lower', Z: 'upper', A: null };
    expect(canonicalJson(input)).toBe('{"10":10,"2":2,"A":null,"Z":"upper","a":"lower","z":[3,1,2],"ä":"accent"}');
    expect(canonicalJson({ b: { d: 4, c: 3 }, a: 1 })).toBe(canonicalJson({ a: 1, b: { c: 3, d: 4 } }));
  });

  it('preserves array ordering, null, Unicode and shared non-cyclic objects', () => {
    const shared = { x: '中文🧪\n"\\', y: null };
    expect(canonicalJson([shared, shared])).toBe(`[${canonicalJson(shared)},${canonicalJson(shared)}]`);
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    const emptyPrototype = Object.create(null) as Record<string, unknown>;
    emptyPrototype.__proto__ = { x: 1 };
    expect(canonicalJson(emptyPrototype)).toBe('{"__proto__":{"x":1}}');
  });

  it.each([undefined, NaN, Infinity, -Infinity, 1n, () => 1, Symbol('x'), { value: undefined }, { value: NaN }, [undefined], new Date(), new Map(), new Set()])('rejects non-JSON value %#', input => {
    expect(() => canonicalJson(input)).toThrow(FingerprintError);
  });

  it('rejects cycles, accessors, classes, custom serializers and sparse/extended arrays without executing user code', () => {
    let invoked = false;
    const getter = Object.defineProperty({}, 'x', { enumerable: true, get: () => { invoked = true; return 1; } });
    class Custom { get x() { invoked = true; return 1; } }
    const serializer = { toJSON() { invoked = true; return {}; } };
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const array = [1] as number[] & { extra?: string }; array.extra = 'extra';
    const nonenumerable = Object.defineProperty({}, 'hidden', { value: 1 });
    const symbolKey = { [Symbol('hidden')]: 1 };
    for (const value of [getter, new Custom(), serializer, cycle, new Array(1), array, nonenumerable, symbolKey]) expect(() => canonicalJson(value)).toThrow(FingerprintError);
    expect(invoked).toBe(false);
  });

  it('enforces bounded JSON and rejects unsupported canonicalization versions', () => {
    let deep: unknown = null;
    for (let index = 0; index < 70; index++) deep = { child: deep };
    for (const value of [deep, new Array(100_001).fill(0), '中'.repeat(400_000)]) {
      expect(() => canonicalJson(value)).toThrow('json_too_large');
    }
    expect(() => canonicalJson({}, 2)).toThrow('unsupported_version');
  });
});

describe('immutable stored price snapshots', () => {
  it('uses the real PriceTable and fixed units, versions and rounding', () => {
    const stored = createPriceSnapshot(priceInput());
    expect(stored.snapshot).toEqual({ schema_version: 1, canonical_json_version: 1, calculation_version: 1,
      currency: 'USD', decimals: 8, tokens_per_price_unit: 1_000_000, rounding: 'half_up_after_sum',
      public_model_id: 'public-model', upstream_model: 'provider-model', upstream_protocol: 'chat', price_version: 1,
      sell_prices: { input: '1', output: '2' } });
    expect(stored.json).toBe(canonicalJson(stored.snapshot));
    expect(readPriceSnapshot(stored.json)).toEqual(stored);
  });

  it('creates identical bytes from reordered facts and keeps earlier prices after model changes', () => {
    const mutablePrices = { input: '1', output: '2', cacheRead: '0' };
    const first = createPriceSnapshot({ ...priceInput(), sellPrices: mutablePrices });
    const reordered = createPriceSnapshot({ sellPrices: { cacheRead: '0', output: '2', input: '1' }, priceVersion: 1, upstreamProtocol: 'chat', upstreamModel: 'provider-model', publicModelId: 'public-model' });
    expect(first.json).toBe(reordered.json);
    mutablePrices.input = '100';
    expect(first.snapshot.sell_prices.input).toBe('1');
    expect(readPriceSnapshot(first.json).snapshot.sell_prices.input).toBe('1');
    expect(Object.hasOwn(first.snapshot.sell_prices, 'cacheWrite')).toBe(false);
    expect(createPriceSnapshot({ ...priceInput(), priceVersion: 2 }).json).not.toBe(first.json);
  });

  it('validates old stored text without silently reordering or removing its whitespace', () => {
    const original = ` \n${JSON.stringify(createPriceSnapshot(priceInput()).snapshot, null, 2)}\n`;
    const loaded = readPriceSnapshot(original);
    expect(loaded.json).toBe(original);
    expect(loaded.json).not.toBe(canonicalJson(loaded.snapshot));
    expect(loaded.snapshot.price_version).toBe(1);
  });

  it('stores optional group and multiplier facts without changing legacy snapshot versions', () => {
    const stored = createPriceSnapshot({ ...priceInput(), groupId: 'group-one', groupVersion: 7, billingMultiplier: '0.2' });
    expect(stored.snapshot).toMatchObject({ group_id: 'group-one', group_version: 7, billing_multiplier: '0.2', schema_version: 1, calculation_version: 1 });
    expect(readPriceSnapshot(stored.json)).toEqual(stored);
    const legacy = createPriceSnapshot(priceInput());
    expect(JSON.parse(legacy.json)).not.toHaveProperty('billing_multiplier');
    expect(readPriceSnapshot(legacy.json).json).toBe(legacy.json);
  });

  it('rejects incomplete, unsupported-version or malformed snapshots instead of assuming free prices', () => {
    for (const sellPrices of [{}, { input: '1' }, { input: '1', output: 0 }, { input: '1', output: '2', cacheRead: undefined }, { input: '-1', output: '2' }, { input: '0.000000001', output: '2' }, { input: '1', output: '2', extra: '3' }]) {
      expect(() => createPriceSnapshot({ ...priceInput(), sellPrices } as unknown as PriceSnapshotInput)).toThrow(FingerprintError);
    }
    const snapshot = createPriceSnapshot(priceInput()).snapshot;
    for (const patch of [{ schema_version: 2 }, { calculation_version: 2 }, { canonical_json_version: 2 }, { currency: 'EUR' }, { decimals: 2 }, { tokens_per_price_unit: 1000 }, { rounding: 'per_bucket' }, { price_version: 0 }, { sell_prices: {} }, { extra: 'ignored?' }]) {
      expect(() => readPriceSnapshot(JSON.stringify({ ...snapshot, ...patch }))).toThrow(FingerprintError);
    }
    for (const json of ['{', 'null', '[]']) expect(() => readPriceSnapshot(json)).toThrow(FingerprintError);
  });
});

describe('SHA-256 settlement fingerprints', () => {
  it('matches a fixed SHA-256 vector independently calculated with Node createHash', async () => {
    const input: SettlementFacts = { kind: 'grant', operationId: 'op-fixture', userId: 'user-fixture', requestId: null,
      priceSnapshotJson: null, usage: null, deltaUnits: '200', createdBy: 'admin-fixture', reason: 'Synthetic grant' };
    const result = await buildSettlementFingerprint(input);
    expect(result.fingerprint).toMatch(/^sha256:v1:[0-9a-f]{64}$/);
    expect(result.fingerprint).toBe('sha256:v1:9711418ceab191f449ce51fbb4c24e99b8ca720289ab4805c64ea5e80595b4b2');
    expect(result).toMatchObject({ version: 1, deltaUnits: '200', priceSnapshotJson: null, usageSnapshotJson: null });
  });

  it('normalizes object key order and bigint/string amounts while ignoring retry clocks', async () => {
    const input = facts();
    const first = await buildSettlementFingerprint(input);
    const originalUsage = usage();
    const reorderedUsage = JSON.parse(canonicalJson(originalUsage)) as UsageSnapshot;
    const reordered = { reason: null, createdBy: null, deltaUnits: -200000n, usage: reorderedUsage,
      priceSnapshotJson: input.priceSnapshotJson, requestId: 'request-one', userId: 'user-one', operationId: 'consume-request-one', kind: 'consumption' } as const;
    vi.useFakeTimers(); vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const retry = await buildSettlementFingerprint(reordered);
    expect(retry).toEqual(first);
    expect(first.usageSnapshotJson).toBe(canonicalJson(originalUsage));
    expect(first.priceSnapshotJson).toBe(input.priceSnapshotJson);
  });

  it('binds every identity, amount, original price and full usage fact', async () => {
    const original = facts();
    const first = await buildSettlementFingerprint(original);
    const variants: SettlementFacts[] = [
      { ...original, operationId: 'another-operation' }, { ...original, userId: 'another-user' }, { ...original, requestId: 'another-request' },
      { ...original, deltaUnits: '-200001' }, { ...original, createdBy: 'admin-one' }, { ...original, reason: 'Reconciled usage' },
      { ...original, kind: 'adjustment', createdBy: 'admin-one', reason: 'Correction' },
      { ...original, priceSnapshotJson: createPriceSnapshot({ ...priceInput(), priceVersion: 2 }).json },
      { ...original, priceSnapshotJson: createPriceSnapshot({ ...priceInput(), sellPrices: { input: '1.1', output: '2' } }).json },
      { ...original, priceSnapshotJson: createPriceSnapshot({ ...priceInput(), upstreamModel: 'different-upstream' }).json },
      { ...original, priceSnapshotJson: createPriceSnapshot({ ...priceInput(), publicModelId: 'different-public-model' }).json },
    ];
    const changedCount = usage();
    if (changedCount.quality !== 'complete') throw new Error('Expected synthetic complete usage');
    variants.push({ ...original, usage: { ...changedCount, counts: { ...changedCount.counts, outputTokens: 501 } } });
    variants.push({ ...original, usage: { ...changedCount, sources: [{ protocol: 'chat', path: 'different.usage' }] } });
    variants.push({ ...original, usage: { ...changedCount, sources: [{ protocol: 'chat', path: 'usage', raw: { prompt_tokens: 1000, completion_tokens: 500, cache_hit: true } }] } });
    variants.push({ ...original, usage: { ...changedCount, counts: { ...changedCount.counts, cacheReadTokens: 10 } } });
    variants.push({ ...original, usage: { ...changedCount, counts: { ...changedCount.counts, reasoningTokens: 10 } } });
    for (const variant of variants) expect((await buildSettlementFingerprint(variant)).fingerprint).not.toBe(first.fingerprint);
  });

  it('hashes and returns the exact saved price text required by the D13 equality guard', async () => {
    const input = facts();
    const canonical = await buildSettlementFingerprint(input);
    const storedText = ` ${JSON.stringify(readPriceSnapshot(input.priceSnapshotJson!).snapshot, null, 2)}\n`;
    const originalText = await buildSettlementFingerprint({ ...input, priceSnapshotJson: storedText });
    expect(originalText.priceSnapshotJson).toBe(storedText);
    // Logical prices are equal but stored artifacts differ; never merge their identities.
    expect(originalText.fingerprint).not.toBe(canonical.fingerprint);
  });

  it('accepts explicit zero consumption and bounded negative/positive administrative adjustments', async () => {
    expect((await buildSettlementFingerprint({ ...facts(), deltaUnits: 0n })).deltaUnits).toBe('0');
    for (const deltaUnits of ['-9007199254740991', '0', '9007199254740991']) {
      const result = await buildSettlementFingerprint({ ...facts(), kind: 'adjustment', requestId: null, priceSnapshotJson: null, usage: null, deltaUnits, createdBy: 'admin-one', reason: 'Synthetic correction' });
      expect(result.deltaUnits).toBe(deltaUnits);
    }
  });

  it('rejects numeric/unsafe amounts, missing facts, invalid usage and clock fields', async () => {
    for (const patch of [
      { deltaUnits: -200000 }, { deltaUnits: '0.1' }, { deltaUnits: '01' }, { deltaUnits: '-0' }, { deltaUnits: '-9007199254740992' }, { deltaUnits: 9007199254740992n },
      { deltaUnits: '1' }, { requestId: null }, { priceSnapshotJson: null }, { usage: null }, { usage: { quality: 'missing', protocol: 'chat' } },
      { userId: '' }, { kind: 'unknown' }, { now: 123 }, { retryCount: 1 }, { reason: undefined },
      { kind: 'grant', deltaUnits: '0', createdBy: 'admin-one', reason: 'Synthetic grant' },
      { kind: 'adjustment', createdBy: null, reason: 'Synthetic adjustment' },
      { kind: 'adjustment', createdBy: 'admin-one', reason: ' ' },
    ]) await expect(buildSettlementFingerprint({ ...facts(), ...patch } as unknown as SettlementFacts)).rejects.toBeInstanceOf(FingerprintError);
    const withInvalidRaw = usage();
    if (withInvalidRaw.quality !== 'complete') throw new Error('Expected synthetic complete usage');
    await expect(buildSettlementFingerprint({ ...facts(), usage: { ...withInvalidRaw, sources: [{ protocol: 'chat', path: 'usage', raw: { invalid: undefined } }] } } as unknown as SettlementFacts)).rejects.toBeInstanceOf(FingerprintError);
    const mutable: Record<string, unknown> = { ...facts() }; delete mutable.operationId;
    await expect(buildSettlementFingerprint(mutable as unknown as SettlementFacts)).rejects.toThrow('invalid_facts');
  });
});
