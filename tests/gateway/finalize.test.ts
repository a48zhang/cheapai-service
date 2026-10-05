import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import { createRequestFinalizer, finalizationFromJson } from '../../apps/worker/gateway/finalize';
import { getRequest } from '../../apps/worker/gateway/request-repository';
import type { RequestRecord } from '../../apps/worker/gateway/request-repository';
import { acquireDualLease } from '../../apps/worker/limits/dual-lease';
import type { DualLeasePermit } from '../../apps/worker/limits/dual-lease';
import { LeaseStorage } from '../../apps/worker/limits/storage';
import { createPriceSnapshot } from '../../apps/worker/billing/fingerprint';
import type { UsageSnapshot } from '../../packages/apicompat/types/shared';
import { testEnv } from '../helpers/database';

let record: RequestRecord;
let permit: DualLeasePermit;
const usage = (): UsageSnapshot => ({ quality: 'complete', protocol: 'chat', counts: { inputTokens: 1000, outputTokens: 500 },
  semantics: { cacheRead: 'included_in_input', cacheWrite: 'included_in_input', reasoning: 'included_in_output', cacheWriteTtl: 'unknown' }, sources: [{ protocol: 'chat', path: 'usage' }], issues: [] });
const active = () => runInDurableObject(testEnv.GATE.get(testEnv.GATE.idFromName('user:g11-user')), (_instance, context) => new LeaseStorage(context.storage).read(Date.now()).leases.length);
beforeEach(async () => {
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('g11-group','Fixture','active',1,0,0)").run();
  await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES('g11-user','g11@example.invalid','synthetic','user','active','g11-group',100000,1,60,'admin',0,0)`).run();
  await testEnv.DB.prepare("INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at) VALUES('g11-key','g11-user',?,'s2a_key_ABCDEFGH','Fixture','active',0,0)").bind('1'.repeat(64)).run();
  const credential = 'synthetic';
  await testEnv.DB.prepare(`INSERT INTO channels(id,name,base_url,upstream_key,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES('g11-channel','Fixture','https://example.invalid',?,'active',0,1,60,1,0,0)`).bind(credential).run();
  await testEnv.DB.prepare(`INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES ('g11-model','active','{"input":"1","output":"2"}',1,0,10,0,0)`).run();
  const price = createPriceSnapshot({ publicModelId: 'g11-model', upstreamModel: 'provider', upstreamProtocol: 'chat', priceVersion: 1, sellPrices: { input: '1', output: '2' } }).json;
  await testEnv.DB.prepare(`INSERT INTO requests(id,user_id,api_key_id,channel_id,public_model_id,upstream_model,downstream_protocol,upstream_protocol,price_snapshot,created_at,updated_at)
    VALUES('g11-request','g11-user','g11-key','g11-channel','g11-model','provider','chat','chat',?,0,0)`).bind(price).run();
  record = (await getRequest(testEnv.DB, 'g11-request', 'g11-user'))!;
  const acquired = await acquireDualLease(testEnv.GATE, { userId: 'g11-user', channelId: 'g11-channel', requestId: record.id,
    user: { limit: 1, ttlMs: 90000 }, channel: { limit: 1, ttlMs: 90000 } });
  if (!acquired.granted) throw new Error('Expected native permit'); permit = acquired.lease;
});

describe('G11 finalization with native D1/Gate', () => {
  it('coalesces concurrent/repeated callers and releases only after accounting', async () => {
    const cleanup = vi.fn(async () => {
      expect(await active()).toBe(1);
      expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(1);
      return permit.release();
    });
    const finalizer = createRequestFinalizer({ database: testEnv.DB, request: record, cleanup });
    const first = finalizer.finalize({ requestId: record.id, usage: usage() });
    expect(finalizer.finalize({ requestId: record.id, usage: usage() })).toBe(first);
    expect(await first).toMatchObject({ accounting: 'settled', billingStatus: 'settled', cleanup: { complete: true } });
    await finalizer.onComplete({ requestId: record.id, usage: { quality: 'missing', protocol: 'chat' } }, new AbortController().signal);
    expect(cleanup).toHaveBeenCalledTimes(1); expect(await active()).toBe(0);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(1);
    expect(await testEnv.DB.prepare('SELECT balance_units FROM users').first('balance_units')).toBe(-100000);
  });

  it('keeps missing/unpriceable usage unknown and ignores later competing terminal inputs', async () => {
    const finalizer = createRequestFinalizer({ database: testEnv.DB, request: record, cleanup: () => permit.release() });
    const result = await finalizer.finalize({ requestId: record.id, usage: { quality: 'missing', protocol: 'chat' } });
    expect(result).toMatchObject({ accounting: 'recovered', billingStatus: 'usage_unknown' });
    expect(await finalizer.finalize({ requestId: record.id, usage: usage() })).toBe(result);
    expect(await testEnv.DB.prepare('SELECT cost_units FROM requests').first('cost_units')).toBeNull();
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(0);
  });

  it('stores invalid usage as unknown without guessing a charge', async () => {
    const invalid = usage(); if (invalid.quality !== 'complete') throw new Error();
    const finalizer = createRequestFinalizer({ database: testEnv.DB, request: record, cleanup: () => permit.release() });
    expect(await finalizer.finalize({ requestId: record.id, usage: { ...invalid, counts: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 100 } } }))
      .toMatchObject({ billingStatus: 'usage_unknown', accounting: 'recovered' });
    expect(await testEnv.DB.prepare('SELECT cost_units,usage_quality FROM requests').first()).toEqual({ cost_units: null, usage_quality: 'invalid' });
  });

  it('recovers known evidence after failed settlement and still releases once', async () => {
    const failed = new Proxy(testEnv.DB, { get(target, property) {
      if (property === 'batch') return async () => { throw new Error('Synthetic failure'); };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const finalizer = createRequestFinalizer({ database: failed, request: record, cleanup: () => permit.release(), settlement: { maxAttempts: 1 } });
    expect(await finalizer.finalize({ requestId: record.id, usage: usage() })).toMatchObject({ accounting: 'recovered', billingStatus: 'settlement_pending' });
    expect(await active()).toBe(0);
  });

  it('reports a bounded late recovery honestly and attaches its work to waitUntil', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    function wrap(statement: D1PreparedStatement): D1PreparedStatement {
      return new Proxy(statement, { get(target, property) {
        if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
        if (property === 'first') return async () => { await held; return target.first(); };
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
      } });
    }
    const delayed = { prepare: (sql: string) => wrap(testEnv.DB.prepare(sql)) } as unknown as D1Database;
    const owned: Promise<unknown>[] = [];
    const finalizer = createRequestFinalizer({ database: delayed, request: record, budgetMs: 30, cleanup: () => permit.release(), waitUntil: work => { owned.push(work); } });
    const result = await finalizer.finalize({ requestId: record.id, usage: { quality: 'missing', protocol: 'chat' } });
    expect(result).toMatchObject({ accounting: 'unavailable', uncertain: true, cleanup: { complete: true } });
    expect(owned.length).toBe(1); expect(await active()).toBe(0);
    release(); await Promise.all(owned);
    expect(await testEnv.DB.prepare('SELECT billing_status FROM requests').first('billing_status')).toBe('usage_unknown');
    expect(await finalizer.finalize({ requestId: record.id, usage: usage() })).toBe(result);
  });

  it('does not own stream cleanup and rejects a mismatched request before taking ownership', async () => {
    const finalizer = createRequestFinalizer({ database: testEnv.DB, request: record });
    await expect(finalizer.finalize({ requestId: 'other', usage: usage() })).rejects.toMatchObject({ code: 'conflict' });
    expect(finalizer.completion).toBeNull();
    await finalizer.onComplete({ requestId: record.id, usage: usage() }, new AbortController().signal);
    expect(await active()).toBe(1); await permit.release();
  });

  it('adapts a G07 JSON result without another accounting or cleanup call', async () => {
    const cleanup = await permit.release();
    const adapted = finalizationFromJson({ requestId: record.id, usage: usage(), billingStatus: 'settled', cleanup });
    expect(adapted).toMatchObject({ accounting: 'already_finalized', billingStatus: 'settled', cleanup });
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(0);
  });
});
