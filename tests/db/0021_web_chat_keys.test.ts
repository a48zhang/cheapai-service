import { beforeEach, describe, expect, inject, it } from 'vitest';
import { migrateTestDatabase, resetTestDatabase, testEnv } from '../helpers/database';

const now = 1000;
const allMigrations = () => inject('d1Migrations');

async function seedPreWebChatRows() {
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('m21-group','M21 group','active',1,0,0)").run();
  await testEnv.DB.prepare(`INSERT INTO users
    (id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES('m21-user','m21@example.invalid','test','user','active','m21-group',100,2,60,'admin',0,0)`).run();
  const envelope = JSON.stringify({ algorithm: 'A256GCM', format_version: 1, key_version: 'test', nonce: 'nonce', ciphertext: 'ciphertext' });
  await testEnv.DB.prepare(`INSERT INTO channels
    (id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES('m21-channel','M21 channel','https://example.invalid',?,'test','active',0,2,60,1,0,0)`).bind(envelope).run();
  await testEnv.DB.prepare(`INSERT INTO models
    (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at)
    VALUES('m21-model','active','{}',1,0,1024,0,0)`).run();
  await testEnv.DB.prepare("INSERT INTO channel_groups(channel_id,group_id) VALUES('m21-channel','m21-group')").run();
  await testEnv.DB.prepare(`INSERT INTO channel_models
    (channel_id,public_model_id,upstream_model,protocol,capabilities_json,config_version)
    VALUES('m21-channel','m21-model','m21-upstream','chat','{}',1)`).run();
  await testEnv.DB.prepare(`INSERT INTO api_keys
    (id,user_id,key_hash,display_prefix,name,status,created_at,updated_at,creation_operation_id,creation_fingerprint)
    VALUES('m21-key','m21-user',?,'s2a_key_ABCDEFGH','M21 API','active',?,?,?,?)`)
    .bind('a'.repeat(64), now, now, 'm21-create', 'b'.repeat(64)).run();
  await testEnv.DB.prepare(`INSERT INTO requests
    (id,user_id,api_key_id,channel_id,public_model_id,upstream_model,downstream_protocol,upstream_protocol,price_snapshot,created_at,updated_at)
    VALUES('m21-request','m21-user','m21-key','m21-channel','m21-model','m21-upstream','chat','chat',?,?,?)`)
    .bind('{}', now, now).run();
  const usage = JSON.stringify({ quality: 'complete', protocol: 'chat',
    counts: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
    semantics: { cacheRead: 'unknown', cacheWrite: 'unknown', reasoning: 'unknown', cacheWriteTtl: 'unknown' },
    issues: [], sources: [{ protocol: 'chat', path: 'usage' }] });
  await testEnv.DB.prepare(`INSERT INTO billing_entries
    (id,operation_id,kind,user_id,request_id,delta_units,fingerprint,usage_snapshot,price_snapshot,created_at)
    VALUES('m21-entry','m21-entry-operation','consumption','m21-user','m21-request',-1,'m21-fingerprint',?,?,?)`)
    .bind(usage, '{}', now).run();
}

beforeEach(async () => {
  const before = allMigrations().filter(migration => Number(migration.name.slice(0, 4)) < 21);
  await resetTestDatabase(before);
  await seedPreWebChatRows();
  const target = allMigrations().find(migration => migration.name.startsWith('0021_'));
  expect(target).toBeDefined();
  await migrateTestDatabase([target!]);
});

