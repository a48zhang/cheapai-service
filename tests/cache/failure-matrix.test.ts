import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticatePlatformKey } from '../../apps/worker/auth/api-key-auth';
import { generateToken, hashToken } from '../../apps/worker/auth/tokens';
import { readBalance, balanceCacheKey } from '../../apps/worker/cache/balance';
import { readPrices, priceCacheKey } from '../../apps/worker/cache/prices';
import { readRoutes, routesCacheKey } from '../../apps/worker/cache/routes';
import { encodeSnapshot, writeSnapshot } from '../../apps/worker/cache/snapshot';
import { settleRequest } from '../../apps/worker/billing/settlement';
import { admitRequest } from '../../apps/worker/gateway/admit';
import { prepare } from '../../apps/worker/db';
import { LeaseStorage } from '../../apps/worker/limits/storage';
import type { InternalPlatformKeyAuth } from '../../apps/worker/auth/key-repository';
import type { ProtocolRequest } from '../../packages/apicompat/capabilities/check';
import type { UsageSnapshot } from '../../packages/apicompat/types/shared';
import { testEnv } from '../helpers/database';

const now = 1_800_000_000_000;
const request: ProtocolRequest = {
  protocol: 'chat',
  request: { model: 'q05-model', messages: [{ role: 'user', content: 'q05 synthetic prompt' }], max_tokens: 20 },
};
const usage = (): UsageSnapshot => ({
  quality: 'complete', protocol: 'chat', counts: { inputTokens: 100, outputTokens: 50 },
  semantics: { cacheRead: 'included_in_input', cacheWrite: 'included_in_input', reasoning: 'included_in_output', cacheWriteTtl: 'unknown' },
  sources: [{ protocol: 'chat', path: 'usage' }], issues: [],
});
const balanceConfig = { balanceCacheEnabled: true, balanceCacheTtlMs: 15_000, admissionMinBalanceUnits: '10' } as const;
const disabledBalanceConfig = { ...balanceConfig, balanceCacheEnabled: false } as const;
let subject: InternalPlatformKeyAuth;
let apiToken: string;

