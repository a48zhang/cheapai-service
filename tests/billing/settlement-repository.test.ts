import { beforeEach, describe, expect, it } from 'vitest';
import { settleConsumption, findConsumptionSettlement, prepareConsumptionSettlement } from '../../apps/worker/billing/settlement-repository';
import type { ConsumptionSettlementInput } from '../../apps/worker/billing/settlement-repository';
import { createPriceSnapshot } from '../../apps/worker/billing/fingerprint';
import type { UsageSnapshot } from '../../packages/apicompat/types/shared';
import { testEnv } from '../helpers/database';

// Original synthetic native-D1 fixtures. No provider calls or real credentials.
const usage = (): UsageSnapshot => ({ quality: 'complete', protocol: 'chat', counts: { inputTokens: 1000, outputTokens: 500 },
  semantics: { cacheRead: 'included_in_input', cacheWrite: 'included_in_input', reasoning: 'included_in_output', cacheWriteTtl: 'unknown' },
  sources: [{ protocol: 'chat', path: 'usage' }], issues: [] });
const price = () => createPriceSnapshot({ publicModelId: 'b04-model', upstreamModel: 'provider-model', upstreamProtocol: 'chat', priceVersion: 1, sellPrices: { input: '500', output: '500' } }).json;
const input = (requestId = 'b04-request'): ConsumptionSettlementInput => ({ operationId: `consume:${requestId}`, userId: 'b04-user', requestId, priceSnapshotJson: price(), usage: usage(), costUnits: '75000000' });
async function request(id = 'b04-request') {
  await testEnv.DB.prepare(`INSERT INTO requests (id,user_id,api_key_id,channel_id,public_model_id,upstream_model,downstream_protocol,upstream_protocol,price_snapshot,execution_status,created_at,updated_at)
    VALUES (?,'b04-user','b04-key','b04-channel','b04-model','provider-model','responses','chat',?,'succeeded',1000,1000)`).bind(id, price()).run();
}
async function state() {
  return { balance: await testEnv.DB.prepare("SELECT balance_units FROM users WHERE id='b04-user'").first('balance_units'),
    requests: (await testEnv.DB.prepare('SELECT * FROM requests ORDER BY id').all()).results,
    entries: (await testEnv.DB.prepare('SELECT * FROM billing_entries ORDER BY id').all()).results };
}

