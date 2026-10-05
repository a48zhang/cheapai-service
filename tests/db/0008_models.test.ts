import { describe, expect, it } from 'vitest';
import { legacyChannelSecret } from '../helpers/legacy-channel-secret';
import { testEnv } from '../helpers/database';

const modelColumns = ['public_model_id', 'status', 'sell_prices_json', 'price_version', 'admission_min_balance_units', 'max_output_tokens', 'default_output_tokens', 'created_at', 'updated_at'] as const;
type ModelRow = Record<typeof modelColumns[number], string | number | null>;
const validModel: ModelRow = {
  public_model_id: 'd08-public', status: 'active', sell_prices_json: '{"input":"1","output":"2"}',
  price_version: 1, admission_min_balance_units: 0, max_output_tokens: 4096,
  default_output_tokens: 1024, created_at: 1000, updated_at: 1000,
};
const mappingColumns = ['channel_id', 'public_model_id', 'upstream_model', 'protocol', 'capabilities_json', 'config_version'] as const;
type MappingRow = Record<typeof mappingColumns[number], string | number | null>;
const validMapping: MappingRow = {
  channel_id: 'd08-channel', public_model_id: 'd08-public', upstream_model: 'provider-model-v1',
  protocol: 'chat', capabilities_json: '{"tools":true}', config_version: 1,
};

function model(changes: Partial<ModelRow> = {}) {
  const row = { ...validModel, ...changes };
  return testEnv.DB.prepare(`INSERT INTO models (${modelColumns.join(',')}) VALUES (${modelColumns.map(() => '?').join(',')})`)
    .bind(...modelColumns.map((column) => row[column])).run();
}
function mapping(changes: Partial<MappingRow> = {}) {
  const row = { ...validMapping, ...changes };
  return testEnv.DB.prepare(`INSERT INTO channel_models (${mappingColumns.join(',')}) VALUES (${mappingColumns.map(() => '?').join(',')})`)
    .bind(...mappingColumns.map((column) => row[column])).run();
}
async function channel(id = 'd08-channel') {
  const encrypted = legacyChannelSecret();
  await testEnv.DB.prepare(`INSERT INTO channels
    (id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES (?, ?, ?, ?, 'test-v1', 'active', 0, 2, 60, 1, 0, 0)`)
    .bind(id, `D08 ${id}`, 'https://upstream.example.invalid', encrypted).run();
}