const active = (name: string) => runInDurableObject(
  testEnv.GATE.get(testEnv.GATE.idFromName(name)),
  (_instance, context) => new LeaseStorage(context.storage).read(now).leases.length,
);
const count = async (table: 'requests' | 'billing_entries') =>
  (await prepare(testEnv.DB, `SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n;
const currentBalance = async () =>
  (await prepare(testEnv.DB, "SELECT balance_units AS value FROM users WHERE id='q05-user'").first<{ value: number }>())?.value;
const authFor = async (token: string) => authenticatePlatformKey(testEnv.DB,
  new Request('https://gateway.example/v1/chat/completions', { headers: { Authorization: `Bearer ${token}` } }), now);

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  await prepare(testEnv.DB, "INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('q05-group','Q05 Group','active',1,0,0)").run();
  await prepare(testEnv.DB, `INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES('q05-user','q05@example.invalid','test-only-hash','user','active','q05-group',1000000,2,60,'admin',0,0)`).run();
  apiToken = generateToken('apiKey');
  await prepare(testEnv.DB, `INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at)
    VALUES('q05-key','q05-user',?,'s2a_key_ABCDEFGH','Q05 Key','active',0,0)`, [await hashToken('apiKey', apiToken)]).run();
  const credential = 'PRIVATE-UPSTREAM-KEY';
  await prepare(testEnv.DB, `INSERT INTO channels(id,name,base_url,upstream_key,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES('q05-channel','Q05 Channel','https://provider.example.com',?,'active',1,2,60,1,0,0)`, [credential]).run();
  await prepare(testEnv.DB, `INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES ('q05-model','active',?,1,10,4096,0,0)`, [JSON.stringify({ input: '1', output: '2' })]).run();
  await prepare(testEnv.DB, "INSERT INTO channel_groups(channel_id,group_id) VALUES('q05-channel','q05-group')").run();
  await prepare(testEnv.DB, `INSERT INTO channel_models(channel_id,public_model_id,protocol,upstream_model,capabilities_json,config_version)
    VALUES('q05-channel','q05-model','chat','provider-model',?,1)`, [JSON.stringify({ protocol: 'chat', features: [], maxOutputTokens: 4096 })]).run();
  subject = await authFor(apiToken);
});
afterEach(() => vi.restoreAllMocks());

describe('Q05 cache failure matrix with final D1 admission and B04 settlement', () => {
  it('rejects an out-of-order old cache fill and a negative balance hint from changing current admission or billing', async () => {
    const oldRoutes = await readRoutes(testEnv.DB, testEnv.CACHE, 'q05-group', 'q05-model', { now: () => now });
    const oldPrices = await readPrices(testEnv.DB, testEnv.CACHE, 'q05-model', { now: () => now });
    expect(oldRoutes?.source).toBe('d1');
    expect(oldPrices?.source).toBe('d1');
    if (!oldRoutes || !oldPrices) throw new Error('Expected initial D1 snapshots');

    await prepare(testEnv.DB, "UPDATE groups SET version=2 WHERE id='q05-group'").run();
    await prepare(testEnv.DB, "UPDATE channels SET config_version=2 WHERE id='q05-channel'").run();
    await prepare(testEnv.DB, "UPDATE channel_models SET config_version=2 WHERE channel_id='q05-channel'").run();
    await prepare(testEnv.DB, "UPDATE models SET price_version=2,sell_prices_json=? WHERE public_model_id='q05-model'")
      .bind(JSON.stringify({ input: '3', output: '4' })).run();
    subject = await authFor(apiToken);

    // A fresh v2 fill lands first. A delayed v1 writer then overwrites it;
    // observed_at remains old, so G03 must refresh against D1 before admitting.
    const freshRoutes = await readRoutes(testEnv.DB, testEnv.CACHE, 'q05-group', 'q05-model', { now: () => now, forceRefresh: true });
    const freshPrices = await readPrices(testEnv.DB, testEnv.CACHE, 'q05-model', { now: () => now, expectedPriceVersion: 2 });
    expect(freshRoutes?.snapshot.data.group.version).toBe(2);
    expect(freshPrices?.snapshot.data.price_version).toBe(2);
    const freshness = { now, maxAgeMs: 60_000 };
    expect(await writeSnapshot(testEnv.CACHE, routesCacheKey('q05-group', 'q05-model'),
      { ...oldRoutes.snapshot, observed_at: now - 1 }, freshness, () => true)).toBe(true);
    expect(await writeSnapshot(testEnv.CACHE, priceCacheKey('q05-model'),
      { ...oldPrices.snapshot, observed_at: now - 1 }, freshness, () => true)).toBe(true);
    const delayedRoute = await readRoutes(testEnv.DB, testEnv.CACHE, 'q05-group', 'q05-model', { now: () => now });
    const delayedPrice = await readPrices(testEnv.DB, testEnv.CACHE, 'q05-model', { now: () => now });
    expect(delayedRoute).toMatchObject({ source: 'cache', snapshot: { observed_at: now - 1, data: { group: { version: 1 } } } });
    expect(delayedPrice).toMatchObject({ source: 'cache', snapshot: { observed_at: now - 1, data: { price_version: 1 } } });

    // Negative cache data is a soft hint. It cannot turn a positive D1 balance
    // into a denial, and it is not a pricing/billing input.
    await testEnv.CACHE.put(balanceCacheKey('q05-user'), encodeSnapshot({ schema_version: 1, observed_at: now,
      data: { user_id: 'q05-user', balance_units: '-1', user_version: 2 } }));
    const balance = await readBalance(testEnv.DB, testEnv.CACHE, 'q05-user', balanceConfig, () => now);
    expect(balance?.source).toBe('d1');
    expect(balance?.snapshot.data.balance_units).toBe('1000000');

    const admitted = await admitRequest(testEnv, subject, request, { now: () => now, adapterAvailable: () => true });
    expect(admitted.request.execution_status).toBe('admitted');
    expect(admitted.request.price_snapshot).toContain('"price_version":2');
    expect(await active('user:q05-user')).toBe(1);
    expect(await active('channel:q05-channel')).toBe(1);
    const settled = await settleRequest(testEnv.DB, admitted.request, usage(), { now: () => now, retryDelayMs: 0 });
    expect(settled).toMatchObject({ status: 'settled', entry: { costUnits: '50000' } });
    await admitted.lease.release();
    expect(await currentBalance()).toBe(950000);
    expect(await count('requests')).toBe(1);
    expect(await count('billing_entries')).toBe(1);
  });

  it('keeps D1 permission and the B04 ledger authoritative through KV outage, 429 backfill, disabled cache, and revocation', async () => {
    const failingCache = {
      get: vi.fn(async () => { throw new Error('429 synthetic KV read outage'); }),
      put: vi.fn(async () => { throw new Error('429 synthetic KV write outage'); }),
      delete: vi.fn(async () => { throw new Error('synthetic KV delete outage'); }),
    } as unknown as KVNamespace;
    const disabledCache = {
      get: vi.fn(async () => encodeSnapshot({ schema_version: 1 as const, observed_at: now, data: {
        user_id: 'q05-user', balance_units: '-999999', user_version: subject.user.version,
      } })),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    } as unknown as KVNamespace;

    const disabled = await readBalance(testEnv.DB, disabledCache, 'q05-user', disabledBalanceConfig, () => now);
    expect(disabled?.source).toBe('d1');
    expect(disabledCache.get).not.toHaveBeenCalled();
    expect(disabledCache.put).not.toHaveBeenCalled();

    const admitted = await admitRequest({ ...testEnv, CACHE: failingCache }, subject, request, {
      now: () => now, adapterAvailable: () => true,
    });
    expect(admitted.request.execution_status).toBe('admitted');
    expect(await active('user:q05-user')).toBe(1);
    expect(await active('channel:q05-channel')).toBe(1);
    expect(failingCache.get).toHaveBeenCalled();
    expect(failingCache.put).toHaveBeenCalled();
    const settled = await settleRequest(testEnv.DB, admitted.request, usage(), { now: () => now, retryDelayMs: 0 });
    expect(settled).toMatchObject({ status: 'settled', entry: { costUnits: '20000' } });
    await admitted.lease.release();
    expect(await currentBalance()).toBe(980000);
    expect(await count('requests')).toBe(1);
    expect(await count('billing_entries')).toBe(1);

    const seeded = await readRoutes(testEnv.DB, testEnv.CACHE, 'q05-group', 'q05-model', { now: () => now });
    expect(seeded?.source).toBe('d1');
    await prepare(testEnv.DB, "UPDATE groups SET status='disabled' WHERE id='q05-group'").run();
    expect(await readRoutes(testEnv.DB, testEnv.CACHE, 'q05-group', 'q05-model', { now: () => now, forceRefresh: true })).toBeNull();
    expect(await testEnv.CACHE.get(routesCacheKey('q05-group', 'q05-model'))).toBeNull();
    await expect(admitRequest({ ...testEnv, CACHE: failingCache }, subject, request, {
      now: () => now, adapterAvailable: () => true,
    })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(await count('requests')).toBe(1);
    expect(await count('billing_entries')).toBe(1);
    expect(await active('user:q05-user')).toBe(0);
    expect(await active('channel:q05-channel')).toBe(0);
  });
});
