import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireDualLease } from '../../apps/worker/limits/dual-lease';
import type { DualLeaseInput } from '../../apps/worker/limits/dual-lease';
import type { LeaseBinding } from '../../apps/worker/limits/client';
import type { GateAcquireResult } from '../../apps/worker/limits/gate';
import { LeaseStorage } from '../../apps/worker/limits/storage';
import { testEnv } from '../helpers/database';

let now: number;
beforeEach(() => { now = 1_800_000_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now); });
afterEach(() => vi.restoreAllMocks());
const input: DualLeaseInput = { userId: 'user-1', channelId: 'channel-1', requestId: 'request-1', user: { limit: 1, ttlMs: 90_000 }, channel: { limit: 1, ttlMs: 90_000 } };
const active = (name: string) => runInDurableObject(testEnv.GATE.get(testEnv.GATE.idFromName(name)), (_instance, ctx) => new LeaseStorage(ctx.storage).read(now).leases.length);

function bindingHooks(hooks: {
  beforeAcquire?: (name: string) => Promise<void> | void;
  afterAcquire?: (name: string, result: GateAcquireResult) => Promise<void> | void;
  beforeRelease?: (name: string) => Promise<void> | void;
} = {}): LeaseBinding {
  const names = new Map<string, string>();
  return {
    idFromName(name) { const id = testEnv.GATE.idFromName(name); names.set(id.toString(), name); return id; },
    get(id) {
      const native = testEnv.GATE.get(id);
      const name = names.get(id.toString())!;
      return {
        async acquire(args) {
          await hooks.beforeAcquire?.(name);
          const result = await native.acquire(args);
          try { await hooks.afterAcquire?.(name, result); return result; }
          catch (error) {
            const dispose = (Symbol as SymbolConstructor & { readonly dispose: symbol }).dispose;
            (result as unknown as Record<symbol, () => void>)[dispose]?.();
            throw error;
          }
        },
        renew: (args) => native.renew(args),
        async release(args) { await hooks.beforeRelease?.(name); return native.release(args); },
      };
    },
  };
}

