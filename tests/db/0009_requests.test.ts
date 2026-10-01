import { beforeEach, describe, expect, it } from 'vitest';
import { encryptChannelSecret } from '../../apps/worker/admin/channel-secrets';
import { testEnv } from '../helpers/database';

type Value = string | number | null;
const base = {
  id: 'd09-request', user_id: 'd09-user', api_key_id: 'd09-key', channel_id: 'd09-channel',
  public_model_id: 'd09-model', upstream_model: 'provider-model', downstream_protocol: 'chat', upstream_protocol: 'responses',
  price_snapshot: '{"prices":{"input":"1","output":"2"},"price_version":1}', created_at: 1000, updated_at: 1000,
};
function insert(changes: Record<string, Value> = {}) {
  const row = { ...base, ...changes };
  return testEnv.DB.prepare(`INSERT INTO requests (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`)
    .bind(...Object.values(row)).run();
}

describe('0009 execution and billing request records in native D1', () => {
  beforeEach(async () => {
    await testEnv.DB.prepare("INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES ('d09-group','D09 group','active',1,0,0)").run();
    await testEnv.DB.prepare(`INSERT INTO users
      (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES ('d09-user','d09@example.invalid','test-only-hash','user','active','d09-group',2,60,'admin',0,0)`).run();
    await testEnv.DB.prepare(`INSERT INTO api_keys
      (id,user_id,key_hash,display_prefix,name,status,created_at,updated_at)
      VALUES ('d09-key','d09-user',?,'s2a_key_ABCDEFGH','D09 key','active',0,0)`).bind('9'.repeat(64)).run();
    const secret = await encryptChannelSecret('test-only-upstream', 'd09-channel', 'test-v1', crypto.getRandomValues(new Uint8Array(32)));
    await testEnv.DB.prepare(`INSERT INTO channels
      (id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
      VALUES ('d09-channel','D09 channel','https://example.invalid',?,'test-v1','active',0,2,60,1,0,0)`).bind(secret).run();
    await testEnv.DB.prepare(`INSERT INTO models
      (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,default_output_tokens,created_at,updated_at)
      VALUES ('d09-model','active','{"input":"1","output":"2"}',1,0,4096,1024,0,0)`).run();
  });

  it('starts admitted/awaiting usage without claiming a zero cost or complete measurement', async () => {
    await insert();
    const row = await testEnv.DB.prepare('SELECT * FROM requests WHERE id = ?').bind(base.id).first();
    expect(row).toEqual({ ...base, execution_status: 'admitted', billing_status: 'awaiting_usage',
      usage_json: null, usage_quality: 'missing', cost_units: null, fingerprint: null, retry_count: 0, next_retry_at: null,
      upstream_request_id: null, response_id: null, attempts_json: '[]', started_at: null, finished_at: null, error_code: null, error_message: null });
    await expect(insert()).rejects.toThrow();
  });

  it('keeps execution and billing states independent, including billed cancellations/failures', async () => {
    for (const execution of ['admitted', 'succeeded', 'failed', 'cancelled', 'abandoned']) {
      for (const billing of ['awaiting_usage', 'settled', 'not_chargeable', 'settlement_pending', 'usage_unknown']) {
        await insert({ id: `${execution}-${billing}`, execution_status: execution, billing_status: billing });
      }
    }
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM requests').first('count')).toBe(25);
    await expect(insert({ execution_status: 'completed' })).rejects.toThrow();
    await expect(insert({ billing_status: 'paid' })).rejects.toThrow();
    await expect(insert({ downstream_protocol: 'openai' })).rejects.toThrow();
    await expect(insert({ upstream_protocol: 'anthropic' })).rejects.toThrow();
    for (const protocol of ['chat', 'responses', 'messages']) await insert({ id: `protocol-${protocol}`, upstream_protocol: protocol, downstream_protocol: protocol });
  });

  it('requires admission identity/model/price/time fields and restricts JSON shapes', async () => {
    for (const column of [...Object.keys(base), 'execution_status', 'billing_status', 'usage_quality', 'retry_count', 'attempts_json']) {
      await expect(insert({ [column]: null })).rejects.toThrow();
    }
    await expect(insert({ id: ' ' })).rejects.toThrow();
    await expect(insert({ upstream_model: ' ' })).rejects.toThrow();
    for (const json of ['broken', 'null', '[]', '1', '"value"']) await expect(insert({ price_snapshot: json })).rejects.toThrow();
    await expect(insert({ usage_json: '{broken' })).rejects.toThrow();
    await expect(insert({ usage_quality: 'estimated' })).rejects.toThrow();
    for (const quality of ['complete', 'partial', 'missing', 'invalid']) await insert({ id: `quality-${quality}`, usage_quality: quality, usage_json: '{"inputTokens":10}' });
  });

  it('limits attempts to two summaries and 16 KiB without interpreting provider details', async () => {
    for (const attempts of ['broken', '{}', 'null', '[{},{},{}]', JSON.stringify([{ summary: 'x'.repeat(16384) }])]) {
      await expect(insert({ attempts_json: attempts })).rejects.toThrow();
    }
    await insert({ attempts_json: '[{"attempt":1,"status":429},{"attempt":2,"status":200}]' });
    expect(await testEnv.DB.prepare('SELECT json_array_length(attempts_json) AS count FROM requests WHERE id = ?').bind(base.id).first('count')).toBe(2);
  });

  it('stores bounded usage/cost/retry metadata exactly and rejects invalid numeric values', async () => {
    for (const column of ['cost_units', 'retry_count', 'next_retry_at', 'created_at', 'started_at', 'finished_at', 'updated_at']) {
      for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, 'invalid']) await expect(insert({ [column]: value })).rejects.toThrow();
    }
    await insert({ usage_json: '{"inputTokens":1}', usage_quality: 'complete', cost_units: 0, fingerprint: 'test-fingerprint',
      retry_count: 0, next_retry_at: 0, started_at: 0, finished_at: 0, upstream_request_id: 'provider-request', response_id: 'provider-response',
      error_code: 'upstream_disconnected', error_message: 'Sanitized test error.' });
    await insert({ id: 'd09-max', cost_units: Number.MAX_SAFE_INTEGER, retry_count: Number.MAX_SAFE_INTEGER,
      next_retry_at: Number.MAX_SAFE_INTEGER, created_at: Number.MAX_SAFE_INTEGER, started_at: Number.MAX_SAFE_INTEGER,
      finished_at: Number.MAX_SAFE_INTEGER, updated_at: Number.MAX_SAFE_INTEGER });
    expect(await testEnv.DB.prepare('SELECT cost_units FROM requests WHERE id = ?').bind('d09-max').first('cost_units')).toBe(Number.MAX_SAFE_INTEGER);
    for (const column of ['fingerprint', 'upstream_request_id', 'response_id']) await expect(insert({ id: `invalid-${column}`, [column]: ' ' })).rejects.toThrow();
  });

  it('rejects orphan parents and protects all four referenced parent records', async () => {
    for (const column of ['user_id', 'api_key_id', 'channel_id', 'public_model_id']) await expect(insert({ [column]: 'missing' })).rejects.toThrow();
    await insert();
    for (const [table, key, id] of [['users', 'id', 'd09-user'], ['api_keys', 'id', 'd09-key'], ['channels', 'id', 'd09-channel'], ['models', 'public_model_id', 'd09-model']] as const) {
      await expect(testEnv.DB.prepare(`DELETE FROM ${table} WHERE ${key} = ?`).bind(id).run()).rejects.toThrow();
      await expect(testEnv.DB.prepare(`UPDATE ${table} SET ${key} = ? WHERE ${key} = ?`).bind('changed-id', id).run()).rejects.toThrow();
    }
    const foreignKeys = await testEnv.DB.prepare('PRAGMA foreign_key_list(requests)').all<{ table: string; on_delete: string; on_update: string }>();
    expect(foreignKeys.results.map((fk) => fk.table).sort()).toEqual(['api_keys', 'channels', 'models', 'users']);
    expect(foreignKeys.results.every((fk) => fk.on_delete === 'RESTRICT' && fk.on_update === 'RESTRICT')).toBe(true);
    expect((await testEnv.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('indexes user/channel history, retry work and scoped response lookup without global response uniqueness', async () => {
    for (const [index, columns] of [
      ['idx_requests_user_created_id', ['user_id', 'created_at', 'id']],
      ['idx_requests_channel_created_id', ['channel_id', 'created_at', 'id']],
      ['idx_requests_billing_next_retry', ['billing_status', 'next_retry_at', 'id']],
      ['idx_requests_user_key_response', ['user_id', 'api_key_id', 'response_id']],
    ] as const) {
      const info = await testEnv.DB.prepare(`PRAGMA index_info('${index}')`).all<{ name: string }>();
      expect(info.results.map((column) => column.name)).toEqual(columns);
    }
    await insert({ response_id: 'shared-provider-id' });
    await insert({ id: 'd09-another', response_id: 'shared-provider-id' });
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM requests WHERE user_id = ? AND api_key_id = ? AND response_id = ?')
      .bind('d09-user', 'd09-key', 'shared-provider-id').first('count')).toBe(2);
  });
});
