import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticatePlatformKey } from '../../apps/worker/auth/api-key-auth';
import { generateToken, hashToken } from '../../apps/worker/auth/tokens';
import { prepare } from '../../apps/worker/db';
import { admitRequest } from '../../apps/worker/gateway/admit';
import { acquireDualLease } from '../../apps/worker/limits/dual-lease';
import type { DualLeaseInput, DualLeasePermit } from '../../apps/worker/limits/dual-lease';
import { LeaseClient } from '../../apps/worker/limits/client';
import type { LeaseBinding } from '../../apps/worker/limits/client';
import { startLeaseLifecycle } from '../../apps/worker/limits/lease-lifecycle';
import type { LeaseScheduler } from '../../apps/worker/limits/lease-lifecycle';
import { LeaseStorage } from '../../apps/worker/limits/storage';
import type { InternalPlatformKeyAuth } from '../../apps/worker/auth/key-repository';
import type { ProtocolRequest } from '../../packages/apicompat/capabilities/check';
import { testEnv } from '../helpers/database';

const initialNow = 1_800_000_000_000;
const request: ProtocolRequest = {
  protocol: 'chat',
  request: { model: 'q06-model', messages: [{ role: 'user', content: 'q06 synthetic prompt' }], max_tokens: 20 },
};
let now: number;
let tokenA: string;
let tokenB: string;
let subjectA: InternalPlatformKeyAuth;
let subjectB: InternalPlatformKeyAuth;

class ManualScheduler implements LeaseScheduler {
  readonly timers = new Map<number, { at: number; callback: () => void | Promise<void> }>();
  private next = 1;
  schedule(callback: () => void | Promise<void>, delayMs: number): number {
    const id = this.next++;
    this.timers.set(id, { at: now + delayMs, callback });
    return id;
  }
  cancel(handle: unknown): void { this.timers.delete(handle as number); }
  fire(): Promise<void>[] {
    const due = [...this.timers].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at);
    return due.map(([id, timer]) => {
      this.timers.delete(id);
      return Promise.resolve(timer.callback());
    });
  }
}

const active = (name: string) => runInDurableObject(
  testEnv.GATE.get(testEnv.GATE.idFromName(name)),
  (_instance, context) => new LeaseStorage(context.storage).read(now).leases,
);
const countRequests = async () => (await prepare(testEnv.DB, 'SELECT COUNT(*) AS n FROM requests').first<{ n: number }>())?.n;
const authFor = async (token: string) => authenticatePlatformKey(testEnv.DB,
  new Request('https://gateway.example/v1/chat/completions', { headers: { Authorization: `Bearer ${token}` } }), now);
const pairInput = (requestId: string, ttlMs = 90_000): DualLeaseInput => ({
  userId: 'q06-user', channelId: 'q06-channel', requestId,
  user: { limit: 2, ttlMs }, channel: { limit: 2, ttlMs },
});
const getPair = async (requestId: string, ttlMs = 90_000): Promise<DualLeasePermit> => {
  const result = await acquireDualLease(testEnv.GATE, pairInput(requestId, ttlMs));
  if (!result.granted) throw new Error(`Expected dual lease, got ${result.reason}`);
  return result.lease;
};

function loseFirstChannelReply(): LeaseBinding {
  const names = new Map<string, string>();
  let lose = true;
  return {
    idFromName(name) {
      const id = testEnv.GATE.idFromName(name);
      names.set(id.toString(), name);
      return id;
    },
    get(id) {
      const native = testEnv.GATE.get(id);
      const name = names.get(id.toString())!;
      return {
        async acquire(input) {
          const result = await native.acquire(input);
          if (name.startsWith('channel:') && lose) {
            lose = false;
            const dispose = (Symbol as SymbolConstructor & { readonly dispose: symbol }).dispose;
            (result as unknown as Record<symbol, (() => void) | undefined>)[dispose]?.();
            throw new Error('q06 synthetic lost channel acquisition reply');
          }
          return result;
        },
        renew: (input) => native.renew(input),
        release: (input) => native.release(input),
      };
    },
  };
}

beforeEach(async () => {
  now = initialNow;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  await prepare(testEnv.DB, "INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('q06-group','Q06 Group','active',1,0,0)").run();
  await prepare(testEnv.DB, `INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES('q06-user','q06@example.invalid','test-only-hash','user','active','q06-group',1000000,1,60,'admin',0,0)`).run();
  tokenA = generateToken('apiKey');
  tokenB = generateToken('apiKey');
  await prepare(testEnv.DB, `INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at)
    VALUES('q06-key-a','q06-user',?,'s2a_key_ABCDEFGH','Q06 Key A','active',0,0),
    ('q06-key-b','q06-user',?,'s2a_key_IJKLMNOP','Q06 Key B','active',0,0)`,
  [await hashToken('apiKey', tokenA), await hashToken('apiKey', tokenB)]).run();
  const credential = 'PRIVATE-UPSTREAM-KEY';
  await prepare(testEnv.DB, `INSERT INTO channels(id,name,base_url,upstream_key,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES('q06-channel','Q06 Channel','https://provider.example.com',?,'active',1,2,60,1,0,0)`, [credential]).run();
  await prepare(testEnv.DB, `INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES ('q06-model','active',?,1,10,4096,0,0)`, [JSON.stringify({ input: '1', output: '2' })]).run();
  await prepare(testEnv.DB, "INSERT INTO channel_groups(channel_id,group_id) VALUES('q06-channel','q06-group')").run();
  await prepare(testEnv.DB, `INSERT INTO channel_models(channel_id,public_model_id,protocol,upstream_model,capabilities_json,config_version)
    VALUES('q06-channel','q06-model','chat','provider-model',?,1)`, [JSON.stringify({ protocol: 'chat', features: [], maxOutputTokens: 4096 })]).run();
  subjectA = await authFor(tokenA);
  subjectB = await authFor(tokenB);
});
afterEach(() => vi.restoreAllMocks());

