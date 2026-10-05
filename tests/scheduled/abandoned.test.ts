import { beforeEach, describe, expect, it } from 'vitest';
import { markAbandonedRequests } from '../../apps/worker/scheduled/abandoned';
import { finishRequest, markRequestStarted } from '../../apps/worker/gateway/request-repository';
import { settleConsumption } from '../../apps/worker/billing/settlement-repository';
import { createPriceSnapshot } from '../../apps/worker/billing/fingerprint';
import type { UsageSnapshot } from '../../packages/apicompat/types/shared';
import { testEnv } from '../helpers/database';

const options = { requestMaxDurationMs: 1000, graceMs: 500 };
let price: string;
async function add(id: string, created = 1000, started: number | null = null) {
  await testEnv.DB.prepare(`INSERT INTO requests(id,user_id,api_key_id,channel_id,public_model_id,upstream_model,downstream_protocol,upstream_protocol,price_snapshot,created_at,started_at,updated_at)
    VALUES(?,'b16-user','b16-key','b16-channel','b16-model','provider','chat','chat',?,?,?,?)`).bind(id, price, created, started, created).run();
}
async function settle() {
  const usage: UsageSnapshot = { quality: 'complete', protocol: 'chat', counts: { inputTokens: 1000, outputTokens: 500 },
    semantics: { cacheRead: 'included_in_input', cacheWrite: 'included_in_input', reasoning: 'included_in_output', cacheWriteTtl: 'unknown' }, sources: [{ protocol: 'chat', path: 'usage' }], issues: [] };
  return settleConsumption(testEnv.DB, { operationId: 'consume:b16-request', userId: 'b16-user', requestId: 'b16-request', priceSnapshotJson: price, usage, costUnits: '200000' }, 3000);
}
beforeEach(async () => {
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('b16-group','Fixture','active',1,0,0)").run();
  await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES('b16-user','b16@example.invalid','synthetic','user','active','b16-group',1,60,'admin',0,0)`).run();
  await testEnv.DB.prepare("INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at) VALUES('b16-key','b16-user',?,'s2a_key_ABCDEFGH','Fixture','active',0,0)").bind('6'.repeat(64)).run();
  const credential = 'synthetic';
  await testEnv.DB.prepare(`INSERT INTO channels(id,name,base_url,upstream_key,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES('b16-channel','Fixture','https://example.invalid',?,'active',0,1,60,1,0,0)`).bind(credential).run();
  await testEnv.DB.prepare(`INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES ('b16-model','active','{"input":"1","output":"2"}',1,0,10,0,0)`).run();
  price = createPriceSnapshot({ publicModelId: 'b16-model', upstreamModel: 'provider', upstreamProtocol: 'chat', priceVersion: 1, sellPrices: { input: '1', output: '2' } }).json;
  await add('b16-request');
});

describe('B16 conservative abandoned-request detection', () => {
  it('requires duration plus grace to be strictly exceeded and never fills missing usage/cost with zero', async () => {
    expect((await markAbandonedRequests(testEnv.DB, 2500, options)).abandoned).toBe(0);
    expect((await markAbandonedRequests(testEnv.DB, 2501, options)).abandoned).toBe(1);
    expect(await testEnv.DB.prepare('SELECT execution_status,billing_status,usage_json,usage_quality,cost_units,fingerprint FROM requests').first())
      .toEqual({ execution_status: 'abandoned', billing_status: 'usage_unknown', usage_json: null, usage_quality: 'missing', cost_units: null, fingerprint: null });
    expect((await markAbandonedRequests(testEnv.DB, 9000, options)).abandoned).toBe(0);
  });

  it('ages started requests from actual start and preserves partial evidence verbatim', async () => {
    const partial = '{"quality":"partial","protocol":"chat","counts":{"inputTokens":123}}';
    await testEnv.DB.prepare('UPDATE requests SET started_at=2000,usage_quality=\'partial\',usage_json=?').bind(partial).run();
    expect((await markAbandonedRequests(testEnv.DB, 3500, options)).abandoned).toBe(0);
    expect((await markAbandonedRequests(testEnv.DB, 3501, options)).abandoned).toBe(1);
    expect(await testEnv.DB.prepare('SELECT usage_json,cost_units FROM requests').first()).toEqual({ usage_json: partial, cost_units: null });
  });

  it('never changes successful/terminal executions or known pending billing', async () => {
    await finishRequest(testEnv.DB, 'b16-request', 'b16-user', { status: 'succeeded' }, 2000);
    const before = await testEnv.DB.prepare('SELECT * FROM requests').first();
    expect((await markAbandonedRequests(testEnv.DB, 9000, options)).selected).toBe(0);
    expect(await testEnv.DB.prepare('SELECT * FROM requests').first()).toEqual(before);
    await add('pending'); await testEnv.DB.prepare("UPDATE requests SET billing_status='settlement_pending' WHERE id='pending'").run();
    expect((await markAbandonedRequests(testEnv.DB, 9000, options)).selected).toBe(0);
  });

  it('excludes existing ledgers from abandonment', async () => {
    await settle(); const before = await testEnv.DB.prepare('SELECT * FROM requests').first();
    expect((await markAbandonedRequests(testEnv.DB, 9000, options)).abandoned).toBe(0);
    expect(await testEnv.DB.prepare('SELECT * FROM requests').first()).toEqual(before);
  });

  it('permits a late complete settlement without inventing usage during abandonment', async () => {
    await markAbandonedRequests(testEnv.DB, 3000, options);
    expect(await testEnv.DB.prepare('SELECT cost_units FROM requests').first('cost_units')).toBeNull();
    await settle();
    expect(await testEnv.DB.prepare('SELECT execution_status,billing_status,usage_quality,cost_units FROM requests').first())
      .toEqual({ execution_status: 'abandoned', billing_status: 'settled', usage_quality: 'complete', cost_units: 200000 });
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(1);
  });

  it.each(['success', 'ledger', 'start'])('rechecks a late %s occurring after selection but before marking', async action => {
    let changed = false;
    function wrap(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
      return new Proxy(statement, { get(target, property) {
        if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), sql);
        if (property === 'all') return async () => {
          const result = await target.all();
          if (!changed && sql.startsWith('SELECT id,user_id,created_at,started_at')) {
            changed = true;
            if (action === 'success') await finishRequest(testEnv.DB, 'b16-request', 'b16-user', { status: 'succeeded' }, 3000);
            if (action === 'ledger') await settle();
            if (action === 'start') await markRequestStarted(testEnv.DB, 'b16-request', 'b16-user', 3000);
          }
          return result;
        };
        const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
      } });
    }
    const raced = { prepare: (sql: string) => wrap(testEnv.DB.prepare(sql), sql) } as unknown as D1Database;
    expect(await markAbandonedRequests(raced, 3000, options)).toEqual({ selected: 1, abandoned: 0, skipped: 1 });
    const row = await testEnv.DB.prepare('SELECT execution_status,billing_status,started_at FROM requests').first();
    if (action === 'success') expect(row).toMatchObject({ execution_status: 'succeeded' });
    if (action === 'ledger') expect(row).toMatchObject({ billing_status: 'settled' });
    if (action === 'start') expect(row).toMatchObject({ execution_status: 'admitted', started_at: 3000 });
  });

  it('handles overlapping runs and bounded batches without repeated marking', async () => {
    await add('second'); await add('third');
    const runs = await Promise.all([markAbandonedRequests(testEnv.DB, 3000, { ...options, limit: 1 }), markAbandonedRequests(testEnv.DB, 3000, { ...options, limit: 1 })]);
    expect(runs.reduce((n, result) => n + result.abandoned, 0)).toBeLessThanOrEqual(2);
    await markAbandonedRequests(testEnv.DB, 3000, options);
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM requests WHERE execution_status='abandoned'").first('n')).toBe(3);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(0);
  });

  it('rejects unsafe limits/time arithmetic and fails closed on unavailable D1', async () => {
    for (const settings of [{ limit: 0 }, { limit: 101 }, { graceMs: -1 }, { requestMaxDurationMs: 0 }, { requestMaxDurationMs: Number.MAX_SAFE_INTEGER, graceMs: 1 }])
      await expect(markAbandonedRequests(testEnv.DB, 3000, settings)).rejects.toMatchObject({ code: 'invalid_request' });
    const unavailable = { prepare() { throw new Error('Synthetic'); } } as unknown as D1Database;
    await expect(markAbandonedRequests(unavailable, 3000, options)).rejects.toMatchObject({ code: 'service_unavailable' });
  });
});
