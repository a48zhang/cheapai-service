import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { acquireLease, createLeaseState, renewLease } from '../../apps/worker/limits/leases';
import type { LeaseState } from '../../apps/worker/limits/leases';
import { LEASE_STORAGE_KEY, LeaseStorage, LeaseStorageError } from '../../apps/worker/limits/storage';
import type { LeaseStorageBackend } from '../../apps/worker/limits/storage';
import { testEnv } from '../helpers/database';

const input = { requestId: 'request-a', leaseToken: 'A'.repeat(43), limit: 1, ttlMs: 90_000, now: 1_000 };
const stub = () => testEnv.GATE.get(testEnv.GATE.idFromName('lease-storage-test'));

describe('native SQLite-backed DO lease storage', () => {
  it('creates no in-memory authority and restores after wrapper and DO reconstruction', async () => {
    const gate = stub();
    const saved = await runInDurableObject(gate, (_instance, ctx) => {
      expect(ctx.storage.sql.exec<{ marker: number }>('SELECT 1 AS marker').one().marker).toBe(1);
      const store = new LeaseStorage(ctx.storage);
      expect(store.read(1_000)).toEqual(createLeaseState());
      store.update(input.now, (state) => acquireLease(state, input));
      const renewed = store.update(2_000, (state) => renewLease(state, { ...input, now: 2_000 }));
      expect(new LeaseStorage(ctx.storage).read(3_000)).toEqual(renewed.state);
      expect(typeof ctx.storage.kv.get(LEASE_STORAGE_KEY)).toBe('string');
      return renewed.state;
    });
    await evictDurableObject(gate);
    expect(await runInDurableObject(gate, (_instance, ctx) => new LeaseStorage(ctx.storage).read(3_000))).toEqual(saved);
  });

  it('prunes expiry using actual supplied recovery time and saves the cleanup', async () => {
    const gate = stub();
    await runInDurableObject(gate, (_instance, ctx) => {
      new LeaseStorage(ctx.storage).update(input.now, (state) => acquireLease(state, input));
    });
    await evictDurableObject(gate);
    await runInDurableObject(gate, (_instance, ctx) => {
      const store = new LeaseStorage(ctx.storage);
      expect(store.read(90_999).leases).toHaveLength(1);
      expect(store.read(91_000)).toEqual(createLeaseState());
      expect(JSON.parse(ctx.storage.kv.get<string>(LEASE_STORAGE_KEY)!)).toEqual(createLeaseState());
      expect(new LeaseStorage(ctx.storage).read(92_000)).toEqual(createLeaseState());
    });
  });

  it('concurrent request transitions observe persisted capacity rather than stale snapshots', async () => {
    const gate = stub();
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      runInDurableObject(gate, (_instance, ctx) => new LeaseStorage(ctx.storage).update(1_000, (state) => acquireLease(state, {
        ...input, limit: 3, requestId: `request-${index}`, leaseToken: String(index).padStart(43, 'A'),
      }))),
    ));
    expect(results.filter((result) => result.granted)).toHaveLength(3);
    const restored = await runInDurableObject(gate, (_instance, ctx) => new LeaseStorage(ctx.storage).read(1_000));
    expect(restored.leases).toHaveLength(3);
    expect(new Set(restored.leases.map((lease) => lease.requestId)).size).toBe(3);
  });

  it('rolls back real storage writes when the put path throws after writing', async () => {
    await runInDurableObject(stub(), (_instance, ctx) => {
      const normal = new LeaseStorage(ctx.storage);
      normal.update(input.now, (state) => acquireLease(state, input));
      const original = ctx.storage.kv.get(LEASE_STORAGE_KEY);
      const failure = new Error('injected failure after native put');
      const backend: LeaseStorageBackend = {
        transactionSync: (callback) => ctx.storage.transactionSync(callback),
        kv: {
          get: <T>(key: string) => ctx.storage.kv.get<T>(key),
          put: <T>(key: string, value: T) => {
            ctx.storage.kv.put(key, value);
            ctx.storage.kv.put('partial-write-probe', true);
            throw failure;
          },
        },
      };
      expect(() => new LeaseStorage(backend).update(2_000, (state) => renewLease(state, { ...input, now: 2_000 }))).toThrow(failure);
      expect(ctx.storage.kv.get(LEASE_STORAGE_KEY)).toBe(original);
      expect(ctx.storage.kv.get('partial-write-probe')).toBeUndefined();
      expect(normal.read(2_000).leases[0]?.expiresAt).toBe(91_000);
    });
  });

  it('does not commit a cleanup or replacement when a transition fails', async () => {
    await runInDurableObject(stub(), (_instance, ctx) => {
      const store = new LeaseStorage(ctx.storage);
      store.update(input.now, (state) => acquireLease(state, input));
      const original = ctx.storage.kv.get(LEASE_STORAGE_KEY);
      expect(() => store.update(91_000, () => { throw new Error('transition failed'); })).toThrow('transition failed');
      expect(ctx.storage.kv.get(LEASE_STORAGE_KEY)).toBe(original);
      expect(() => store.update(1_000, () => ({ state: { schemaVersion: 2, leases: [] } as unknown as LeaseState }))).toThrow(TypeError);
      expect(ctx.storage.kv.get(LEASE_STORAGE_KEY)).toBe(original);
    });
  });

  it.each(['not json', JSON.stringify({ schemaVersion: 2, leases: [] }), 'null', JSON.stringify({ schemaVersion: 1, leases: [null] })])(
    'rejects corrupt persisted data without silently resetting it (case %#)', async (raw) => {
      await runInDurableObject(stub(), (_instance, ctx) => {
        ctx.storage.kv.put(LEASE_STORAGE_KEY, raw);
        const store = new LeaseStorage(ctx.storage);
        expect(() => store.read(1_000)).toThrow(LeaseStorageError);
        expect(() => store.update(input.now, (state) => acquireLease(state, input))).toThrow(LeaseStorageError);
        expect(ctx.storage.kv.get(LEASE_STORAGE_KEY)).toBe(raw);
      });
    },
  );

  it('rejects invalid time and async callbacks without writing state', async () => {
    await runInDurableObject(stub(), (_instance, ctx) => {
      const store = new LeaseStorage(ctx.storage);
      expect(() => store.read(NaN)).toThrow(TypeError);
      expect(() => store.update(1_000, (() => Promise.resolve({ state: createLeaseState() })) as unknown as (state: LeaseState) => { state: LeaseState })).toThrow(TypeError);
      expect(ctx.storage.kv.get(LEASE_STORAGE_KEY)).toBeUndefined();
    });
  });
});