describe('Q06 Gate DO and L10 lifecycle integration', () => {
  it('shares one real user quota across two API Keys while preserving channel cleanup and G03 registration', async () => {
    const first = await admitRequest(testEnv, subjectA, request, { now: () => now, adapterAvailable: () => true });
    try {
      expect(first.selected.candidate.channel.id).toBe('q06-channel');
      expect(await active('user:q06-user')).toHaveLength(1);
      expect(await active('channel:q06-channel')).toHaveLength(1);
      await expect(admitRequest(testEnv, subjectB, request, { now: () => now, adapterAvailable: () => true }))
        .rejects.toMatchObject({ code: 'rate_limited', candidate: { channelId: 'q06-channel' }, cleanup: { complete: true } });
      expect(await countRequests()).toBe(1);
      expect(await active('user:q06-user')).toHaveLength(1);
      expect(await active('channel:q06-channel')).toHaveLength(1);
    } finally {
      expect((await first.lease.release()).complete).toBe(true);
    }
    expect(await active('user:q06-user')).toHaveLength(0);
    expect(await active('channel:q06-channel')).toHaveLength(0);
    const second = await admitRequest(testEnv, subjectB, request, { now: () => now, adapterAvailable: () => true });
    await second.lease.release();
    expect(await countRequests()).toBe(2);
  });

  it('renews both leases through a real DO restart and releases them exactly once', async () => {
    const permit = await getPair('q06-restart');
    const scheduler = new ManualScheduler();
    const lifecycle = startLeaseLifecycle(permit, {
      ttlMs: 90_000, renewIntervalMs: 30_000, safetyMarginMs: 10_000,
      clock: () => now, scheduler,
    });
    expect(scheduler.timers.size).toBe(2);
    await evictDurableObject(testEnv.GATE.get(testEnv.GATE.idFromName('user:q06-user')));
    await evictDurableObject(testEnv.GATE.get(testEnv.GATE.idFromName('channel:q06-channel')));
    now += 30_000;
    await Promise.all(scheduler.fire());
    expect(lifecycle.signal.aborted).toBe(false);
    expect(lifecycle.snapshot().expiresAt).toBe(now + 90_000);
    expect((await active('user:q06-user'))[0]?.expiresAt).toBe(now + 90_000);
    expect((await active('channel:q06-channel'))[0]?.expiresAt).toBe(now + 90_000);
    const [first, second] = await Promise.all([lifecycle.close(), lifecycle.close()]);
    expect(first).toBe(second);
    expect(first.complete).toBe(true);
    expect(scheduler.timers.size).toBe(0);
    expect(await active('user:q06-user')).toHaveLength(0);
    expect(await active('channel:q06-channel')).toHaveLength(0);
  });

  it('compensates a user lease when a real channel acquisition reply is lost after DO commit', async () => {
    const result = await acquireDualLease(loseFirstChannelReply(), pairInput('q06-lost-channel'));
    expect(result).toMatchObject({ granted: false, stage: 'channel', reason: 'acquire_error', cleanup: { complete: true } });
    expect(await active('user:q06-user')).toHaveLength(0);
    expect(await active('channel:q06-channel')).toHaveLength(0);
  });

  it('stops L10 on an actual missing renewal, then reaps an expired lease after DO reconstruction', async () => {
    const permit = await getPair('q06-disconnected');
    const scheduler = new ManualScheduler();
    const lifecycle = startLeaseLifecycle(permit, {
      ttlMs: 90_000, renewIntervalMs: 30_000, safetyMarginMs: 10_000,
      clock: () => now, scheduler,
    });
    await permit.channel.client.release(permit.channel.handle);
    now += 30_000;
    await Promise.all(scheduler.fire());
    expect(lifecycle.signal.aborted).toBe(true);
    expect(lifecycle.snapshot().reason).toBe('renewal_failed');
    expect((await lifecycle.close()).complete).toBe(true);
    expect(await active('user:q06-user')).toHaveLength(0);
    expect(await active('channel:q06-channel')).toHaveLength(0);

    const client = new LeaseClient(testEnv.GATE, { kind: 'user', id: 'q06-user' });
    const expiring = await client.acquire({ requestId: 'q06-expiring', limit: 1, ttlMs: 1_000 });
    expect(expiring.granted).toBe(true);
    await evictDurableObject(testEnv.GATE.get(testEnv.GATE.idFromName('user:q06-user')));
    now += 1_000;
    const recovered = await client.acquire({ requestId: 'q06-after-expiry', limit: 1, ttlMs: 1_000 });
    expect(recovered).toMatchObject({ granted: true, duplicate: false });
    expect(await active('user:q06-user')).toHaveLength(1);
    if (recovered.granted) await client.release(recovered.handle);
    expect(await active('user:q06-user')).toHaveLength(0);
  });
});
