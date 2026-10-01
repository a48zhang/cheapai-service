import { beforeEach, describe, expect, it } from 'vitest';
import { saveSettlementRecovery } from '../../apps/worker/billing/recovery';
import { settleConsumption } from '../../apps/worker/billing/settlement-repository';
import { createPriceSnapshot } from '../../apps/worker/billing/fingerprint';
import { encryptChannelSecret } from '../../apps/worker/admin/channel-secrets';
import type { UsageSnapshot } from '../../packages/apicompat/types/shared';
import { testEnv } from '../helpers/database';

const usage = (): UsageSnapshot => ({ quality: 'complete', protocol: 'chat', counts: { inputTokens: 1000, outputTokens: 500 },
  semantics: { cacheRead: 'included_in_input', cacheWrite: 'included_in_input', reasoning: 'included_in_output', cacheWriteTtl: 'unknown' }, sources: [{ protocol: 'chat', path: 'usage' }], issues: [] });
let price: string;
const recover = (value = usage()) => saveSettlementRecovery(testEnv.DB, { requestId: 'b14-request', userId: 'b14-user', usage: value }, 2000);
const settle = () => settleConsumption(testEnv.DB, { operationId: 'consume:b14-request', userId: 'b14-user', requestId: 'b14-request', priceSnapshotJson: price, usage: usage(), costUnits: '200000' }, 2000);
beforeEach(async () => {
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('b14-group','Fixture','active',1,0,0)").run();
  await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES('b14-user','b14@example.invalid','synthetic','user','active','b14-group',100000,1,60,'admin',0,0)`).run();
  await testEnv.DB.prepare("INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at) VALUES('b14-key','b14-user',?,'s2a_key_ABCDEFGH','Fixture','active',0,0)").bind('4'.repeat(64)).run();
  const encrypted = await encryptChannelSecret('synthetic', 'b14-channel', 'v1', crypto.getRandomValues(new Uint8Array(32)));
  await testEnv.DB.prepare(`INSERT INTO channels(id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES('b14-channel','Fixture','https://example.invalid',?,'v1','active',0,1,60,1,0,0)`).bind(encrypted).run();
  await testEnv.DB.prepare(`INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES ('b14-model','active','{"input":"1","output":"2"}',1,0,10,0,0)`).run();
  price = createPriceSnapshot({ publicModelId: 'b14-model', upstreamModel: 'provider-model', upstreamProtocol: 'chat', priceVersion: 1, sellPrices: { input: '1', output: '2' } }).json;
  await testEnv.DB.prepare(`INSERT INTO requests(id,user_id,api_key_id,channel_id,public_model_id,upstream_model,downstream_protocol,upstream_protocol,price_snapshot,created_at,updated_at)
    VALUES('b14-request','b14-user','b14-key','b14-channel','b14-model','provider-model','chat','chat',?,1000,1000)`).bind(price).run();
});

describe('B14 conditional recovery evidence', () => {
  it('saves complete original-price facts without charging or replacing the snapshot', async () => {
    expect(await recover()).toMatchObject({ saved: true, billingStatus: 'settlement_pending' });
    const row = await testEnv.DB.prepare('SELECT * FROM requests').first();
    expect(row).toMatchObject({ price_snapshot: price, usage_quality: 'complete', cost_units: 200000, retry_count: 0, next_retry_at: 2000 });
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(0);
    await testEnv.DB.prepare('UPDATE requests SET retry_count=3,next_retry_at=9000').run();
    await recover(); expect(await testEnv.DB.prepare('SELECT retry_count,next_retry_at FROM requests').first()).toEqual({ retry_count: 3, next_retry_at: 9000 });
  });

  it('keeps the admitted multiplier when the group changes before recovery settles', async () => {
    await testEnv.DB.prepare("UPDATE groups SET billing_multiplier='0.2' WHERE id='b14-group'").run();
    price = createPriceSnapshot({ publicModelId: 'b14-model', upstreamModel: 'provider-model', upstreamProtocol: 'chat', priceVersion: 1,
      groupId: 'b14-group', groupVersion: 1, billingMultiplier: '0.2', sellPrices: { input: '1', output: '2' } }).json;
    await testEnv.DB.prepare("UPDATE requests SET price_snapshot=? WHERE id='b14-request'").bind(price).run();
    await testEnv.DB.prepare("UPDATE groups SET billing_multiplier='1',version=2 WHERE id='b14-group'").run();

    expect(await recover()).toMatchObject({ saved: true, billingStatus: 'settlement_pending' });
    expect(await testEnv.DB.prepare("SELECT cost_units FROM requests WHERE id='b14-request'").first('cost_units')).toBe(40000);
    const settled = await settleConsumption(testEnv.DB, { operationId: 'consume:b14-request', userId: 'b14-user', requestId: 'b14-request',
      priceSnapshotJson: price, usage: usage(), costUnits: '40000' }, 2000);
    expect(settled.entry.costUnits).toBe('40000');
    expect(await testEnv.DB.prepare("SELECT balance_units FROM users WHERE id='b14-user'").first('balance_units')).toBe(60000);
    expect(JSON.parse((await testEnv.DB.prepare("SELECT price_snapshot FROM billing_entries WHERE request_id='b14-request'").first('price_snapshot'))!)).toMatchObject({ billing_multiplier: '0.2' });
  });

  it('retains missing/unpriceable evidence as unknown without inventing zero charges', async () => {
    expect(await recover({ quality: 'missing', protocol: 'chat' })).toMatchObject({ billingStatus: 'usage_unknown' });
    expect(await testEnv.DB.prepare('SELECT usage_quality,cost_units,fingerprint FROM requests').first()).toEqual({ usage_quality: 'missing', cost_units: null, fingerprint: null });
    const bad = usage(); if (bad.quality !== 'complete') throw new Error();
    await recover({ ...bad, counts: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 2 } });
    expect(await testEnv.DB.prepare('SELECT usage_quality,cost_units FROM requests').first()).toEqual({ usage_quality: 'invalid', cost_units: null });
    expect((await recover()).billingStatus).toBe('settlement_pending');
  });

  it('cannot replace complete pending evidence with partial data or conflicting complete facts', async () => {
    await recover(); const before = await testEnv.DB.prepare('SELECT * FROM requests').first();
    expect((await recover({ quality: 'missing', protocol: 'chat' })).saved).toBe(false);
    const different = usage(); if (different.quality !== 'complete') throw new Error();
    await expect(recover({ ...different, counts: { inputTokens: 2000, outputTokens: 500 } })).rejects.toMatchObject({ code: 'conflict' });
    expect(await testEnv.DB.prepare('SELECT * FROM requests').first()).toEqual(before);
  });

  it('never downgrades an existing or concurrently inserted ledger', async () => {
    await Promise.all([recover(), settle()]);
    const before = await testEnv.DB.prepare('SELECT * FROM requests').first();
    expect(before).toMatchObject({ billing_status: 'settled' });
    expect(await recover({ quality: 'missing', protocol: 'chat' })).toMatchObject({ saved: false, billingStatus: 'settled' });
    expect(await testEnv.DB.prepare('SELECT * FROM requests').first()).toEqual(before);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(1);
  });

  it('rejects foreign scope/price overrides and propagates unavailable D1', async () => {
    await expect(saveSettlementRecovery(testEnv.DB, { requestId: 'b14-request', userId: 'other', usage: usage() }, 2000)).rejects.toMatchObject({ code: 'not_found' });
    await expect(saveSettlementRecovery(testEnv.DB, { requestId: 'b14-request', userId: 'b14-user', usage: usage(), priceSnapshotJson: '{}' } as never, 2000)).rejects.toMatchObject({ code: 'invalid_request' });
    const unavailable = { prepare() { throw new Error('Synthetic failure'); } } as unknown as D1Database;
    await expect(saveSettlementRecovery(unavailable, { requestId: 'b14-request', userId: 'b14-user', usage: usage() }, 2000)).rejects.toMatchObject({ code: 'service_unavailable' });
  });
});
