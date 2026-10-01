import { beforeEach, describe, expect, it } from 'vitest';
import { encryptChannelSecret } from '../../apps/worker/admin/channel-secrets';
import { testEnv } from '../helpers/database';

type Value = string | number | null;
const base = {
  id: 'd10-entry', operation_id: 'd10-operation', kind: 'consumption', user_id: 'd10-user', request_id: 'd10-request',
  delta_units: -200_000, fingerprint: 'd10-fingerprint', usage_snapshot: '{"quality":"complete","inputTokens":1000,"outputTokens":500}',
  price_snapshot: '{"input":"1","output":"2"}', created_at: 1000,
};
function insert(changes: Record<string, Value> = {}, replace = false) {
  const row = { ...base, ...changes };
  return testEnv.DB.prepare(`INSERT ${replace ? 'OR REPLACE ' : ''}INTO billing_entries (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`)
    .bind(...Object.values(row)).run();
}

describe('0010 append-only billing entries in native D1', () => {
  beforeEach(async () => {
    await testEnv.DB.prepare("INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES ('d10-group','D10 group','active',1,0,0)").run();
    for (const [id, role] of [['d10-user', 'user'], ['d10-admin', 'admin']]) {
      await testEnv.DB.prepare(`INSERT INTO users
        (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
        VALUES (?,?,'test-only-hash',?,'active','d10-group',2,60,'admin',0,0)`).bind(id, `${id}@example.invalid`, role).run();
    }
    await testEnv.DB.prepare(`INSERT INTO api_keys (id,user_id,key_hash,display_prefix,name,status,created_at,updated_at)
      VALUES ('d10-key','d10-user',?,'s2a_key_ABCDEFGH','D10 key','active',0,0)`).bind('a'.repeat(64)).run();
    const secret = await encryptChannelSecret('test-upstream', 'd10-channel', 'test-v1', crypto.getRandomValues(new Uint8Array(32)));
    await testEnv.DB.prepare(`INSERT INTO channels
      (id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
      VALUES ('d10-channel','D10 channel','https://example.invalid',?,'test-v1','active',0,2,60,1,0,0)`).bind(secret).run();
    await testEnv.DB.prepare(`INSERT INTO models
      (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,default_output_tokens,created_at,updated_at)
      VALUES ('d10-model','active','{"input":"1","output":"2"}',1,0,4096,1024,0,0)`).run();
    await testEnv.DB.prepare(`INSERT INTO requests
      (id,user_id,api_key_id,channel_id,public_model_id,upstream_model,downstream_protocol,upstream_protocol,price_snapshot,created_at,updated_at)
      VALUES ('d10-request','d10-user','d10-key','d10-channel','d10-model','provider-model','chat','chat',?,1000,1000)`)
      .bind(base.price_snapshot).run();
  });

  it('stores exact immutable snapshots and fixed USD currency', async () => {
    await insert();
    expect(await testEnv.DB.prepare('SELECT * FROM billing_entries WHERE id = ?').bind(base.id).first())
      .toEqual({ ...base, currency: 'USD', created_by: null, reason: null });
  });

  it('enforces entry ID, operation ID and consumption-request uniqueness', async () => {
    await insert();
    await expect(insert({ operation_id: 'other-operation' })).rejects.toThrow();
    await expect(insert({ id: 'other-entry' })).rejects.toThrow();
    await expect(insert({ id: 'other-entry', operation_id: 'other-operation' })).rejects.toThrow();
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM billing_entries').first('count')).toBe(1);
  });

  it('permits independent positive/negative adjustments to one request and a separate grant', async () => {
    await insert();
    for (const [id, delta] of [['refund', 100], ['correction', -50]] as const) {
      await insert({ id, operation_id: `${id}-operation`, kind: 'adjustment', delta_units: delta, created_by: 'd10-admin', reason: 'Test correction', usage_snapshot: null, price_snapshot: null });
    }
    await insert({ id: 'grant', operation_id: 'grant-operation', kind: 'grant', request_id: null, delta_units: 1000, created_by: 'd10-admin', reason: 'Test grant', usage_snapshot: null, price_snapshot: null });
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM billing_entries WHERE request_id = ?').bind('d10-request').first('count')).toBe(3);
    await expect(insert({ id: 'duplicate-adjustment', operation_id: 'refund-operation', kind: 'adjustment', delta_units: 10, reason: 'Different correction' })).rejects.toThrow();
  });

  it('requires complete consumption references/snapshots and correct delta signs', async () => {
    for (const column of ['request_id', 'usage_snapshot', 'price_snapshot']) await expect(insert({ [column]: null })).rejects.toThrow();
    await expect(insert({ delta_units: 1 })).rejects.toThrow();
    for (const delta of [0, -1]) await expect(insert({ kind: 'grant', request_id: null, delta_units: delta, reason: 'Test grant' })).rejects.toThrow();
    for (const kind of ['grant', 'adjustment']) await expect(insert({ kind, request_id: null, delta_units: 1, reason: null })).rejects.toThrow();
    await insert({ delta_units: 0 }); // Explicit free consumption remains an accounting fact.
  });

  it('rejects missing identifiers, invalid currency/kind, malformed JSON and unsafe scalars', async () => {
    for (const column of ['id', 'operation_id', 'kind', 'user_id', 'currency', 'delta_units', 'fingerprint', 'created_at']) await expect(insert({ [column]: null })).rejects.toThrow();
    for (const column of ['id', 'operation_id', 'fingerprint', 'reason']) await expect(insert({ [column]: ' ' })).rejects.toThrow();
    await expect(insert({ currency: 'EUR' })).rejects.toThrow();
    await expect(insert({ kind: 'refund' })).rejects.toThrow();
    for (const column of ['usage_snapshot', 'price_snapshot']) {
      for (const json of ['broken', 'null', '[]', '1', '"text"']) await expect(insert({ [column]: json })).rejects.toThrow();
    }
    for (const delta of [0.5, Number.MAX_SAFE_INTEGER + 1, -Number.MAX_SAFE_INTEGER - 1, 'invalid']) await expect(insert({ delta_units: delta })).rejects.toThrow();
    for (const time of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, 'invalid']) await expect(insert({ created_at: time })).rejects.toThrow();
    await insert({ delta_units: -Number.MAX_SAFE_INTEGER, created_at: 0 });
    await insert({ id: 'max-grant', operation_id: 'max-grant-op', kind: 'grant', request_id: null, delta_units: Number.MAX_SAFE_INTEGER, reason: 'Boundary test', created_at: Number.MAX_SAFE_INTEGER });
    expect(await testEnv.DB.prepare('SELECT delta_units FROM billing_entries WHERE id = ?').bind('max-grant').first('delta_units')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('enforces all parent foreign keys and preserves referenced history', async () => {
    for (const column of ['user_id', 'request_id', 'created_by']) await expect(insert({ [column]: 'missing-parent' })).rejects.toThrow();
    await insert({ created_by: 'd10-admin' });
    await expect(testEnv.DB.prepare('DELETE FROM requests WHERE id = ?').bind('d10-request').run()).rejects.toThrow();
    await expect(testEnv.DB.prepare('DELETE FROM users WHERE id = ?').bind('d10-admin').run()).rejects.toThrow();
    const foreignKeys = await testEnv.DB.prepare('PRAGMA foreign_key_list(billing_entries)').all<{ table: string; on_delete: string; on_update: string }>();
    expect(foreignKeys.results.map((fk) => fk.table).sort()).toEqual(['requests', 'users', 'users']);
    expect(foreignKeys.results.every((fk) => fk.on_delete === 'RESTRICT' && fk.on_update === 'RESTRICT')).toBe(true);
    expect((await testEnv.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('rejects updates, deletes, upserts and every REPLACE conflict without changing facts', async () => {
    await insert();
    const before = await testEnv.DB.prepare('SELECT * FROM billing_entries WHERE id = ?').bind(base.id).first();
    await expect(testEnv.DB.prepare('UPDATE billing_entries SET delta_units = 0 WHERE id = ?').bind(base.id).run()).rejects.toThrow('billing_entries_append_only');
    await expect(testEnv.DB.prepare('DELETE FROM billing_entries WHERE id = ?').bind(base.id).run()).rejects.toThrow('billing_entries_append_only');
    await expect(testEnv.DB.prepare('UPDATE billing_entries SET fingerprint = fingerprint WHERE id = ?').bind(base.id).run()).rejects.toThrow('billing_entries_append_only');
    for (const changes of [
      { operation_id: 'replacement-id-op', kind: 'adjustment', reason: 'Replace by id' },
      { id: 'replacement-op-id', kind: 'adjustment', reason: 'Replace by operation' },
      { id: 'replacement-request-id', operation_id: 'replacement-request-op' },
    ]) await expect(insert(changes, true)).rejects.toThrow('billing_entries_append_only');
    await expect(testEnv.DB.prepare(`INSERT INTO billing_entries
      (id,operation_id,kind,user_id,request_id,delta_units,fingerprint,usage_snapshot,price_snapshot,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET delta_units = 0`)
      .bind(...Object.values(base)).run()).rejects.toThrow();
    expect(await testEnv.DB.prepare('SELECT * FROM billing_entries WHERE id = ?').bind(base.id).first()).toEqual(before);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM billing_entries').first('count')).toBe(1);
  });

  it('defines a consumption-only unique index and a user-history index', async () => {
    const indexes = await testEnv.DB.prepare('PRAGMA index_list(billing_entries)').all<{ name: string; unique: number; partial: number }>();
    expect(indexes.results.find((index) => index.name === 'idx_billing_entries_consumption_request')).toMatchObject({ unique: 1, partial: 1 });
    const history = await testEnv.DB.prepare("PRAGMA index_info('idx_billing_entries_user_created_id')").all<{ name: string }>();
    expect(history.results.map((column) => column.name)).toEqual(['user_id', 'created_at', 'id']);
  });
});
