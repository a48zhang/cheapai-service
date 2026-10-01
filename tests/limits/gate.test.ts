import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GATE_RATE_STORAGE_KEY, GATE_COOLDOWN_STORAGE_KEY, MAX_COOLDOWN_TTL_MS } from '../../apps/worker/limits/gate';
import { LEASE_STORAGE_KEY, LeaseStorage } from '../../apps/worker/limits/storage';
import { testEnv } from '../helpers/database';

let now: number;
beforeEach(() => {
  now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

describe('short persisted channel cooldowns', () => {
  it('blocks acquire without consuming a lease or rate quota and expires on entry', async () => {
    const gate = gateStub();
    expect(await gate.getCooldown()).toEqual({ active: false, retryAfterMs: 0 });
    await gate.setCooldown({ ttlMs: 20_000, errorClass: 'rate_limited' });
    expect(await gate.acquire({ ...request, rate })).toEqual({ granted: false, reason: 'cooldown', retryAfterMs: 20_000 });
    await runInDurableObject(gate, (_instance, ctx) => {
      expect(ctx.storage.kv.get(LEASE_STORAGE_KEY)).toBeUndefined();
      expect(ctx.storage.kv.get(GATE_RATE_STORAGE_KEY)).toBeUndefined();
    });
    now += 20_000;
    expect((await gate.acquire({ ...request, rate })).granted).toBe(true);
    expect(await gate.getCooldown()).toEqual({ active: false, retryAfterMs: 0 });
  });

  it('restores after eviction, extends deadlines and never shortens an existing cooldown', async () => {
    const gate = gateStub();
    const first = await gate.setCooldown({ ttlMs: 20_000, errorClass: 'rate_limited' });
    await evictDurableObject(gate);
    now += 1_000;
    expect(await gate.setCooldown({ ttlMs: 5_000, errorClass: 'auth_rejected' })).toEqual({ ...first, retryAfterMs: 19_000 });
    expect(await gate.setCooldown({ ttlMs: 30_000, errorClass: 'auth_rejected' })).toEqual({ active: true, errorClass: 'auth_rejected', cooldownUntil: now + 30_000, retryAfterMs: 30_000 });
  });

  it('does not revoke an existing lease and allows its renewal/release', async () => {
    const gate = gateStub();
    const first = await gate.acquire(request);
    if (!first.granted) throw new Error('Expected lease');
    await gate.setCooldown({ ttlMs: 20_000, errorClass: 'auth_rejected' });
    expect((await gate.renew({ requestId: request.requestId, leaseToken: first.lease.leaseToken, ttlMs: 90_000 })).renewed).toBe(true);
    expect((await gate.release({ requestId: request.requestId, leaseToken: first.lease.leaseToken })).released).toBe(true);
    expect((await gate.getCooldown()).active).toBe(true);
  });

  it('uses cooldown expiry in the shared alarm without deleting a live rate window', async () => {
    const gate = gateStub();
    await gate.rateCheck(rate);
    await gate.setCooldown({ ttlMs: 10_000, errorClass: 'rate_limited' });
    expect(await runInDurableObject(gate, (_instance, ctx) => ctx.storage.getAlarm())).toBe(now + 10_000);
    now += 10_000;
    await runDurableObjectAlarm(gate);
    expect(await gate.getCooldown()).toEqual({ active: false, retryAfterMs: 0 });
    await runInDurableObject(gate, async (_instance, ctx) => {
      expect(ctx.storage.kv.get(GATE_COOLDOWN_STORAGE_KEY)).toBeUndefined();
      expect(ctx.storage.kv.get(GATE_RATE_STORAGE_KEY)).toBeDefined();
      expect(await ctx.storage.getAlarm()).toBe(now + 50_000);
    });
  });

  it('rejects invalid TTL/classes/client time and does not reset corrupt stored versions', async () => {
    await runInDurableObject(gateStub(), async (instance, ctx) => {
      for (const ttlMs of [0, -1, 0.5, Infinity, MAX_COOLDOWN_TTL_MS + 1]) {
        await expect(instance.setCooldown({ ttlMs, errorClass: 'rate_limited' })).rejects.toThrow();
      }
      await expect(instance.setCooldown({ ttlMs: 1000, errorClass: 'raw error text' as 'rate_limited' })).rejects.toThrow();
      await expect(instance.setCooldown({ ttlMs: 1000, errorClass: 'rate_limited', now: 0 } as { ttlMs: number; errorClass: 'rate_limited' })).rejects.toThrow();
      expect(ctx.storage.kv.get(GATE_COOLDOWN_STORAGE_KEY)).toBeUndefined();
      const corrupt = JSON.stringify({ schemaVersion: 2, cooldownUntil: now + 1000, errorClass: 'rate_limited' });
      ctx.storage.kv.put(GATE_COOLDOWN_STORAGE_KEY, corrupt);
      await expect(instance.getCooldown()).rejects.toThrow();
      expect(ctx.storage.kv.get(GATE_COOLDOWN_STORAGE_KEY)).toBe(corrupt);
    });
  });
});
afterEach(() => vi.restoreAllMocks());
const gateStub = () => testEnv.GATE.get(testEnv.GATE.idFromName('gate-rpc-test'));
const request = { requestId: 'request-a', limit: 1, ttlMs: 90_000 };
const rate = { operationId: 'operation-a', limit: 1, windowMs: 60_000 };

describe('Gate native binding RPC and alarms', () => {
  it('persists acquire across eviction, preserves retries and enforces capacity', async () => {
    const gate = gateStub();
    const first = await gate.acquire(request);
    expect(first.granted).toBe(true);
    if (!first.granted) throw new Error('Expected lease');
    expect(first.lease.leaseToken).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.hasOwn(first, 'state')).toBe(false);
    await evictDurableObject(gate);
    now += 1_000;
    const duplicate = await gate.acquire({ ...request, ttlMs: 180_000 });
    expect(duplicate).toEqual({ ...first, duplicate: true });
    expect(await gate.acquire({ ...request, requestId: 'request-b' })).toEqual({ granted: false, reason: 'capacity', retryAfterMs: 89_000 });
    expect(await gate.release({ requestId: request.requestId, leaseToken: first.lease.leaseToken })).toEqual({ released: true });
    expect(await gate.release({ requestId: request.requestId, leaseToken: first.lease.leaseToken })).toEqual({ released: false, reason: 'missing' });
    const second = await gate.acquire(request);
    expect(second.granted).toBe(true);
    if (second.granted) expect(second.lease.leaseToken).not.toBe(first.lease.leaseToken);
  });

  it('renews and rejects a late old-token release/renew against a replacement', async () => {
    const gate = gateStub();
    const first = await gate.acquire(request);
    if (!first.granted) throw new Error('Expected lease');
    now += 30_000;
    const renewal = await gate.renew({ requestId: request.requestId, leaseToken: first.lease.leaseToken, ttlMs: 90_000 });
    expect(renewal.renewed).toBe(true);
    if (renewal.renewed) expect(renewal.lease.expiresAt).toBe(now + 90_000);
    await gate.release({ requestId: request.requestId, leaseToken: first.lease.leaseToken });
    expect(await gate.renew({ requestId: request.requestId, leaseToken: first.lease.leaseToken, ttlMs: 90_000 })).toEqual({ renewed: false, reason: 'missing' });
    await gate.acquire(request);
    expect(await gate.renew({ requestId: request.requestId, leaseToken: first.lease.leaseToken, ttlMs: 90_000 })).toEqual({ renewed: false, reason: 'token_mismatch' });
    expect(await gate.release({ requestId: request.requestId, leaseToken: first.lease.leaseToken })).toEqual({ released: false, reason: 'token_mismatch' });
  });

  it('persists rate deduplication and resets at the exact window boundary', async () => {
    const gate = gateStub();
    expect(await gate.rateCheck(rate)).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
    await evictDurableObject(gate);
    expect(await gate.rateCheck(rate)).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
    expect(await gate.rateCheck({ ...rate, operationId: 'operation-b' })).toEqual({ allowed: false, remaining: 0, retryAfterMs: 60_000 });
    now += 60_000;
    expect(await gate.rateCheck({ ...rate, operationId: 'operation-b' })).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
  });

  it('atomically combines rate and capacity, without reserving a rate-denied lease', async () => {
    const gate = gateStub();
    const first = await gate.acquire({ ...request, rate });
    if (!first.granted) throw new Error('Expected lease');
    expect(await gate.acquire({ ...request, rate: { ...rate, operationId: 'unused-retry-id' } })).toEqual({ ...first, duplicate: true });
    await gate.release({ requestId: request.requestId, leaseToken: first.lease.leaseToken });
    expect(await gate.acquire({ ...request, requestId: 'request-b', rate: { ...rate, operationId: 'operation-b' } })).toEqual({ granted: false, reason: 'rate_limit', retryAfterMs: 60_000 });
    expect(await runInDurableObject(gate, (_instance, ctx) => new LeaseStorage(ctx.storage).read(now).leases.length)).toBe(0);
    now += 60_000;
    expect((await gate.acquire({ ...request, requestId: 'request-b', rate: { ...rate, operationId: 'operation-b' } })).granted).toBe(true);
  });

  it('deduplicates an active lease across rate-window boundaries without counting again', async () => {
    const gate = gateStub();
    const first = await gate.acquire({ ...request, rate });
    now += 60_000;
    expect(await gate.acquire({ ...request, rate })).toEqual({ ...first, duplicate: true });
    expect(await gate.rateCheck({ ...rate, operationId: 'new-window-operation' })).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
  });

  it('schedules the earliest lease/window expiry and alarm cleanup is reentrant', async () => {
    const gate = gateStub();
    await gate.acquire({ ...request, rate });
    const alarmTime = () => runInDurableObject(gate, (_instance, ctx) => ctx.storage.getAlarm());
    expect(await alarmTime()).toBe(now + 60_000);
    expect(await runDurableObjectAlarm(gate)).toBe(true);
    expect(await alarmTime()).toBe(now + 60_000);
    now += 60_000;
    await runDurableObjectAlarm(gate);
    expect(await runInDurableObject(gate, (_instance, ctx) => ctx.storage.kv.get(GATE_RATE_STORAGE_KEY))).toBeUndefined();
    expect(await alarmTime()).toBe(now + 30_000);
    now += 30_000;
    await runDurableObjectAlarm(gate);
    await runInDurableObject(gate, async (instance, ctx) => {
      await instance.alarm();
      await instance.alarm();
      expect(new LeaseStorage(ctx.storage).read(now).leases).toHaveLength(0);
      expect(await ctx.storage.getAlarm()).toBeNull();
    });
  });

  it('prunes on entry without depending on an alarm firing', async () => {
    const gate = gateStub();
    await gate.acquire(request);
    now += 90_000;
    expect((await gate.acquire({ ...request, requestId: 'request-b' })).granted).toBe(true);
  });

  it('rejects HTTP and client-supplied clocks without changing state', async () => {
    const gate = gateStub();
    expect((await gate.fetch('https://local.test/acquire', { method: 'POST', body: JSON.stringify(request) })).status).toBe(501);
    // Catch expected exceptions inside the real DO: the pool's RPC bridge also
    // reports a remotely thrown exception as an unhandled rejection.
    await runInDurableObject(gate, async (instance, ctx) => {
      await expect(instance.acquire({ ...request, now: 0 } as typeof request)).rejects.toThrow();
      await expect(instance.rateCheck({ ...rate, now: 0 } as typeof rate)).rejects.toThrow();
      expect(ctx.storage.kv.get(LEASE_STORAGE_KEY)).toBeUndefined();
    });
  });

  it('rolls back a tentative lease when rate configuration validation fails', async () => {
    const gate = gateStub();
    await gate.rateCheck(rate);
    await runInDurableObject(gate, async (instance, ctx) => {
      const originalRate = ctx.storage.kv.get(GATE_RATE_STORAGE_KEY);
      await expect(instance.acquire({ ...request, rate: { ...rate, limit: 2 } })).rejects.toThrow();
      expect(new LeaseStorage(ctx.storage).read(now).leases.length).toBe(0);
      expect(ctx.storage.kv.get(GATE_RATE_STORAGE_KEY)).toBe(originalRate);
    });
  });

  it('serializes concurrent acquisition so at most one request is granted', async () => {
    const gate = gateStub();
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => gate.acquire({ ...request, requestId: `request-${index}` })));
    expect(results.filter((result) => result.granted)).toHaveLength(1);
  });

  it('fails closed on a corrupt persisted rate version without replacing it', async () => {
    await runInDurableObject(gateStub(), async (instance, ctx) => {
      const corrupt = JSON.stringify({ version: 2, operationIds: [] });
      ctx.storage.kv.put(GATE_RATE_STORAGE_KEY, corrupt);
      await expect(instance.rateCheck(rate)).rejects.toThrow();
      await expect(instance.acquire(request)).rejects.toThrow();
      expect(ctx.storage.kv.get(GATE_RATE_STORAGE_KEY)).toBe(corrupt);
      expect(ctx.storage.kv.get(LEASE_STORAGE_KEY)).toBeUndefined();
    });
  });

  it('rejects forged release and renewal clocks without changing a live lease', async () => {
    const gate = gateStub();
    const first = await gate.acquire(request);
    if (!first.granted) throw new Error('Expected lease');
    await runInDurableObject(gate, async (instance, ctx) => {
      const identity = { requestId: request.requestId, leaseToken: first.lease.leaseToken };
      await expect(instance.release({ ...identity, now: now + 1_000_000 } as typeof identity)).rejects.toThrow();
      await expect(instance.renew({ ...identity, ttlMs: 90_000, now: 0 } as typeof identity & { ttlMs: number })).rejects.toThrow();
      expect(new LeaseStorage(ctx.storage).read(now).leases[0]).toEqual(first.lease);
    });
  });

  it('rolls lease, rate and alarm back together when the transaction aborts after scheduling', async () => {
    await runInDurableObject(gateStub(), async (instance, ctx) => {
      const nativeTransaction = ctx.storage.transaction.bind(ctx.storage);
      const spy = vi.spyOn(ctx.storage, 'transaction').mockImplementation((closure) =>
        nativeTransaction(async (txn) => {
          await closure(txn);
          throw new Error('injected transaction failure after alarm scheduling');
        }),
      );
      try {
        await expect(instance.acquire({ ...request, rate })).rejects.toThrow('injected transaction failure');
      } finally {
        spy.mockRestore();
      }
      expect(ctx.storage.kv.get(LEASE_STORAGE_KEY)).toBeUndefined();
      expect(ctx.storage.kv.get(GATE_RATE_STORAGE_KEY)).toBeUndefined();
      expect(await ctx.storage.getAlarm()).toBeNull();
      expect((await instance.acquire({ ...request, rate })).granted).toBe(true);
    });
  });

  it('peeks quota before expensive work without creating or consuming an operation', async () => {
    const gate = gateStub();
    for (let index = 0; index < 3; index++) {
      expect(await gate.ratePeek({ limit: 1, windowMs: 60_000 })).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 });
    }
    expect(await runInDurableObject(gate, (_instance, ctx) => ctx.storage.kv.get(GATE_RATE_STORAGE_KEY))).toBeUndefined();
    await gate.rateCheck(rate);
    const raw = await runInDurableObject(gate, (_instance, ctx) => ctx.storage.kv.get(GATE_RATE_STORAGE_KEY));
    now += 1_000;
    expect(await gate.ratePeek({ limit: 1, windowMs: 60_000 })).toEqual({ allowed: false, remaining: 0, retryAfterMs: 59_000 });
    expect(await runInDurableObject(gate, (_instance, ctx) => ctx.storage.kv.get(GATE_RATE_STORAGE_KEY))).toBe(raw);
    await evictDurableObject(gate);
    expect((await gate.ratePeek({ limit: 1, windowMs: 60_000 })).allowed).toBe(false);
    now += 59_000;
    expect(await gate.ratePeek({ limit: 1, windowMs: 60_000 })).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 });
  });

  it('peek rejects forged clocks and inconsistent active-window settings', async () => {
    await runInDurableObject(gateStub(), async (instance) => {
      await instance.rateCheck(rate);
      await expect(instance.ratePeek({ limit: 2, windowMs: 60_000 })).rejects.toThrow();
      await expect(instance.ratePeek({ limit: 1, windowMs: 60_000, now: 0 } as { limit: number; windowMs: number })).rejects.toThrow();
    });
  });
});
