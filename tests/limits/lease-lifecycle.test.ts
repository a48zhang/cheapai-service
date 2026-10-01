import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireDualLease } from '../../apps/worker/limits/dual-lease';
import type { DualLeasePermit } from '../../apps/worker/limits/dual-lease';
import { startLeaseLifecycle } from '../../apps/worker/limits/lease-lifecycle';
import type { LeaseScheduler } from '../../apps/worker/limits/lease-lifecycle';
import { LeaseStorage } from '../../apps/worker/limits/storage';
import { testEnv } from '../helpers/database';

let now: number;
beforeEach(() => { now = 1_800_000_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now); });
afterEach(() => vi.restoreAllMocks());
class ManualScheduler implements LeaseScheduler {
  readonly timers = new Map<number, { at: number; callback: () => void | Promise<void> }>();
  next = 1;
  schedule(callback: () => void | Promise<void>, delayMs: number): number {
    const id = this.next++;
    this.timers.set(id, { at: now + delayMs, callback });
    return id;
  }
  cancel(handle: unknown): void { this.timers.delete(handle as number); }
  fire(): Promise<void>[] {
    const due = [...this.timers].filter(([, task]) => task.at <= now).sort((a, b) => a[1].at - b[1].at);
    return due.map(([id, task]) => {
      this.timers.delete(id);
      return Promise.resolve(task.callback());
    });
  }
}
async function pair(userTtlMs = 90_000, channelTtlMs = 90_000): Promise<DualLeasePermit> {
  const result = await acquireDualLease(testEnv.GATE, { userId: 'user-1', channelId: 'channel-1', requestId: 'request-1', user: { limit: 1, ttlMs: userTtlMs }, channel: { limit: 1, ttlMs: channelTtlMs } });
  if (!result.granted) throw new Error('Expected pair');
  return result.lease;
}
const active = (name: string) => runInDurableObject(testEnv.GATE.get(testEnv.GATE.idFromName(name)), (_instance, ctx) => new LeaseStorage(ctx.storage).read(now).leases);

