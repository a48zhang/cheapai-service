import { expect, inject, it } from 'vitest';
import refreshSql from '../../migrations/0034_refresh_builtin_models.sql?raw';
import { BUILTIN_MODELS } from '../../packages/model-catalog/index';
import { migrateTestDatabase, resetTestDatabase, testEnv } from '../helpers/database';

async function beforeRefresh() {
  await resetTestDatabase(inject('d1Migrations').filter((migration) => migration.name < '0034'));
}

async function addModel(id: string) {
  await testEnv.DB.prepare(
    `INSERT INTO models
    (public_model_id,status,sell_prices_json,price_version,created_at,updated_at)
    VALUES(?,'active','{"input":"7","output":"9"}',3,1000,2000)`,
  )
    .bind(id)
    .run();
}

function model(id: string) {
  return testEnv.DB.prepare('SELECT * FROM models WHERE public_model_id=?').bind(id).first();
}

it('upgrades a fresh installation to exactly the maintained catalog without authorizing routes', async () => {
  const rows = await testEnv.DB.prepare(
    'SELECT public_model_id FROM models ORDER BY public_model_id',
  ).all();
  expect(rows.results.map((row) => row.public_model_id)).toEqual(
    BUILTIN_MODELS.map((item) => item.id).sort(),
  );
  expect(
    await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM channel_models').first('count'),
  ).toBe(0);
  expect(await testEnv.DB.prepare('PRAGMA foreign_key_check').all()).toMatchObject({ results: [] });
});

it('retires older families and snapshots while preserving boundary versions, custom aliases and configured prices', async () => {
  await beforeRefresh();
  const retired = [
    'gpt-4o',
    'gpt-4.1-mini',
    'gpt-5.4-pro',
    'gpt-5.4-2026-03-05',
    'claude-3-5-sonnet-20241022',
    'claude-opus-4-1',
    'claude-sonnet-4-20250514',
  ];
  const retained = [
    'gpt-5.5-2026-04-23',
    'claude-opus-4-5-20251101',
    'vendor/gpt-5',
    'deepseek-flash',
  ];
  for (const id of [...retired, ...retained, 'gpt-6.1-sol']) await addModel(id);
  await testEnv.DB.prepare(
    "UPDATE models SET status='disabled',price_version=9 WHERE public_model_id='gpt-6.1-sol'",
  ).run();
  await testEnv.DB.prepare(
    "UPDATE models SET sell_prices_json='{}',price_version=6 WHERE public_model_id='gpt-5.5'",
  ).run();
  const preserved = await Promise.all([...retained, 'gpt-6.1-sol', 'gpt-5.5'].map(model));
  await migrateTestDatabase();
  for (const id of [...retired, 'gpt-5', 'gpt-5.1', 'gpt-5.2', 'gpt-5.3-codex', 'gpt-5.4']) {
    expect(await model(id), id).toBeNull();
  }
  expect(await Promise.all([...retained, 'gpt-6.1-sol', 'gpt-5.5'].map(model))).toEqual(preserved);
});

it('disables referenced legacy models without changing prices, mappings, request snapshots or chat history', async () => {
  await beforeRefresh();
  await testEnv.DB.prepare(
    `INSERT INTO channels
    (id,name,base_url,upstream_key,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES('refresh-channel','Refresh','https://example.invalid','test-only','active',0,2,60,4,0,0)`,
  ).run();
  await testEnv.DB.prepare(
    `INSERT INTO channel_models(channel_id,public_model_id,upstream_model,protocol,config_version)
    VALUES('refresh-channel','gpt-5','provider-model','responses',4)`,
  ).run();
  await testEnv.DB.prepare(
    `INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES('refresh-user','refresh@example.invalid','test-only','user','active','default',2,60,'admin',0,0)`,
  ).run();
  await testEnv.DB.prepare(
    `INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at)
    VALUES('refresh-key','refresh-user',?,'s2a_key_ABCDEFGH','Test key','active',0,0)`,
  )
    .bind('4'.repeat(64))
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO requests(id,user_id,api_key_id,channel_id,public_model_id,upstream_model,downstream_protocol,upstream_protocol,price_snapshot,created_at,updated_at)
    VALUES('refresh-request','refresh-user','refresh-key','refresh-channel','gpt-5.1','provider-model','responses','responses','{"price_version":1}',1000,1000)`,
  ).run();
  await testEnv.DB.prepare(
    `INSERT INTO chat_conversations(id,user_id,title,model_id,version,created_at,updated_at)
    VALUES('refresh-chat','refresh-user','Preserve history','gpt-5.2',1,0,0)`,
  ).run();
  await testEnv.DB.prepare(
    `INSERT INTO chat_messages(id,conversation_id,turn_index,role,content,status,model_id,created_at,updated_at)
    VALUES('refresh-message','refresh-chat',1,'assistant','Historical answer','completed','gpt-5.3-codex',0,0)`,
  ).run();
  const ids = ['gpt-5', 'gpt-5.1', 'gpt-5.2', 'gpt-5.3-codex'];
  const before = await Promise.all(ids.map(model));
  const tables = ['channel_models', 'requests', 'chat_conversations', 'chat_messages'];
  const history = await Promise.all(
    tables.map((table) => testEnv.DB.prepare(`SELECT * FROM ${table}`).all()),
  );
  await migrateTestDatabase();
  for (const [index, id] of ids.entries()) {
    expect(await model(id)).toMatchObject({
      ...before[index],
      status: 'disabled',
      price_version: 2,
      updated_at: expect.any(Number),
    });
  }
  expect(
    await Promise.all(
      tables.map((table) => testEnv.DB.prepare(`SELECT * FROM ${table}`).all()),
    ).then((results) => results.map((result) => result.results)),
  ).toEqual(history.map((result) => result.results));
  expect(await testEnv.DB.prepare('PRAGMA foreign_key_check').all()).toMatchObject({ results: [] });
  const after = await Promise.all(ids.map(model));
  await testEnv.DB.batch(
    refreshSql
      .split(';')
      .filter((sql) => sql.trim())
      .map((sql) => testEnv.DB.prepare(sql)),
  );
  expect(await Promise.all(ids.map(model))).toEqual(after);
});
