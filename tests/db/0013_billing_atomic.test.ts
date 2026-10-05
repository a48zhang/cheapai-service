import { beforeEach, describe, expect, it } from 'vitest';
import { legacyChannelSecret } from '../helpers/legacy-channel-secret';
import { calculatePrice } from '../../apps/worker/billing/pricing';
import type { UsageSnapshot } from '../../packages/apicompat/types/shared';
import { testEnv } from '../helpers/database';

const price = JSON.stringify({ schema_version: 1, prices: { input: '500', output: '500' }, price_version: 1 });
const usage = {
  quality: 'complete', protocol: 'chat', counts: { inputTokens: 1000, outputTokens: 500 },
  semantics: { cacheRead: 'included_in_input', cacheWrite: 'included_in_input', reasoning: 'included_in_output', cacheWriteTtl: 'unknown' },
  sources: [{ protocol: 'chat', path: 'usage' }], issues: [],
};
type Value = string | number | null;
function entry(overrides: Record<string, Value> = {}, replace = false) {
  const row = {
    id: 'd13-entry', operation_id: 'd13-operation', kind: 'consumption', user_id: 'd13-user', request_id: 'd13-request',
    currency: 'USD', delta_units: -75_000_000, fingerprint: 'd13-fingerprint', usage_snapshot: JSON.stringify(usage),
    price_snapshot: price, created_at: 2000, ...overrides,
  };
  return testEnv.DB.prepare(`INSERT ${replace ? 'OR REPLACE ' : ''}INTO billing_entries (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).bind(...Object.values(row));
}
async function request(id = 'd13-request', overrides: Record<string, Value> = {}) {
  const row = { id, user_id: 'd13-user', api_key_id: 'd13-key', channel_id: 'd13-channel', public_model_id: 'd13-model', upstream_model: 'provider-model', downstream_protocol: 'responses', upstream_protocol: 'chat', price_snapshot: price, execution_status: 'succeeded', created_at: 1000, updated_at: 1000, ...overrides };
  await testEnv.DB.prepare(`INSERT INTO requests (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).bind(...Object.values(row)).run();
}
async function state() {
  return {
    balance: await testEnv.DB.prepare("SELECT balance_units FROM users WHERE id='d13-user'").first('balance_units'),
    request: await testEnv.DB.prepare("SELECT * FROM requests WHERE id='d13-request'").first(),
    ledger: (await testEnv.DB.prepare('SELECT * FROM billing_entries ORDER BY id').all()).results,
  };
}

describe('0013 atomic billing in native D1', () => {
  beforeEach(async () => {
    await testEnv.DB.prepare("INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES ('d13-group','D13 group','active',1,0,0)").run();
    for (const id of ['d13-user', 'd13-other']) {
      await testEnv.DB.prepare(`INSERT INTO users (id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
        VALUES (?,?,'test-only','user','active','d13-group',50000000,2,60,'admin',0,0)`).bind(id, `${id}@example.invalid`).run();
    }
    for (const [id, owner, hash] of [['d13-key', 'd13-user', 'a'], ['d13-other-key', 'd13-other', 'b']]) {
      await testEnv.DB.prepare("INSERT INTO api_keys (id,user_id,key_hash,display_prefix,name,status,created_at,updated_at) VALUES (?,?,?,'s2a_key_ABCDEFGH','D13 key','active',0,0)").bind(id, owner, hash!.repeat(64)).run();
    }
    const encrypted = legacyChannelSecret();
    await testEnv.DB.prepare(`INSERT INTO channels (id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
      VALUES ('d13-channel','D13 channel','https://example.invalid',?,'test-v1','active',0,2,60,1,0,0)`).bind(encrypted).run();
    await testEnv.DB.prepare(`INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,default_output_tokens,created_at,updated_at)
      VALUES ('d13-model','active','{"input":"1","output":"2"}',1,0,4096,1024,0,0)`).run();
    await request();
  });

  it('atomically charges 0.75 USD against 0.50, preserving complete evidence and negative balance', async () => {
    expect(calculatePrice(usage as UsageSnapshot, { input: '500', output: '500' }).costUnits).toBe(75_000_000n);
    await entry().run();
    const saved = await state();
    expect(saved.balance).toBe(-25_000_000);
    expect(saved.ledger).toHaveLength(1);
    expect(saved.request).toMatchObject({ execution_status: 'succeeded', billing_status: 'settled', usage_json: JSON.stringify(usage), usage_quality: 'complete', cost_units: 75_000_000, fingerprint: 'd13-fingerprint', updated_at: 2000 });
  });

  it('allows zero-cost consumption and real usage from a cancelled execution', async () => {
    await testEnv.DB.prepare("UPDATE requests SET execution_status='cancelled' WHERE id='d13-request'").run();
    await entry({ delta_units: 0 }).run();
    expect((await state()).request).toMatchObject({ execution_status: 'cancelled', billing_status: 'settled', cost_units: 0 });
    expect((await state()).balance).toBe(50_000_000);
  });

  it('settles incurred usage even when the admitted user/key/channel/model were subsequently disabled', async () => {
    await testEnv.DB.prepare("UPDATE users SET status='disabled', balance_units=-100 WHERE id='d13-user'").run();
    await testEnv.DB.prepare("UPDATE api_keys SET status='revoked' WHERE id='d13-key'").run();
    await testEnv.DB.prepare("UPDATE channels SET status='disabled' WHERE id='d13-channel'").run();
    await testEnv.DB.prepare("UPDATE models SET status='disabled' WHERE public_model_id='d13-model'").run();
    await entry().run();
    expect((await state()).balance).toBe(-75_000_100);
    expect((await state()).request).toMatchObject({ billing_status: 'settled', cost_units: 75_000_000 });
  });

  it('rejects replay/REPLACE without another debit, including a response whose result was lost', async () => {
    await entry().run(); // Commit happened; pretend the caller never received this response.
    const before = await state();
    const outcomes = await Promise.allSettled(Array.from({ length: 10 }, () => entry().run()));
    expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true);
    await expect(entry({ id: 'other-id', operation_id: 'other-op' }).run()).rejects.toThrow();
    await expect(entry({ delta_units: -1, fingerprint: 'different' }, true).run()).rejects.toThrow();
    expect(await state()).toEqual(before);
    const committed = await testEnv.DB.prepare('SELECT fingerprint,delta_units FROM billing_entries WHERE operation_id=?').bind('d13-operation').first();
    expect(committed).toEqual({ fingerprint: 'd13-fingerprint', delta_units: -75_000_000 });
  });

  it('serializes concurrent settlements with no lost balance updates or duplicate consumption', async () => {
    await request('d13-second');
    const outcomes = await Promise.allSettled([
      entry({ delta_units: -10_000_000 }).run(),
      entry({ id: 'second-entry', operation_id: 'second-operation', request_id: 'd13-second', delta_units: -20_000_000 }).run(),
      entry({ id: 'racing-entry', operation_id: 'racing-operation', delta_units: -10_000_000 }).run(),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(2);
    expect((await state()).balance).toBe(20_000_000);
    expect((await state()).ledger).toHaveLength(2);
  });

  it('rejects mismatched user/key, price/fingerprint and already settled requests', async () => {
    const before = await state();
    for (const overrides of [{ user_id: 'd13-other' }, { request_id: 'missing' }, { price_snapshot: '{"other":true}' }, { currency: 'EUR' }, { delta_units: 1 }]) {
      await expect(entry(overrides).run()).rejects.toThrow();
      expect(await state()).toEqual(before);
    }
    for (const changes of [{ api_key_id: 'd13-other-key' }, { billing_status: 'settled' }, { fingerprint: 'existing-other-fingerprint' }]) {
      await request('bad-request', changes);
      await expect(entry({ request_id: 'bad-request' }).run()).rejects.toThrow();
      await testEnv.DB.prepare("DELETE FROM requests WHERE id='bad-request'").run();
    }
    expect(await state()).toEqual(before);
  });

  it('rejects incomplete, malformed, source-free, unsafe or contradictory usage evidence', async () => {
    const bad = [
      null, '{broken', JSON.stringify({}),
      ...['partial', 'missing', 'invalid'].map((quality) => JSON.stringify({ ...usage, quality })),
      ...[{ counts: {} }, { counts: { inputTokens: -1, outputTokens: 0 } }, { counts: { inputTokens: 1.5, outputTokens: 0 } },
        { counts: { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 0 } }, { counts: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 2 } },
        { counts: { inputTokens: 1, outputTokens: 0, extraTokens: 1 } }, { protocol: 'messages' }, { issues: ['conflict'] },
        { sources: [] }, { sources: [{ protocol: 'chat', path: '' }] }, { sources: [{ protocol: 'responses', path: 'usage' }] }, { semantics: {} },
        { semantics: { ...usage.semantics, cacheRead: 'unknown' } },
        { semantics: { ...usage.semantics, reasoning: 'excluded_from_output' } }]
        .map((changes) => JSON.stringify({ ...usage, ...changes })),
    ];
    const before = await state();
    for (const usage_snapshot of bad) {
      await expect(entry({ usage_snapshot }).run()).rejects.toThrow();
      expect(await state()).toEqual(before);
    }
  });

  it('rolls back the entire D1 batch if a later statement fails after the debit', async () => {
    const before = await state();
    await expect(testEnv.DB.batch([entry(), testEnv.DB.prepare("UPDATE users SET balance_units=9007199254740992 WHERE id='d13-user'")])).rejects.toThrow();
    expect(await state()).toEqual(before);
  });

  it('aborts zero-row balance/request updates and rolls back the earlier effects', async () => {
    const before = await state();
    await testEnv.DB.exec("CREATE TRIGGER d13_skip_balance BEFORE UPDATE OF balance_units ON users BEGIN SELECT RAISE(IGNORE); END;");
    await expect(entry().run()).rejects.toThrow('billing_balance_update_missing');
    expect(await state()).toEqual(before);
    await testEnv.DB.exec('DROP TRIGGER d13_skip_balance;');
    await testEnv.DB.exec("CREATE TRIGGER d13_skip_request BEFORE UPDATE OF billing_status ON requests BEGIN SELECT RAISE(IGNORE); END;");
    await expect(entry().run()).rejects.toThrow('billing_request_update_missing');
    expect(await state()).toEqual(before);
  });

  it('applies grants/adjustments once while preserving the original consumption request and ledger', async () => {
    await entry().run();
    const before = await state();
    await entry({ id: 'grant', operation_id: 'grant-op', kind: 'grant', request_id: null, delta_units: 100_000_000, reason: 'Test credit', usage_snapshot: null, price_snapshot: null }).run();
    await entry({ id: 'adjust', operation_id: 'adjust-op', kind: 'adjustment', delta_units: -10_000_000, reason: 'Test correction', usage_snapshot: null, price_snapshot: null }).run();
    const after = await state();
    expect(after.balance).toBe(65_000_000);
    expect(after.request).toEqual(before.request);
    expect(after.ledger.find((row) => row.id === 'd13-entry')).toEqual(before.ledger[0]);
  });

  it('rejects overflow in either direction without partial state', async () => {
    for (const [balance, delta, kind] of [[Number.MAX_SAFE_INTEGER, 1, 'grant'], [-Number.MAX_SAFE_INTEGER, -1, 'consumption']] as const) {
      await testEnv.DB.prepare("UPDATE users SET balance_units=? WHERE id='d13-user'").bind(balance).run();
      const before = await state();
      await expect(entry({ delta_units: delta, kind, reason: 'Overflow test' }).run()).rejects.toThrow('billing_balance_unavailable_or_overflow');
      expect(await state()).toEqual(before);
    }
  });
});
