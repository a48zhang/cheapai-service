import { beforeEach, describe, expect, it, vi } from 'vitest';
import { priceCacheKey, readPrices } from '../../apps/worker/cache/prices';
import { encodeSnapshot } from '../../apps/worker/cache/snapshot';
import { prepare } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const modelId = 'c14/model';
const now = 1_788_619_000_000;
const data = { public_model_id: modelId, price_version: 3, sell_prices: { input: '1.25', output: '2.50', cacheRead: '0' } };
const snapshot = { schema_version: 1 as const, observed_at: now, data };

beforeEach(async () => {
  await prepare(testEnv.DB, `INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES (?,'active',?,3,0,4096,?,?)`, [modelId, JSON.stringify(data.sell_prices), now, now]).run();
});

describe('price configuration cache on native D1/KV', () => {
  it('fills from D1 preserving price version and exact rate strings', async () => {
    const result = await readPrices(testEnv.DB, testEnv.CACHE, modelId, { now: () => now });
    expect(result).toEqual({ snapshot, source: 'd1', requiresAuthoritativeVersionCheck: true });
    expect(JSON.parse((await testEnv.CACHE.get(priceCacheKey(modelId)))!)).toEqual(snapshot);
    expect(Object.hasOwn(result!.snapshot.data.sell_prices, 'reasoning')).toBe(false);
  });

  it('returns a fresh matching version without an extra configuration query', async () => {
    await testEnv.CACHE.put(priceCacheKey(modelId), encodeSnapshot(snapshot)!);
    const database = { prepare: vi.fn(() => { throw new Error('Unexpected D1 read'); }) } as unknown as D1Database;
    const result = await readPrices(database, testEnv.CACHE, modelId, { now: () => now + 59_999, expectedPriceVersion: 3 });
    expect(result).toEqual({ snapshot, source: 'cache', requiresAuthoritativeVersionCheck: true });
    expect(database.prepare).not.toHaveBeenCalled();
  });

  it('refreshes an expired snapshot at the exact application boundary', async () => {
    await testEnv.CACHE.put(priceCacheKey(modelId), encodeSnapshot(snapshot)!);
    const result = await readPrices(testEnv.DB, testEnv.CACHE, modelId, { now: () => now + 60_000 });
    expect(result?.source).toBe('d1');
    expect(result?.snapshot.observed_at).toBe(now + 60_000);
    expect(result?.snapshot.data.price_version).toBe(3);
  });

  it('reloads when final admission supplies a changed price version', async () => {
    await testEnv.CACHE.put(priceCacheKey(modelId), encodeSnapshot(snapshot)!);
    await prepare(testEnv.DB, 'UPDATE models SET price_version=?,sell_prices_json=? WHERE public_model_id=?',
      [4, JSON.stringify({ input: '3', output: '4' }), modelId]).run();
    const result = await readPrices(testEnv.DB, testEnv.CACHE, modelId, { now: () => now + 1, expectedPriceVersion: 4 });
    expect(result?.source).toBe('d1');
    expect(result?.snapshot.data).toEqual({ public_model_id: modelId, price_version: 4, sell_prices: { input: '3', output: '4' } });
    expect(snapshot.data.price_version).toBe(3);
  });

  it.each([
    { ...data, public_model_id: 'another/model' }, { ...data, price_version: 0 },
    { ...data, sell_prices: { input: '1' } }, { ...data, sell_prices: { input: 1, output: '2' } },
    { ...data, sell_prices: { input: '-1', output: '2' } },
  ])('rejects corrupt or incorrectly scoped payload %#', async invalid => {
    await testEnv.CACHE.put(priceCacheKey(modelId), encodeSnapshot({ ...snapshot, data: invalid })!);
    const result = await readPrices(testEnv.DB, testEnv.CACHE, modelId, { now: () => now });
    expect(result?.source).toBe('d1');
    expect(result?.snapshot.data).toEqual(data);
  });

  it('uses D1 during KV failure and tolerates failed backfill with read-start time intact', async () => {
    const kv = { get: async () => { throw new Error('KV down'); }, put: vi.fn(async () => { throw new Error('429'); }) } as unknown as KVNamespace;
    const clock = vi.fn().mockReturnValueOnce(now).mockReturnValueOnce(now + 1).mockReturnValue(now + 2000);
    const result = await readPrices(testEnv.DB, kv, modelId, { now: clock });
    expect(result?.source).toBe('d1');
    expect(result?.snapshot.observed_at).toBe(now + 1);
    expect(kv.put).toHaveBeenCalledTimes(1);
  });

  it('does not serve expired prices if D1 is unavailable', async () => {
    await testEnv.CACHE.put(priceCacheKey(modelId), encodeSnapshot(snapshot)!);
    const database = { prepare: () => { throw new Error('D1 private error'); } } as unknown as D1Database;
    await expect(readPrices(database, testEnv.CACHE, modelId, { now: () => now + 60_000 })).rejects.toMatchObject({ code: 'service_unavailable' });
  });

  it('returns null for absent or disabled authoritative models', async () => {
    expect(await readPrices(testEnv.DB, testEnv.CACHE, 'missing', { now: () => now })).toBeNull();
    await prepare(testEnv.DB, "UPDATE models SET status='disabled' WHERE public_model_id=?", [modelId]).run();
    expect(await readPrices(testEnv.DB, testEnv.CACHE, modelId, { now: () => now })).toBeNull();
  });
});