/** Real D1 executes all SQL; only the transport acknowledgement/read is faulted. */
function uncertainDatabase(options: { beforeCommit?: boolean; loseRead?: boolean } = {}): D1Database {
  let failed = false;
  return new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (options.beforeCommit && !failed) { failed = true; throw new Error('synthetic_unavailable'); }
        const result = await target.batch(statements);
        if (!failed) { failed = true; throw new Error('synthetic_lost_acknowledgement'); }
        return result;
      };
      if (property === 'prepare') return (sql: string) => {
        if (failed && options.loseRead && sql.includes('FROM billing_entries')) throw new Error('synthetic_read_unavailable');
        return target.prepare(sql);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('atomic consumption repository in native D1', () => {
  beforeEach(async () => {
    await testEnv.DB.prepare("INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES ('b04-group','Synthetic group','active',1,0,0)").run();
    for (const id of ['b04-user', 'b04-other']) {
      await testEnv.DB.prepare(`INSERT INTO users (id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
        VALUES (?,?,'synthetic-only','user','active','b04-group',50000000,2,60,'admin',0,0)`).bind(id, `${id}@example.invalid`).run();
    }
    for (const [key, owner, hash] of [['b04-key', 'b04-user', 'a'], ['b04-other-key', 'b04-other', 'b']] as const) {
      await testEnv.DB.prepare(`INSERT INTO api_keys (id,user_id,key_hash,display_prefix,name,status,created_at,updated_at)
        VALUES (?,?,?,'s2a_key_ABCDEFGH','Synthetic key','active',0,0)`).bind(key, owner, hash.repeat(64)).run();
    }
    const credential = 'synthetic-upstream';
    await testEnv.DB.prepare(`INSERT INTO channels (id,name,base_url,upstream_key,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
      VALUES ('b04-channel','Synthetic channel','https://example.invalid',?,'active',0,2,60,1,0,0)`).bind(credential).run();
    // Today's prices deliberately differ from the already admitted snapshot.
    await testEnv.DB.prepare(`INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES ('b04-model','active','{"input":"1","output":"2"}',2,0,4096,0,0)`).run();
    await request();
  });

  it('charges 0.75 USD against 0.50 atomically using original price/usage evidence', async () => {
    const expected = await prepareConsumptionSettlement(input());
    const settled = await settleConsumption(testEnv.DB, { ...input(), fingerprint: 'ignored' } as ConsumptionSettlementInput, 2000);
    expect(settled.outcome).toBe('inserted');
    expect(settled.entry).toMatchObject({ kind: 'consumption', userId: 'b04-user', requestId: 'b04-request', currency: 'USD', deltaUnits: '-75000000', costUnits: '75000000', fingerprint: expected.fingerprint, priceSnapshotJson: price(), usageSnapshotJson: expected.usageSnapshotJson, createdAt: 2000 });
    const saved = await state();
    expect(saved.balance).toBe(-25_000_000);
    expect(saved.entries).toHaveLength(1);
    expect(saved.requests[0]).toMatchObject({ billing_status: 'settled', execution_status: 'succeeded', cost_units: 75_000_000, usage_quality: 'complete', fingerprint: expected.fingerprint, usage_json: expected.usageSnapshotJson });
  });

  it('returns the existing entry for identical replay regardless of retry time or integer representation', async () => {
    const first = await settleConsumption(testEnv.DB, input(), 2000);
    const before = await state();
    const second = await settleConsumption(testEnv.DB, { ...input(), costUnits: 75000000n }, 99999);
    expect(second).toEqual({ outcome: 'existing', entry: first.entry });
    expect(await findConsumptionSettlement(testEnv.DB, input())).toEqual(first.entry);
    expect(await state()).toEqual(before);
  });

  it('serializes concurrent identical retries into exactly one debit', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => settleConsumption(testEnv.DB, input(), 2000 + index)));
    expect(results.filter(result => result.outcome === 'inserted')).toHaveLength(1);
    expect(new Set(results.map(result => result.entry.id)).size).toBe(1);
    expect((await state()).balance).toBe(-25_000_000);
    expect((await state()).entries).toHaveLength(1);
  });

  it('allows different incurred requests to debit concurrently without lost balance updates', async () => {
    await request('b04-second');
    const results = await Promise.all([settleConsumption(testEnv.DB, input(), 2000), settleConsumption(testEnv.DB, input('b04-second'), 2000)]);
    expect(results.every(result => result.outcome === 'inserted')).toBe(true);
    expect((await state()).balance).toBe(-100_000_000);
    expect((await state()).entries).toHaveLength(2);
  });

  it('rejects changed facts or an alternate operation for the same request with 409', async () => {
    await settleConsumption(testEnv.DB, input(), 2000);
    const before = await state();
    const evidence = usage();
    if (evidence.quality !== 'complete') throw new Error('Expected complete synthetic evidence');
    for (const patch of [
      { costUnits: '75000001' }, { operationId: 'different-operation' }, { userId: 'b04-other' }, { requestId: 'different-request' },
      { priceSnapshotJson: ` ${price()}` }, { usage: { ...evidence, counts: { inputTokens: 1001, outputTokens: 500 } } },
    ]) await expect(settleConsumption(testEnv.DB, { ...input(), ...patch }, 3000)).rejects.toMatchObject({ code: 'conflict' });
    expect(await state()).toEqual(before);
  });

  it('detects both operation and request uniqueness conflicts even if they identify two rows', async () => {
    await request('b04-second');
    await settleConsumption(testEnv.DB, input(), 2000);
    await settleConsumption(testEnv.DB, input('b04-second'), 2000);
    const before = await state();
    await expect(findConsumptionSettlement(testEnv.DB, { ...input(), requestId: 'b04-second' })).rejects.toMatchObject({ code: 'conflict' });
    expect(await state()).toEqual(before);
  });

  it('never treats another user or operation kind as a matching replay', async () => {
    await testEnv.DB.prepare(`INSERT INTO billing_entries (id,operation_id,kind,user_id,currency,delta_units,fingerprint,reason,created_at)
      VALUES ('b04-grant',?,'grant','b04-other','USD',1,'synthetic-other-fingerprint','Synthetic grant',1500)`).bind(input().operationId).run();
    const before = await state();
    await expect(settleConsumption(testEnv.DB, input(), 2000)).rejects.toMatchObject({ code: 'conflict' });
    await expect(findConsumptionSettlement(testEnv.DB, input())).rejects.toMatchObject({ code: 'conflict' });
    expect(await state()).toEqual(before);
  });

  it('validates request/key ownership, snapshot bytes and selected model identity in SQL', async () => {
    const before = await state();
    for (const patch of [{ userId: 'b04-other' }, { requestId: 'missing' }, { priceSnapshotJson: `\n${price()}` }]) {
      await expect(settleConsumption(testEnv.DB, { ...input(), ...patch }, 2000)).rejects.toMatchObject({ code: 'conflict' });
      expect(await state()).toEqual(before);
    }
    for (const [column, changed, original] of [
      ['api_key_id', 'b04-other-key', 'b04-key'], ['upstream_model', 'wrong-upstream', 'provider-model'],
      ['upstream_protocol', 'responses', 'chat'], ['fingerprint', 'different-pending-fingerprint', null], ['billing_status', 'settled', 'awaiting_usage'],
    ] as const) {
      // Column identifiers are fixed test constants; all values remain bound.
      await testEnv.DB.prepare(`UPDATE requests SET ${column}=? WHERE id='b04-request'`).bind(changed).run();
      await expect(settleConsumption(testEnv.DB, input(), 2000)).rejects.toMatchObject({ code: 'conflict' });
      await testEnv.DB.prepare(`UPDATE requests SET ${column}=? WHERE id='b04-request'`).bind(original).run();
    }
    expect(await state()).toEqual(before);
  });

  it('reuses the exact stored noncanonical snapshot text and matching pending fingerprint', async () => {
    const raw = ` \n${JSON.stringify(JSON.parse(price()), null, 2)}\n`;
    const submitted = { ...input(), priceSnapshotJson: raw };
    const prepared = await prepareConsumptionSettlement(submitted);
    await testEnv.DB.prepare("UPDATE requests SET price_snapshot=?,fingerprint=?,billing_status='settlement_pending' WHERE id='b04-request'").bind(raw, prepared.fingerprint).run();
    const result = await settleConsumption(testEnv.DB, submitted, 2000);
    expect(result.entry.priceSnapshotJson).toBe(raw);
    expect(await testEnv.DB.prepare('SELECT price_snapshot FROM billing_entries').first('price_snapshot')).toBe(raw);
  });

  it('settles already incurred use after identities/config are disabled and the balance is negative', async () => {
    await testEnv.DB.prepare("UPDATE users SET status='disabled',balance_units=-100 WHERE id='b04-user'").run();
    await testEnv.DB.prepare("UPDATE api_keys SET status='revoked' WHERE id='b04-key'").run();
    await testEnv.DB.prepare("UPDATE channels SET status='disabled' WHERE id='b04-channel'").run();
    await testEnv.DB.prepare("UPDATE models SET status='disabled' WHERE public_model_id='b04-model'").run();
    await testEnv.DB.prepare("UPDATE requests SET execution_status='cancelled' WHERE id='b04-request'").run();
    await settleConsumption(testEnv.DB, input(), 2000);
    expect((await state()).balance).toBe(-75_000_100);
    expect((await state()).requests[0]).toMatchObject({ execution_status: 'cancelled', billing_status: 'settled' });
  });

  it('accepts explicit zero-price consumption without fabricating missing usage', async () => {
    const free = createPriceSnapshot({ publicModelId: 'b04-model', upstreamModel: 'provider-model', upstreamProtocol: 'chat', priceVersion: 1, sellPrices: { input: '0', output: '0' } }).json;
    await testEnv.DB.prepare("UPDATE requests SET price_snapshot=? WHERE id='b04-request'").bind(free).run();
    const result = await settleConsumption(testEnv.DB, { ...input(), priceSnapshotJson: free, costUnits: 0n }, 2000);
    expect(result.entry.costUnits).toBe('0');
    expect((await state()).balance).toBe(50_000_000);
  });

  it('recovers a committed insert whose acknowledgement was lost without a second debit', async () => {
    const recovered = await settleConsumption(uncertainDatabase(), input(), 2000);
    expect(recovered.outcome).toBe('existing');
    expect((await state()).entries).toHaveLength(1);
    expect((await state()).balance).toBe(-25_000_000);
  });

  it('leaves uncertain outcomes retryable with the same facts when reconciliation is also unavailable', async () => {
    await expect(settleConsumption(uncertainDatabase({ loseRead: true }), input(), 2000)).rejects.toMatchObject({ code: 'service_unavailable' });
    const before = await state();
    const found = await findConsumptionSettlement(testEnv.DB, input());
    expect(found).not.toBeNull();
    expect((await settleConsumption(testEnv.DB, input(), 3000)).entry).toEqual(found);
    expect(await state()).toEqual(before);
  });

  it('distinguishes a failed precommit submission and allows the same operation to retry later', async () => {
    await expect(settleConsumption(uncertainDatabase({ beforeCommit: true }), input(), 2000)).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(await findConsumptionSettlement(testEnv.DB, input())).toBeNull();
    expect((await state()).entries).toHaveLength(0);
    expect((await settleConsumption(testEnv.DB, input(), 3000)).outcome).toBe('inserted');
    expect((await state()).entries).toHaveLength(1);
  });

  it('rolls back ledger and balance when the D13 request update is blocked', async () => {
    const before = await state();
    await testEnv.DB.exec("CREATE TRIGGER b04_ignore_request_update BEFORE UPDATE ON requests BEGIN SELECT RAISE(IGNORE); END;");
    await expect(settleConsumption(testEnv.DB, input(), 2000)).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(await state()).toEqual(before);
  });

  it('rolls back a zero-row insert including side effects from an ignored insert trigger', async () => {
    const before = await state();
    await testEnv.DB.exec("CREATE TRIGGER b04_ignore_entry BEFORE INSERT ON billing_entries BEGIN UPDATE groups SET version=version+1 WHERE id='b04-group'; SELECT RAISE(IGNORE); END;");
    await expect(settleConsumption(testEnv.DB, input(), 2000)).rejects.toMatchObject({ code: 'conflict' });
    expect(await state()).toEqual(before);
    expect(await testEnv.DB.prepare("SELECT version FROM groups WHERE id='b04-group'").first('version')).toBe(1);
  });

  it('fails safely on bounded-integer balance overflow without treating it as insufficient funds', async () => {
    await testEnv.DB.prepare("UPDATE users SET balance_units=? WHERE id='b04-user'").bind(-Number.MAX_SAFE_INTEGER).run();
    const before = await state();
    await expect(settleConsumption(testEnv.DB, input(), 2000)).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(await state()).toEqual(before);
  });

  it('rejects unsafe amounts and incomplete usage before a write', async () => {
    const before = await state();
    const evidence = usage();
    if (evidence.quality !== 'complete') throw new Error('Expected complete evidence');
    for (const patch of [
      { costUnits: -1n }, { costUnits: 75000000 }, { costUnits: '0.1' }, { costUnits: '9007199254740992' },
      { costUnits: undefined }, { priceSnapshotJson: '{}' },
      { usage: { quality: 'partial', protocol: 'chat' } }, { usage: { ...evidence, sources: [] } },
      { usage: { ...evidence, counts: { inputTokens: -1, outputTokens: 0 } } },
    ]) await expect(settleConsumption(testEnv.DB, { ...input(), ...patch } as unknown as ConsumptionSettlementInput, 2000)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await state()).toEqual(before);
  });
});
