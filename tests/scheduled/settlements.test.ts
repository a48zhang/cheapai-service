import { beforeEach, describe, expect, it } from 'vitest';
import { retryPendingSettlements, SETTLEMENT_BACKOFF_MS } from '../../apps/worker/scheduled/settlements';
import { saveSettlementRecovery } from '../../apps/worker/billing/recovery';
import { createPriceSnapshot } from '../../apps/worker/billing/fingerprint';
import type { UsageSnapshot } from '../../packages/apicompat/types/shared';
import { testEnv } from '../helpers/database';

const usage: UsageSnapshot = { quality: 'complete', protocol: 'chat', counts: { inputTokens: 1000, outputTokens: 500 },
  semantics: { cacheRead: 'included_in_input', cacheWrite: 'included_in_input', reasoning: 'included_in_output', cacheWriteTtl: 'unknown' }, sources: [{ protocol: 'chat', path: 'usage' }], issues: [] };
let price: string;
async function pending(id: string) {
  await testEnv.DB.prepare(`INSERT INTO requests(id,user_id,api_key_id,channel_id,public_model_id,upstream_model,downstream_protocol,upstream_protocol,price_snapshot,created_at,updated_at)
    VALUES(?,'b15-user','b15-key','b15-channel','b15-model','provider','chat','chat',?,0,0)`).bind(id, price).run();
  await saveSettlementRecovery(testEnv.DB, { requestId: id, userId: 'b15-user', usage }, 1000);
}
beforeEach(async () => {
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('b15-group','Fixture','active',1,0,0)").run();
  await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES('b15-user','b15@example.invalid','synthetic','user','active','b15-group',100000,1,60,'admin',0,0)`).run();
  await testEnv.DB.prepare("INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at) VALUES('b15-key','b15-user',?,'s2a_key_ABCDEFGH','Fixture','active',0,0)").bind('5'.repeat(64)).run();
  const credential = 'synthetic';
  await testEnv.DB.prepare(`INSERT INTO channels(id,name,base_url,upstream_key,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES('b15-channel','Fixture','https://example.invalid',?,'active',0,1,60,1,0,0)`).bind(credential).run();
  await testEnv.DB.prepare(`INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES ('b15-model','active','{"input":"1","output":"2"}',1,0,10,0,0)`).run();
  price = createPriceSnapshot({ publicModelId: 'b15-model', upstreamModel: 'provider', upstreamProtocol: 'chat', priceVersion: 1, sellPrices: { input: '1', output: '2' } }).json;
  await pending('b15-request');
});

describe('B15 bounded scheduled settlement', () => {
  it('settles saved evidence locally with the original operation and no model regeneration', async () => {
    expect(await retryPendingSettlements(testEnv.DB, 2000)).toMatchObject({ selected: 1, claimed: 1, settled: 1 });
    expect(await testEnv.DB.prepare('SELECT billing_status,next_retry_at FROM requests').first()).toEqual({ billing_status: 'settled', next_retry_at: null });
    expect(await testEnv.DB.prepare('SELECT operation_id,price_snapshot FROM billing_entries').first()).toEqual({ operation_id: 'consume:b15-request', price_snapshot: price });
    expect(await testEnv.DB.prepare('SELECT balance_units FROM users').first('balance_units')).toBe(-100000);
  });

  it('lets overlapping runs claim one round and debit once', async () => {
    const runs = await Promise.all([retryPendingSettlements(testEnv.DB, 2000), retryPendingSettlements(testEnv.DB, 2000)]);
    expect(runs.reduce((sum, result) => sum + result.claimed, 0)).toBe(1);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(1);
    const before = await testEnv.DB.prepare('SELECT * FROM requests').first();
    await retryPendingSettlements(testEnv.DB, 999999);
    expect(await testEnv.DB.prepare('SELECT * FROM requests').first()).toEqual(before);
  });

  it('stops after five failed rounds with bounded backoff and keeps manual evidence', async () => {
    let writes = 0;
    const failed = new Proxy(testEnv.DB, { get(target, property) {
      if (property === 'batch') return async () => { writes++; throw new Error('Synthetic failure'); };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    let now = 2000;
    for (let round = 1; round <= 5; round++) {
      expect((await retryPendingSettlements(failed, now)).claimed).toBe(1);
      const row = await testEnv.DB.prepare('SELECT retry_count,next_retry_at,billing_status FROM requests').first<{ retry_count: number; next_retry_at: number | null; billing_status: string }>();
      expect(row?.retry_count).toBe(round); expect(row?.billing_status).toBe('settlement_pending');
      if (round < 5) { expect(row?.next_retry_at).toBe(now + SETTLEMENT_BACKOFF_MS[round - 1]!); now = row!.next_retry_at!; }
      else expect(row?.next_retry_at).toBeNull();
    }
    expect((await retryPendingSettlements(failed, now + 999999)).selected).toBe(0); expect(writes).toBe(5);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(0);
  });

  it('only selects due records within the requested page size', async () => {
    await pending('b15-second'); await pending('b15-third');
    await testEnv.DB.prepare("UPDATE requests SET next_retry_at=9000 WHERE id='b15-third'").run();
    expect((await retryPendingSettlements(testEnv.DB, 2000, { limit: 1 })).selected).toBe(1);
    expect((await retryPendingSettlements(testEnv.DB, 2000, { limit: 1 })).selected).toBe(1);
    expect((await retryPendingSettlements(testEnv.DB, 2000)).selected).toBe(0);
  });

  it('does not trust tampered cost/fingerprint evidence', async () => {
    await testEnv.DB.prepare('UPDATE requests SET cost_units=1').run();
    expect(await retryPendingSettlements(testEnv.DB, 2000)).toMatchObject({ invalid: 1, settled: 0 });
    expect(await testEnv.DB.prepare('SELECT next_retry_at,error_code FROM requests').first()).toEqual({ next_retry_at: null, error_code: 'settlement_evidence_invalid' });
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(0);
  });

  it('recovers an uncertain commit without another debit', async () => {
    let writes = 0;
    const lost = new Proxy(testEnv.DB, { get(target, property) {
      if (property === 'batch') return async (statements: D1PreparedStatement[]) => { writes++; await target.batch(statements); throw new Error('Synthetic lost ack'); };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    expect((await retryPendingSettlements(lost, 2000)).settled).toBe(1); expect(writes).toBe(1);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(1);
  });
});