describe('dual subject lease compensation through native Gate DOs', () => {
  it('acquires user before channel, exposes L10 handles and coalesces release calls', async () => {
    const order: string[] = [];
    const releases: string[] = [];
    const result = await acquireDualLease(bindingHooks({ afterAcquire: (name) => { order.push(name); }, beforeRelease: (name) => { releases.push(name); } }), input);
    if (!result.granted) throw new Error('Expected pair');
    expect(order).toEqual(['user:user-1', 'channel:channel-1']);
    expect(result.lease.user.handle.subject.kind).toBe('user');
    expect(result.lease.channel.handle.subject.kind).toBe('channel');
    expect(Object.isFrozen(result.lease)).toBe(true);
    const [first, second] = await Promise.all([result.lease.release(), result.lease.release()]);
    expect(first).toBe(second);
    expect(first.complete).toBe(true);
    expect(releases).toEqual(['channel:channel-1', 'user:user-1']);
    await result.lease.release();
    expect(releases).toHaveLength(2);
    expect(await active('user:user-1')).toBe(0);
    expect(await active('channel:channel-1')).toBe(0);
  });

  it('releases the user lease when the channel denies admission', async () => {
    const result = await acquireDualLease(testEnv.GATE, { ...input, channel: { ...input.channel, limit: 0 } });
    expect(result).toMatchObject({ granted: false, stage: 'channel', reason: 'denied', cleanup: { complete: true } });
    expect(await active('user:user-1')).toBe(0);
    expect(await active('channel:channel-1')).toBe(0);
  });

  it('all API Keys for one user share its user lease subject', async () => {
    const first = await acquireDualLease(testEnv.GATE, input);
    if (!first.granted) throw new Error('Expected pair');
    const second = await acquireDualLease(testEnv.GATE, { ...input, channelId: 'channel-2', requestId: 'request-from-another-key' });
    expect(second).toMatchObject({ granted: false, stage: 'user', reason: 'denied' });
    expect(await active('channel:channel-2')).toBe(0);
    await first.lease.release();
  });

  it('concurrent channel contenders leave only the winning user slot active', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, (_, index) => acquireDualLease(testEnv.GATE, {
      ...input, requestId: `request-${index}`, user: { ...input.user, limit: 4 },
    })));
    expect(results.filter((result) => result.granted)).toHaveLength(1);
    expect(await active('user:user-1')).toBe(1);
    for (const result of results) if (result.granted) await result.lease.release();
    expect(await active('user:user-1')).toBe(0);
  });

  it('pre-cancellation never acquires and cancellation after grant releases both subjects', async () => {
    const before = new AbortController();
    before.abort();
    const order: string[] = [];
    expect(await acquireDualLease(bindingHooks({ afterAcquire: (name) => { order.push(name); } }), input, { signal: before.signal }))
      .toMatchObject({ granted: false, reason: 'cancelled', cleanup: { complete: true } });
    expect(order).toHaveLength(0);
    const after = new AbortController();
    const result = await acquireDualLease(testEnv.GATE, input, { signal: after.signal });
    if (!result.granted) throw new Error('Expected pair');
    after.abort();
    expect((await result.lease.release()).complete).toBe(true);
    expect(await active('user:user-1')).toBe(0);
    expect(await active('channel:channel-1')).toBe(0);
  });

  it('waits for a late acquisition response after cancellation and then compensates it', async () => {
    const controller = new AbortController();
    let unblock!: () => void;
    let arrived!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const reached = new Promise<void>((resolve) => { arrived = resolve; });
    const pending = acquireDualLease(bindingHooks({ afterAcquire: async (name) => {
      if (name.startsWith('channel:')) { arrived(); await blocked; }
    } }), input, { signal: controller.signal });
    await reached;
    controller.abort();
    unblock();
    expect(await pending).toMatchObject({ granted: false, reason: 'cancelled', cleanup: { complete: true } });
    expect(await active('user:user-1')).toBe(0);
    expect(await active('channel:channel-1')).toBe(0);
  });

  it.each(['user:', 'channel:'])('recovers and releases an acquisition whose %s response was lost', async (scope) => {
    let loseReply = true;
    const result = await acquireDualLease(bindingHooks({ afterAcquire(name) {
      if (name.startsWith(scope) && loseReply) { loseReply = false; throw new Error('injected lost acquisition response'); }
    } }), input);
    expect(result).toMatchObject({ granted: false, reason: 'acquire_error', cleanup: { complete: true } });
    expect(await active('user:user-1')).toBe(0);
    expect(await active('channel:channel-1')).toBe(0);
  });

  it('reports a failed compensation without skipping user cleanup and allows an explicit retry', async () => {
    let failRelease = true;
    const releases: string[] = [];
    const controller = new AbortController();
    const result = await acquireDualLease(bindingHooks({
      afterAcquire(name) { if (name.startsWith('channel:')) controller.abort(); },
      beforeRelease(name) { releases.push(name); if (name.startsWith('channel:') && failRelease) throw new Error('injected release outage'); },
    }), input, { signal: controller.signal });
    if (result.granted) throw new Error('Expected cancellation');
    expect(result.cleanup.complete).toBe(false);
    expect(result.cleanup.outcomes.find((outcome) => outcome.subject.kind === 'channel')?.status).toBe('uncertain');
    expect(await active('user:user-1')).toBe(0);
    expect(await active('channel:channel-1')).toBe(1);
    failRelease = false;
    expect((await result.retryCleanup()).complete).toBe(true);
    expect(await active('channel:channel-1')).toBe(0);
    expect(releases.filter((name) => name.startsWith('user:'))).toHaveLength(1);
  });

  it('does not grant on persistent unknown acquisition and never recreates it after the TTL budget', async () => {
    let calls = 0;
    const result = await acquireDualLease(bindingHooks({ afterAcquire() { calls++; throw new Error('persistent lost reply'); } }), input);
    if (result.granted) throw new Error('Expected failure');
    expect(result.cleanup.complete).toBe(false);
    expect(calls).toBe(3); // Original call plus at most two recovery attempts.
    now += 90_000;
    expect(await active('user:user-1')).toBe(0);
    await result.retryCleanup();
    expect(calls).toBe(3);
  });

  it('compensates a channel acquired after the user lease already expired', async () => {
    const result = await acquireDualLease(bindingHooks({ beforeAcquire(name) {
      if (name.startsWith('channel:')) now += 90_000;
    } }), input);
    expect(result).toMatchObject({ granted: false, reason: 'expired', cleanup: { complete: true } });
    expect(await active('user:user-1')).toBe(0);
    expect(await active('channel:channel-1')).toBe(0);
  });

  it('rejects invalid cancellation options before obtaining either lease', async () => {
    const acquire = vi.fn();
    await expect(acquireDualLease(bindingHooks({ beforeAcquire: acquire }), input, { signal: {} as AbortSignal })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(acquire).not.toHaveBeenCalled();
  });
});