describe('0008 models and channel mappings in native D1', () => {
  it('creates no model seeds and stores exact explicit prices/output limits', async () => {
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM models').first('count')).toBe(0);
    await model();
    expect(await testEnv.DB.prepare('SELECT * FROM models WHERE public_model_id = ?').bind(validModel.public_model_id).first()).toEqual(validModel);
    await model({ public_model_id: 'd08-free', status: 'disabled', sell_prices_json: '{"input":"0","output":"0"}' });
    expect(await testEnv.DB.prepare('SELECT sell_prices_json FROM models WHERE public_model_id = ?').bind('d08-free').first('sell_prices_json')).toBe('{"input":"0","output":"0"}');
    const schema = await testEnv.DB.prepare('PRAGMA table_info(models)').all<{ dflt_value: unknown }>();
    expect(schema.results.every((column) => column.dflt_value === null)).toBe(true);
  });

  it('requires fields and legal status without defaulting absent prices to zero', async () => {
    for (const column of modelColumns) await expect(model({ [column]: null })).rejects.toThrow();
    await expect(model({ public_model_id: ' ' })).rejects.toThrow();
    await expect(model({ status: 'enabled' })).rejects.toThrow();
    await expect(testEnv.DB.prepare('INSERT INTO models (public_model_id,status) VALUES (?,?)').bind('missing-values', 'active').run()).rejects.toThrow();
    await model();
    await expect(model()).rejects.toThrow();
  });

  it('requires price/capability JSON objects while leaving field schemas to application validators', async () => {
    for (const json of ['{broken', 'null', '[]', '1', 'true', '"string"']) await expect(model({ sell_prices_json: json })).rejects.toThrow();
    await model({ sell_prices_json: '{}' }); // Valid object is not a claim of price readiness.
    await channel();
    for (const json of ['{broken', 'null', '[]', '1', 'false', '"string"']) await expect(mapping({ capabilities_json: json })).rejects.toThrow();
    await mapping({ capabilities_json: '{}' });
    expect(await testEnv.DB.prepare('SELECT capabilities_json FROM channel_models').first('capabilities_json')).toBe('{}');
  });

  it('bounds numeric values, forbids zero outputs, and requires default <= maximum', async () => {
    for (const column of ['price_version', 'max_output_tokens', 'default_output_tokens'] as const) {
      for (const value of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, 'invalid']) await expect(model({ [column]: value })).rejects.toThrow();
    }
    for (const column of ['admission_min_balance_units', 'created_at', 'updated_at'] as const) {
      for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, 'invalid']) await expect(model({ [column]: value })).rejects.toThrow();
    }
    await expect(model({ default_output_tokens: 4097 })).rejects.toThrow();
    await expect(model({ updated_at: 999 })).rejects.toThrow();
    await model({ default_output_tokens: 4096, created_at: 0, updated_at: 0 });
    await model({ public_model_id: 'd08-max', admission_min_balance_units: Number.MAX_SAFE_INTEGER, max_output_tokens: Number.MAX_SAFE_INTEGER, default_output_tokens: Number.MAX_SAFE_INTEGER, price_version: Number.MAX_SAFE_INTEGER, created_at: Number.MAX_SAFE_INTEGER, updated_at: Number.MAX_SAFE_INTEGER });
    expect(await testEnv.DB.prepare('SELECT admission_min_balance_units FROM models WHERE public_model_id = ?').bind('d08-max').first('admission_min_balance_units')).toBe(Number.MAX_SAFE_INTEGER);
    await expect(testEnv.DB.prepare('UPDATE models SET max_output_tokens = 1 WHERE public_model_id = ?').bind('d08-public').run()).rejects.toThrow();
  });

  it('allows each protocol and many-to-many mappings but rejects duplicate tuples and malformed rows', async () => {
    await model(); await channel();
    await model({ public_model_id: 'd08-public-2' }); await channel('d08-channel-2');
    for (const column of mappingColumns) await expect(mapping({ [column]: null })).rejects.toThrow();
    await expect(mapping({ upstream_model: ' ' })).rejects.toThrow();
    await expect(mapping({ protocol: 'openai' })).rejects.toThrow();
    for (const value of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, 'invalid']) await expect(mapping({ config_version: value })).rejects.toThrow();
    for (const protocol of ['chat', 'responses', 'messages']) await mapping({ protocol });
    await mapping({ channel_id: 'd08-channel-2' });
    await mapping({ public_model_id: 'd08-public-2', config_version: Number.MAX_SAFE_INTEGER });
    await expect(mapping({ upstream_model: 'different-upstream-name' })).rejects.toThrow();
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM channel_models').first('count')).toBe(5);
  });

  it('rejects orphan references and restricts parent updates/deletes until mappings are removed', async () => {
    await model(); await channel();
    await expect(mapping({ channel_id: 'missing-channel' })).rejects.toThrow();
    await expect(mapping({ public_model_id: 'missing-model' })).rejects.toThrow();
    await mapping();
    for (const [table, key] of [['channels', 'id'], ['models', 'public_model_id']] as const) {
      const id = table === 'channels' ? 'd08-channel' : 'd08-public';
      await expect(testEnv.DB.prepare(`DELETE FROM ${table} WHERE ${key} = ?`).bind(id).run()).rejects.toThrow();
      await expect(testEnv.DB.prepare(`UPDATE ${table} SET ${key} = ? WHERE ${key} = ?`).bind('changed-id', id).run()).rejects.toThrow();
    }
    await testEnv.DB.prepare('DELETE FROM channel_models WHERE channel_id = ?').bind('d08-channel').run();
    await testEnv.DB.prepare('DELETE FROM models WHERE public_model_id = ?').bind('d08-public').run();
    await testEnv.DB.prepare('DELETE FROM channels WHERE id = ?').bind('d08-channel').run();
    expect((await testEnv.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('indexes model/protocol/channel routing and declares both RESTRICT foreign keys', async () => {
    const routeIndex = await testEnv.DB.prepare("PRAGMA index_info('idx_channel_models_model_protocol_channel')").all<{ name: string }>();
    expect(routeIndex.results.map((column) => column.name)).toEqual(['public_model_id', 'protocol', 'channel_id']);
    const statusIndex = await testEnv.DB.prepare("PRAGMA index_info('idx_models_status_id')").all<{ name: string }>();
    expect(statusIndex.results.map((column) => column.name)).toEqual(['status', 'public_model_id']);
    const foreignKeys = await testEnv.DB.prepare('PRAGMA foreign_key_list(channel_models)').all<{ table: string; on_delete: string; on_update: string }>();
    expect(foreignKeys.results.map((fk) => fk.table).sort()).toEqual(['channels', 'models']);
    expect(foreignKeys.results.every((fk) => fk.on_delete === 'RESTRICT' && fk.on_update === 'RESTRICT')).toBe(true);
  });
});
