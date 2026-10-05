import { evictDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeaseClient, LeaseClientError } from '../../apps/worker/limits/client';
import type { LeaseBinding, LeaseHandle, LeaseSubject } from '../../apps/worker/limits/client';
import { testEnv } from '../helpers/database';

let now: number;
beforeEach(() => { now = 1_800_000_000_000; vi.spyOn(Date, 'now').mockImplementation(() => now); });
afterEach(() => vi.restoreAllMocks());
const scope = { kind: 'user', id: 'user-1' } as const;
const input = { requestId: 'request-1', limit: 1, ttlMs: 90_000 };

function responseBinding(acquire: () => Promise<unknown>, renew = async (): Promise<unknown> => ({ renewed: false, reason: 'missing' }), release = async (): Promise<unknown> => ({ released: true })): LeaseBinding {
  return { idFromName: (name) => testEnv.GATE.idFromName(name), get: () => ({ acquire, renew, release }) };
}

describe('typed internal lease binding client', () => {
  it('acquires, renews and releases through a real DO with readonly scoped handles', async () => {
    const client = new LeaseClient(testEnv.GATE, scope);
    const acquired = await client.acquire(input);
    if (!acquired.granted) throw new Error('Expected admission');
    expect(Object.isFrozen(acquired.handle)).toBe(true);
    expect(Object.isFrozen(acquired.handle.subject)).toBe(true);
    expect(acquired.handle.subject).toEqual(scope);
    expect(acquired.handle.leaseToken).toMatch(/^[a-f0-9]{64}$/);
    now += 30_000;
    const renewed = await client.renew(acquired.handle, 90_000);
    if (!renewed.renewed) throw new Error('Expected renewal');
    expect(renewed.handle.expiresAt).toBe(now + 90_000);
    expect(acquired.handle.expiresAt).toBe(now + 60_000);
    expect(await client.release(renewed.handle)).toEqual({ released: true });
    expect(await client.release(renewed.handle)).toEqual({ released: false, reason: 'missing' });
    expect(await client.renew(renewed.handle, 90_000)).toEqual({ renewed: false, reason: 'missing' });
  });

  it('shares user quota across clients while channel and user namespaces stay separate', async () => {
    const user = new LeaseClient(testEnv.GATE, scope);
    const secondUserClient = new LeaseClient(testEnv.GATE, scope);
    const channel = new LeaseClient(testEnv.GATE, { kind: 'channel', id: scope.id });
    expect((await user.acquire(input)).granted).toBe(true);
    expect(await secondUserClient.acquire({ ...input, requestId: 'request-2' })).toEqual({ granted: false, reason: 'capacity', retryAfterMs: 90_000 });
    expect((await channel.acquire(input)).granted).toBe(true);
  });

  it('recovers the same token after eviction/retry and exposes rate rejection separately', async () => {
    const client = new LeaseClient(testEnv.GATE, scope);
    const args = { ...input, rate: { limit: 1, windowMs: 60_000 } };
    const first = await client.acquire(args);
    if (!first.granted) throw new Error('Expected admission');
    await evictDurableObject(testEnv.GATE.get(testEnv.GATE.idFromName('user:user-1')));
    const duplicate = await client.acquire(args);
    expect(duplicate.granted).toBe(true);
    if (duplicate.granted) {
      expect(duplicate.duplicate).toBe(true);
      expect(duplicate.handle.leaseToken).toBe(first.handle.leaseToken);
    }
    await client.release(first.handle);
    expect(await client.acquire({ ...args, requestId: 'request-2' })).toEqual({ granted: false, reason: 'rate_limit', retryAfterMs: 60_000 });
  });

  it('rejects forged, modified, or foreign-client handles before calling the binding', async () => {
    const firstClient = new LeaseClient(testEnv.GATE, scope);
    const otherClient = new LeaseClient(testEnv.GATE, { kind: 'channel', id: 'channel-1' });
    const first = await firstClient.acquire(input);
    if (!first.granted) throw new Error('Expected admission');
    await expect(otherClient.release(first.handle)).rejects.toMatchObject({ code: 'invalid_handle', retryable: false });
    await expect(firstClient.release({ ...first.handle } as LeaseHandle)).rejects.toMatchObject({ code: 'invalid_handle' });
    await expect(firstClient.renew({ ...first.handle, leaseToken: 'B'.repeat(64) }, 90_000)).rejects.toMatchObject({ code: 'invalid_handle' });
    expect(await firstClient.release(first.handle)).toEqual({ released: true });
  });

  it.each([{ kind: 'auth', id: 'x' }, { kind: 'user', id: 'channel:other' }, { kind: 'user', id: '../other' }, { kind: 'user', id: '' }])(
    'rejects arbitrary object names/scopes (case %#)', (subject) => {
      expect(() => new LeaseClient(testEnv.GATE, subject as LeaseSubject)).toThrow(LeaseClientError);
    },
  );

  it.each([{ ttlMs: 0 }, { limit: -1 }, { requestId: 'bad\n' }, { rate: { limit: 1, windowMs: 60_000, operationId: 'bad\n' } }])(
    'rejects malformed lease parameters (case %#)', async (extra) => {
      const call = vi.fn(async () => undefined);
      const client = new LeaseClient(responseBinding(call), scope);
      await expect(client.acquire({ ...input, ...extra })).rejects.toMatchObject({ code: 'invalid_input', retryable: false });
      expect(call).not.toHaveBeenCalled();
    },
  );

  it('forwards a trusted logical rate operation ID independently of the attempt request ID', async () => {
    const call = vi.fn(async () => ({ granted: false, reason: 'rate_limit', retryAfterMs: 1, futureMetadata: true }));
    const client = new LeaseClient(responseBinding(call), scope);
    const args = { ...input, rate: { limit: 1, windowMs: 60_000, operationId: 'logical-request-1' } };
    await expect(client.acquire({ ...args, now: 0, leaseToken: 'ignored' } as typeof args)).resolves.toEqual({ granted: false, reason: 'rate_limit', retryAfterMs: 1 });
    expect(call).toHaveBeenCalledExactlyOnceWith(args);
  });

  it.each([null, {}, { granted: 'true' }, { granted: false, reason: 'capacity', retryAfterMs: -1 },
    { granted: true, duplicate: false, lease: { requestId: 'wrong-request', leaseToken: 'a'.repeat(64), acquiredAt: 1, expiresAt: 2 } },
    { granted: true, duplicate: false, lease: { requestId: input.requestId, leaseToken: 'short', acquiredAt: 1, expiresAt: 2 } },
  ])('does not grant on malformed response case %#', async (reply) => {
    const client = new LeaseClient(responseBinding(async () => reply), scope);
    await expect(client.acquire(input)).rejects.toMatchObject({ code: 'invalid_response', retryable: false });
  });

  it('rejects renewal identity changes and malformed release responses', async () => {
    const lease = { requestId: input.requestId, leaseToken: 'a'.repeat(64), acquiredAt: 1, expiresAt: 90_001 };
    const client = new LeaseClient(responseBinding(
      async () => ({ granted: true, duplicate: false, lease }),
      async () => ({ renewed: true, lease: { ...lease, leaseToken: 'b'.repeat(64), lastRenewedAt: 2, expiresAt: 90_002 } }),
      async () => ({ released: false, reason: 'unknown' }),
    ), scope);
    const first = await client.acquire(input);
    if (!first.granted) throw new Error('Expected admission');
    await expect(client.renew(first.handle, 90_000)).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(client.release(first.handle)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('classifies transient binding failures without retrying or exposing raw errors', async () => {
    const call = vi.fn(async () => { throw new Error('internal token or endpoint must not leak'); });
    const client = new LeaseClient(responseBinding(call), scope);
    await expect(client.acquire(input)).rejects.toMatchObject({ code: 'unavailable', retryable: true, message: 'Internal lease client: unavailable' });
    expect(call).toHaveBeenCalledTimes(1);
    const rejected = new LeaseClient(responseBinding(async () => { throw { code: 'configuration_changed' }; }), scope);
    await expect(rejected.acquire(input)).rejects.toMatchObject({ code: 'remote_rejected', retryable: false });
  });

  it('disposes RPC result objects on success and on rejected response validation', async () => {
    const disposeSymbol = (Symbol as SymbolConstructor & { readonly dispose: symbol }).dispose;
    const successDispose = vi.fn();
    const failureDispose = vi.fn();
    const lease = { requestId: input.requestId, leaseToken: 'a'.repeat(64), acquiredAt: 1, expiresAt: 90_001 };
    const good = new LeaseClient(responseBinding(async () => ({ granted: true, duplicate: false, lease, [disposeSymbol]: successDispose })), scope);
    expect((await good.acquire(input)).granted).toBe(true);
    expect(successDispose).toHaveBeenCalledTimes(1);
    const bad = new LeaseClient(responseBinding(async () => ({ granted: 'invalid', [disposeSymbol]: failureDispose })), scope);
    await expect(bad.acquire(input)).rejects.toMatchObject({ code: 'invalid_response' });
    expect(failureDispose).toHaveBeenCalledTimes(1);
  });

  it('exposes native channel cooldown as an ordinary denial and can acquire after expiry', async () => {
    const id = testEnv.GATE.idFromName('channel:cooled-channel');
    await testEnv.GATE.get(id).setCooldown({ ttlMs: 5_000, errorClass: 'rate_limited' });
    const client = new LeaseClient(testEnv.GATE, { kind: 'channel', id: 'cooled-channel' });
    expect(await client.acquire(input)).toEqual({ granted: false, reason: 'cooldown', retryAfterMs: 5_000 });
    now += 5_000;
    const acquired = await client.acquire(input);
    if (!acquired.granted) throw new Error('Expected recovered channel');
    await client.release(acquired.handle);
  });
});