describe('0021 web-chat Key migration on native D1', () => {
  it('keeps request and ledger rows attached to the rebuilt parent', async () => {
    expect(await testEnv.DB.prepare("SELECT kind,key_hash,display_prefix,group_id FROM api_keys WHERE id='m21-key'").first())
      .toEqual({ kind: 'api', key_hash: 'a'.repeat(64), display_prefix: 's2a_key_ABCDEFGH', group_id: 'm21-group' });
    expect(await testEnv.DB.prepare("SELECT api_key_id,billing_status FROM requests WHERE id='m21-request'").first())
      .toEqual({ api_key_id: 'm21-key', billing_status: 'settled' });
    expect(await testEnv.DB.prepare("SELECT request_id FROM billing_entries WHERE id='m21-entry'").first())
      .toEqual({ request_id: 'm21-request' });
    expect((await testEnv.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    expect((await testEnv.DB.prepare('PRAGMA foreign_key_list(requests)').all()).results)
      .toEqual(expect.arrayContaining([expect.objectContaining({ table: 'api_keys', from: 'api_key_id', on_delete: 'RESTRICT', on_update: 'RESTRICT' })]));
    expect((await testEnv.DB.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='billing_entries_validate_consumption'").all()).results)
      .toEqual([{ name: 'billing_entries_validate_consumption' }]);
  });

  it('creates group-less virtual rows, preserves API default-group compatibility, and enforces singleton identity', async () => {
    await testEnv.DB.prepare(`INSERT INTO api_keys
      (id,user_id,kind,name,status,created_at,updated_at) VALUES('m21-web','m21-user','web_chat','Web chat','active',?,?)`)
      .bind(now, now).run();
    expect(await testEnv.DB.prepare("SELECT kind,key_hash,display_prefix,group_id,expires_at,allowed_models_json FROM api_keys WHERE id='m21-web'").first())
      .toEqual({ kind: 'web_chat', key_hash: null, display_prefix: null, group_id: null, expires_at: null, allowed_models_json: null });
    await expect(testEnv.DB.prepare(`INSERT INTO api_keys
      (id,user_id,key_hash,display_prefix,name,status,created_at,updated_at)
      VALUES('m21-api-import','m21-user',?,'s2a_key_BCDEFGHI','API import','active',?,?)`)
      .bind('c'.repeat(64), now, now).run()).resolves.toBeDefined();
    expect(await testEnv.DB.prepare("SELECT kind,group_id FROM api_keys WHERE id='m21-api-import'").first())
      .toEqual({ kind: 'api', group_id: 'm21-group' });
    await expect(testEnv.DB.prepare(`INSERT INTO api_keys
      (id,user_id,kind,name,status,created_at,updated_at) VALUES('m21-web-duplicate','m21-user','web_chat','Web chat','active',?,?)`)
      .bind(now, now).run()).rejects.toThrow();
    await expect(testEnv.DB.prepare(`INSERT INTO api_keys
      (id,user_id,kind,group_id,name,status,created_at,updated_at) VALUES('m21-web-group','m21-user','web_chat','m21-group','Web chat','active',?,?)`)
      .bind(now, now).run()).rejects.toThrow('web_chat_group_must_be_null');
  });

  it('retains creation identity immutability and excludes virtual rows from the old index', async () => {
    await testEnv.DB.prepare(`INSERT INTO api_keys
      (id,user_id,kind,name,status,created_at,updated_at) VALUES('m21-web','m21-user','web_chat','Web chat','active',?,?)`)
      .bind(now, now).run();
    await expect(testEnv.DB.prepare("UPDATE api_keys SET user_id='m21-other' WHERE id='m21-key'").run())
      .rejects.toThrow('api_key_creation_identity_immutable');
    await expect(testEnv.DB.prepare("UPDATE api_keys SET creation_operation_id='rewrite',creation_fingerprint=? WHERE id='m21-key'")
      .bind('c'.repeat(64)).run()).rejects.toThrow('api_key_creation_identity_immutable');
    await expect(testEnv.DB.prepare("UPDATE api_keys SET group_id='m21-group' WHERE id='m21-web'").run())
      .rejects.toThrow('web_chat_group_must_be_null');
    expect((await testEnv.DB.prepare("SELECT id FROM api_keys WHERE kind='api' ORDER BY id").all()).results)
      .toEqual([{ id: 'm21-key' }]);
  });
});
