import { expect, inject, it } from 'vitest';
import { migrateTestDatabase, resetTestDatabase, testEnv } from '../helpers/database';

const legacyEnvelope = '{"algorithm":"A256GCM","format_version":1,"key_version":"old-v1","nonce":"preserved-nonce","ciphertext":"preserved-ciphertext"}';

it('preserves encrypted channels and their foreign-key dependents when moving to direct keys', async () => {
  const migrations = inject('d1Migrations');
  await resetTestDatabase(migrations.filter(migration => migration.name < '0025'));
  await testEnv.DB.prepare(`INSERT INTO channels
    (id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES ('legacy-key','Legacy channel','https://example.invalid',?,'old-v1','active',3,2,60,7,1000,2000)`).bind(legacyEnvelope).run();
  await testEnv.DB.prepare("INSERT INTO channel_groups(channel_id,group_id) VALUES('legacy-key','default')").run();
  await testEnv.DB.prepare(`INSERT INTO channel_models(channel_id,public_model_id,upstream_model,protocol,capabilities_json,config_version)
    VALUES('legacy-key','gpt-5','provider-model','responses','{"protocol":"responses","features":["streaming"]}',3)`).run();
  await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES('d25-user','d25@example.invalid','test-only','user','active','default',2,60,'admin',0,0)`).run();
  await testEnv.DB.prepare(`INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at)
    VALUES('d25-key','d25-user',?,'s2a_key_ABCDEFGH','Test key','active',0,0)`).bind('5'.repeat(64)).run();
  await testEnv.DB.prepare(`INSERT INTO requests(id,user_id,api_key_id,channel_id,public_model_id,upstream_model,downstream_protocol,upstream_protocol,price_snapshot,created_at,updated_at)
    VALUES('d25-request','d25-user','d25-key','legacy-key','gpt-5','provider-model','responses','responses','{}',1000,1000)`).run();
  const original = await testEnv.DB.prepare("SELECT * FROM channels WHERE id='legacy-key'").first();
  const dependents = await Promise.all(['channel_groups', 'channel_models', 'requests'].map(async table =>
    (await testEnv.DB.prepare(`SELECT * FROM ${table}`).all()).results));

  await migrateTestDatabase([migrations.find(migration => migration.name === '0025_channel_plaintext_keys.sql')!]);

  expect(await testEnv.DB.prepare("SELECT * FROM channels WHERE id='legacy-key'").first()).toEqual({ ...original, upstream_key: null });
  expect(await Promise.all(['channel_groups', 'channel_models', 'requests'].map(async table =>
    (await testEnv.DB.prepare(`SELECT * FROM ${table}`).all()).results))).toEqual(dependents);
  expect((await testEnv.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  expect((await testEnv.DB.prepare("PRAGMA index_info('idx_channels_status_priority_id')").all()).results.map(row => row.name)).toEqual(['status', 'priority', 'id']);
  await expect(testEnv.DB.prepare("DELETE FROM channels WHERE id='legacy-key'").run()).rejects.toThrow();
  await expect(testEnv.DB.prepare("UPDATE channels SET id='replacement-id' WHERE id='legacy-key'").run()).rejects.toThrow();

  await testEnv.DB.prepare("UPDATE channels SET upstream_key='replacement-key',secret_ciphertext=NULL,secret_key_version=NULL WHERE id='legacy-key'").run();
  expect(await testEnv.DB.prepare("SELECT upstream_key,secret_ciphertext,secret_key_version FROM channels WHERE id='legacy-key'").first())
    .toEqual({ upstream_key: 'replacement-key', secret_ciphertext: null, secret_key_version: null });
});

it('accepts new direct keys without encrypted placeholders and rejects missing credentials', async () => {
  const insert = (id: string, key: string | null) => testEnv.DB.prepare(`INSERT INTO channels
    (id,name,base_url,upstream_key,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES (?,'Direct key','https://example.invalid',?,'active',0,2,60,1,0,0)`).bind(id, key).run();
  await insert('direct-key', 'upstream-test-key');
  expect(await testEnv.DB.prepare("SELECT upstream_key,secret_ciphertext,secret_key_version FROM channels WHERE id='direct-key'").first())
    .toEqual({ upstream_key: 'upstream-test-key', secret_ciphertext: null, secret_key_version: null });
  await expect(insert('empty-key', '')).rejects.toThrow();
  await expect(insert('blank-key', ' ')).rejects.toThrow();
  await expect(insert('missing-key', null)).rejects.toThrow();
});
