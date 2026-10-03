import { describe, expect, it, vi } from 'vitest';
import { decodeSnapshot, encodeSnapshot, readSnapshot, writeSnapshot } from '../../apps/worker/cache/snapshot';
import type { Snapshot } from '../../apps/worker/cache/snapshot';
import * as codec from '../../apps/worker/cache/snapshot-codec';
import * as kvAdapter from '../../apps/worker/platform/kv-snapshots';
import { DEFAULT_CONFIG } from '../../apps/worker/config';
import { testEnv } from '../helpers/database';

interface Data { balance_units: string }
const validateData = (value: unknown): value is Data => {
  if (value === null || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  return Object.keys(data).length === 1 && typeof data.balance_units === 'string' && /^-?(0|[1-9]\d*)$/.test(data.balance_units);
};
const observed = 1_788_619_000_000;
const snapshot: Snapshot<Data> = { schema_version: 1, observed_at: observed, data: { balance_units: '-9007199254740991' } };
const freshness = { now: observed, maxAgeMs: 15_000 };

describe('snapshot codec and application freshness', () => {
  it('keeps legacy exports identical to the codec and KV adapter entry points', () => {
    expect(encodeSnapshot).toBe(codec.encodeSnapshot);
    expect(decodeSnapshot).toBe(codec.decodeSnapshot);
    expect(readSnapshot).toBe(kvAdapter.readSnapshot);
    expect(writeSnapshot).toBe(kvAdapter.writeSnapshot);
    expect(kvAdapter.MIN_KV_EXPIRATION_TTL_SECONDS).toBe(60);
  });

  it('round trips exact money strings and the source observation time', () => {
    expect(decodeSnapshot(encodeSnapshot(snapshot), freshness, validateData)).toEqual(snapshot);
    expect(DEFAULT_CONFIG.balanceCacheEnabled).toBe(false);
  });

  it('expires at the exact boundary and rejects future observations', () => {
    const encoded = encodeSnapshot(snapshot);
    expect(decodeSnapshot(encoded, { ...freshness, now: observed + 14_999 }, validateData)).toEqual(snapshot);
    expect(decodeSnapshot(encoded, { ...freshness, now: observed + 15_000 }, validateData)).toBeNull();
    expect(decodeSnapshot(encoded, { ...freshness, now: observed - 1 }, validateData)).toBeNull();
  });

  it.each([null, '', '{', 'null', '[]', '{}',
    JSON.stringify({ ...snapshot, schema_version: 2 }),
    JSON.stringify({ ...snapshot, schema_version: '1' }),
    JSON.stringify({ ...snapshot, observed_at: '1788619000000' }),
    JSON.stringify({ ...snapshot, observed_at: -1 }),
    JSON.stringify({ ...snapshot, observed_at: 1.5 }),
    JSON.stringify({ ...snapshot, observed_at: Number.MAX_SAFE_INTEGER + 1 }),
    JSON.stringify({ ...snapshot, data: { balance_units: 123 } }),
    JSON.stringify({ ...snapshot, extra: true }),
  ])('treats malformed metadata or payload as miss %#', encoded => {
    expect(decodeSnapshot(encoded, freshness, validateData)).toBeNull();
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('fails closed for invalid freshness %s', maxAgeMs => {
    expect(decodeSnapshot(encodeSnapshot(snapshot), { ...freshness, maxAgeMs }, validateData)).toBeNull();
  });

  it('treats validator exceptions and unserializable payloads as misses', () => {
    expect(decodeSnapshot(encodeSnapshot(snapshot), freshness, () => { throw new Error('bad payload'); })).toBeNull();
    expect(encodeSnapshot({ ...snapshot, data: { amount: 1n } })).toBeNull();
  });
});

describe('local Workers KV backfill', () => {
  it('preserves the D1 observation time across later writes and copies', async () => {
    const delayed = { ...freshness, now: observed + 10_000 };
    expect(await writeSnapshot(testEnv.CACHE, 'v1:c12:first', snapshot, delayed, validateData)).toBe(true);
    const read = await readSnapshot(testEnv.CACHE, 'v1:c12:first', delayed, validateData);
    expect(read).toEqual(snapshot);
    expect(await writeSnapshot(testEnv.CACHE, 'v1:c12:copy', read!, { ...freshness, now: observed + 14_000 }, validateData)).toBe(true);
    expect(JSON.parse((await testEnv.CACHE.get('v1:c12:copy'))!).observed_at).toBe(observed);
    expect(await readSnapshot(testEnv.CACHE, 'v1:c12:copy', { ...freshness, now: observed + 15_000 }, validateData)).toBeNull();
    // Still physically present: application expiry is not KV deletion/replication.
    expect(await testEnv.CACHE.get('v1:c12:copy')).not.toBeNull();
  });

  it('treats missing and corrupt native KV values as misses', async () => {
    expect(await readSnapshot(testEnv.CACHE, 'v1:c12:missing', freshness, validateData)).toBeNull();
    await testEnv.CACHE.put('v1:c12:bad', '{broken');
    expect(await readSnapshot(testEnv.CACHE, 'v1:c12:bad', freshness, validateData)).toBeNull();
  });

  it('uses a platform-valid physical TTL independently of short business freshness', async () => {
    const put = vi.fn(async () => {});
    const kv = { put } as unknown as KVNamespace;
    expect(await writeSnapshot(kv, 'short', snapshot, { ...freshness, now: observed + 14_000 }, validateData)).toBe(true);
    expect(put).toHaveBeenLastCalledWith('short', encodeSnapshot(snapshot), { expirationTtl: 60 });
    expect(await writeSnapshot(kv, 'long', snapshot, { now: observed + 10_000, maxAgeMs: 120_000 }, validateData)).toBe(true);
    expect(put).toHaveBeenLastCalledWith('long', encodeSnapshot(snapshot), { expirationTtl: 110 });
  });

  it('does not write already stale data or relabel it as fresh', async () => {
    const put = vi.fn(async () => {});
    const kv = { put } as unknown as KVNamespace;
    expect(await writeSnapshot(kv, 'stale', snapshot, { ...freshness, now: observed + 15_000 }, validateData)).toBe(false);
    expect(put).not.toHaveBeenCalled();
    expect(snapshot.observed_at).toBe(observed);
  });

  it('degrades KV get failures and put 429s to misses without retries', async () => {
    const get = vi.fn(async () => { throw new Error('KV read unavailable'); });
    const put = vi.fn(async () => { throw new Error('KV PUT failed: 429'); });
    const kv = { get, put } as unknown as KVNamespace;
    expect(await readSnapshot(kv, 'key', freshness, validateData)).toBeNull();
    expect(await writeSnapshot(kv, 'key', snapshot, freshness, validateData)).toBe(false);
    expect(get).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
  });
});