describe('owned dual lease renewal lifecycle', () => {
  it('renews both native DO leases repeatedly and closes only once', async () => {
    const permit = await pair();
    const scheduler = new ManualScheduler();
    const release = vi.fn(() => permit.release());
    const lifecycle = startLeaseLifecycle({ ...permit, release }, { scheduler, clock: () => now });
    expect(scheduler.timers.size).toBe(2);
    for (let iteration = 0; iteration < 2; iteration++) {
      now += 30_000;
      await Promise.all(scheduler.fire());
      expect(lifecycle.signal.aborted).toBe(false);
      expect(lifecycle.snapshot().expiresAt).toBe(now + 90_000);
      expect((await active('user:user-1'))[0]?.expiresAt).toBe(now + 90_000);
      expect((await active('channel:channel-1'))[0]?.expiresAt).toBe(now + 90_000);
      expect(scheduler.timers.size).toBe(2);
    }
    const [first, second] = await Promise.all([lifecycle.close(), lifecycle.close()]);
    expect(first).toBe(second);
    expect(first.complete).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(scheduler.timers.size).toBe(0);
    expect(await active('user:user-1')).toHaveLength(0);
    expect(await active('channel:channel-1')).toHaveLength(0);
  });

  it('aborts immediately on one renewal rejection and releases the other subject', async () => {
    const permit = await pair();
    const scheduler = new ManualScheduler();
    await permit.channel.client.release(permit.channel.handle);
    const lifecycle = startLeaseLifecycle(permit, { scheduler, clock: () => now });
    now += 30_000;
    await Promise.all(scheduler.fire());
    expect(lifecycle.signal.aborted).toBe(true);
    expect(lifecycle.snapshot().reason).toBe('renewal_failed');
    expect((await lifecycle.close()).complete).toBe(true);
    expect(await active('user:user-1')).toHaveLength(0);
    expect(scheduler.timers.size).toBe(0);
  });

  it('the safety watchdog cancels even while a renewal RPC is still unresolved', async () => {
    const permit = await pair();
    const scheduler = new ManualScheduler();
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    const nativeRenew = permit.channel.client.renew.bind(permit.channel.client);
    vi.spyOn(permit.channel.client, 'renew').mockImplementation(async (handle, ttl) => { await blocked; return nativeRenew(handle, ttl); });
    const lifecycle = startLeaseLifecycle(permit, { scheduler, clock: () => now });
    now += 30_000;
    const pending = scheduler.fire();
    await Promise.resolve();
    expect(lifecycle.snapshot().renewing).toBe(true);
    now += 50_000;
    await Promise.all(scheduler.fire());
    expect(lifecycle.signal.aborted).toBe(true);
    expect(lifecycle.snapshot().reason).toBe('lease_unsafe');
    expect((await lifecycle.close()).complete).toBe(true);
    finish();
    await Promise.all(pending);
    expect(scheduler.timers.size).toBe(0);
    expect(await active('channel:channel-1')).toHaveLength(0);
    expect(await active('user:user-1')).toHaveLength(0);
  });

  it('caller cancellation clears timers and exposes uncertain cleanup without a second release', async () => {
    const permit = await pair();
    const scheduler = new ManualScheduler();
    const controller = new AbortController();
    const release = vi.fn(async () => { throw new Error('unconfirmed release'); });
    const lifecycle = startLeaseLifecycle({ ...permit, release }, { scheduler, clock: () => now, signal: controller.signal });
    controller.abort();
    const report = await lifecycle.close();
    expect(lifecycle.snapshot().reason).toBe('cancelled');
    expect(report.complete).toBe(false);
    expect(report.outcomes.every((outcome) => outcome.status === 'uncertain')).toBe(true);
    expect(lifecycle.snapshot().cleanup).toBe(report);
    await lifecycle.close();
    expect(release).toHaveBeenCalledTimes(1);
    expect(scheduler.timers.size).toBe(0);
    await permit.release(); // Explicit owner recovery is separate from close's once-only release.
  });

  it('does not renew when the initial permit is already at its safety boundary', async () => {
    const permit = await pair();
    const scheduler = new ManualScheduler();
    const userRenew = vi.spyOn(permit.user.client, 'renew');
    now += 80_000;
    const lifecycle = startLeaseLifecycle(permit, { scheduler, clock: () => now });
    expect(lifecycle.signal.aborted).toBe(true);
    expect(lifecycle.snapshot().reason).toBe('lease_unsafe');
    expect((await lifecycle.close()).complete).toBe(true);
    expect(userRenew).not.toHaveBeenCalled();
    expect(scheduler.timers.size).toBe(0);
  });

  it('rejects regressing clocks and never leaves a timer loop after closure', async () => {
    const permit = await pair();
    const scheduler = new ManualScheduler();
    let reading = now;
    const lifecycle = startLeaseLifecycle(permit, { scheduler, clock: () => reading });
    now += 30_000;
    reading -= 1;
    await Promise.all(scheduler.fire());
    expect(lifecycle.snapshot().reason).toBe('clock_regression');
    await lifecycle.close();
    expect(scheduler.timers.size).toBe(0);
    now += 1_000_000;
    expect(scheduler.fire()).toHaveLength(0);
  });

  it('invalid timing controls throw before taking ownership', async () => {
    const permit = await pair();
    const scheduler = new ManualScheduler();
    for (const options of [{ ttlMs: 0 }, { renewIntervalMs: -1 }, { safetyMarginMs: 60_000 }, { ttlMs: Infinity }]) {
      expect(() => startLeaseLifecycle(permit, { ...options, scheduler })).toThrow(TypeError);
    }
    expect(scheduler.timers.size).toBe(0);
    await permit.release();
  });

  it('uses the actual short lease and elapsed time rather than inventing a fresh default TTL', async () => {
    const permit = await pair(30_000, 90_000);
    const scheduler = new ManualScheduler();
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    const nativeRenew = permit.user.client.renew.bind(permit.user.client);
    vi.spyOn(permit.user.client, 'renew').mockImplementation(async (handle, ttl) => { await blocked; return nativeRenew(handle, ttl); });
    now += 15_000; // Time spent obtaining/returning the permit is already consumed.
    const lifecycle = startLeaseLifecycle(permit, { scheduler, clock: () => now });
    const times = [...scheduler.timers.values()].map((timer) => timer.at).sort((a, b) => a - b);
    expect(times).toEqual([now, now + 5_000]);
    const pending = scheduler.fire();
    now += 5_000;
    await Promise.all(scheduler.fire());
    expect(lifecycle.snapshot().reason).toBe('lease_unsafe');
    await lifecycle.close();
    finish();
    await Promise.all(pending);
    expect(scheduler.timers.size).toBe(0);
    expect(await active('user:user-1')).toHaveLength(0);
  });

  it('a transport failure cancels without waiting for the other unresolved renewal', async () => {
    const permit = await pair();
    const scheduler = new ManualScheduler();
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    const nativeRenew = permit.user.client.renew.bind(permit.user.client);
    vi.spyOn(permit.user.client, 'renew').mockImplementation(async (handle, ttl) => { await blocked; return nativeRenew(handle, ttl); });
    vi.spyOn(permit.channel.client, 'renew').mockRejectedValue(new Error('injected lost connection'));
    const lifecycle = startLeaseLifecycle(permit, { scheduler, clock: () => now });
    now += 30_000;
    const pending = scheduler.fire();
    for (let index = 0; index < 4; index++) await Promise.resolve();
    expect(lifecycle.signal.aborted).toBe(true);
    expect(lifecycle.snapshot().reason).toBe('renewal_failed');
    await lifecycle.close();
    finish();
    await Promise.all(pending);
    expect(scheduler.timers.size).toBe(0);
  });

  it('scheduler failure cleans up an already-created timer and stops ownership', async () => {
    const permit = await pair();
    const scheduler = new ManualScheduler();
    const nativeSchedule = scheduler.schedule.bind(scheduler);
    let schedules = 0;
    vi.spyOn(scheduler, 'schedule').mockImplementation((callback, delayMs) => {
      if (++schedules === 2) throw new Error('injected scheduling failure');
      return nativeSchedule(callback, delayMs);
    });
    const lifecycle = startLeaseLifecycle(permit, { scheduler, clock: () => now });
    expect(lifecycle.snapshot().reason).toBe('scheduler_failed');
    expect(scheduler.timers.size).toBe(0);
    expect((await lifecycle.close()).complete).toBe(true);
  });
});
