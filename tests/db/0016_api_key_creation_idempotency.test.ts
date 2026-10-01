import { beforeEach, describe, expect, inject, it } from 'vitest';
import { migrateTestDatabase, resetTestDatabase, testEnv } from '../helpers/database';

const now = 1000;
const fingerprint = 'a'.repeat(64);

async function seedOwners() {
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES ('d16-group','D16 group','active',1,0,0)").run();
  for (const id of ['d16-a', 'd16-b']) await testEnv.DB.prepare(`INSERT INTO users
    (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES (?,?,'test-hash','user','active','d16-group',2,60,'admin',0,0)`)
    .bind(id, `${id}@example.invalid`).run();
}

async function insert(id: string, owner = 'd16-a', operation: string | null = 'create-1', hash: string | null = fingerprint) {
  // Unique synthetic digest per row, independent from the creation fingerprint.
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id)));
  const keyHash = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return testEnv.DB.prepare(`INSERT INTO api_keys
    (id,user_id,key_hash,display_prefix,name,status,created_at,updated_at,creation_operation_id,creation_fingerprint)
    VALUES (?,?,?,'s2a_key_ABCDEFGH','Test key','active',?,?,?,?)`)
    .bind(id, owner, keyHash, now, now, operation, hash).run();
}

beforeEach(seedOwners);

describe('0016 platform Key creation idempotency schema on native D1', () => {
  it('migrates existing Keys in place with NULL metadata and unchanged other fields', async () => {
    const migrations = inject('d1Migrations');
    const target = migrations.find(migration => migration.name.startsWith('0016_'));
    expect(target).toBeDefined();
    await resetTestDatabase(migrations.filter(migration => Number(migration.name.slice(0, 4)) < 16));
    await seedOwners();
    await testEnv.DB.prepare(`INSERT INTO api_keys
      (id,user_id,key_hash,display_prefix,name,status,expires_at,allowed_models_json,created_at,updated_at,version)
      VALUES ('legacy','d16-a',?,'s2a_key_ABCDEFGH','Old key','revoked',2000,'[]',1000,1100,3)`)
      .bind('b'.repeat(64)).run();
    const before = await testEnv.DB.prepare("SELECT * FROM api_keys WHERE id='legacy'").first();
    await migrateTestDatabase([target!]);
    expect(await testEnv.DB.prepare("SELECT * FROM api_keys WHERE id='legacy'").first())
      .toEqual({ ...before, creation_operation_id: null, creation_fingerprint: null });
    await insert('legacy-style-new', 'd16-a', null, null);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM api_keys').first('COUNT(*)')).toBe(2);
  });

  it('rejects duplicate operation IDs per owner regardless of matching fingerprint', async () => {
    await insert('first');
    await expect(insert('same-operation')).rejects.toThrow();
    await expect(insert('same-operation-different-fingerprint', 'd16-a', 'create-1', 'b'.repeat(64))).rejects.toThrow();
    expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM api_keys').first('COUNT(*)')).toBe(1);
  });

  it('allows the same operation ID for another owner and distinct operations for one owner', async () => {
    await insert('first');
    await insert('other-owner', 'd16-b');
    await insert('other-operation', 'd16-a', 'create-2');
    expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM api_keys').first('COUNT(*)')).toBe(3);
  });

  it('keeps multiple legacy NULL pairs valid', async () => {
    await insert('old-1', 'd16-a', null, null);
    await insert('old-2', 'd16-a', null, null);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM api_keys').first('COUNT(*)')).toBe(2);
  });

  it.each([
    [null, fingerprint], ['operation', null],
  ] as const)('requires operation/fingerprint together: %s/%s', async (operation, hash) => {
    await expect(insert('half', 'd16-a', operation, hash)).rejects.toThrow();
  });

  it.each(['', ' ', ' leading', 'trailing ', 'a\nb', 'x'.repeat(129), 'slash/value'])('rejects malformed operation ID %#', async operation => {
    await expect(insert('bad', 'd16-a', operation)).rejects.toThrow();
  });

  it('accepts the exact operation length boundary and documented ASCII characters', async () => {
    await insert('max', 'd16-a', 'a'.repeat(128));
    await insert('chars', 'd16-a', 'client_1:operation-2.v3');
  });

  it.each(['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), ' '.repeat(64)])('rejects malformed fingerprint %#', async hash => {
    await expect(insert('bad', 'd16-a', 'op', hash)).rejects.toThrow();
  });

  it('makes owner/operation/fingerprint immutable without blocking ordinary updates', async () => {
    await insert('key');
    for (const [sql, binding] of [
      ['UPDATE api_keys SET user_id=? WHERE id=\'key\'', 'd16-b'],
      ['UPDATE api_keys SET creation_operation_id=? WHERE id=\'key\'', 'new-operation'],
      ['UPDATE api_keys SET creation_fingerprint=? WHERE id=\'key\'', 'b'.repeat(64)],
    ] as const) await expect(testEnv.DB.prepare(sql).bind(binding).run()).rejects.toThrow('api_key_creation_identity_immutable');
    await expect(testEnv.DB.prepare("UPDATE api_keys SET creation_operation_id=NULL,creation_fingerprint=NULL WHERE id='key'").run())
      .rejects.toThrow('api_key_creation_identity_immutable');
    await testEnv.DB.prepare(`UPDATE api_keys SET name='Renamed', expires_at=3000, status='revoked',
      allowed_models_json='[]', updated_at=2000, version=2 WHERE id='key'`).run();
    await testEnv.DB.prepare(`UPDATE api_keys SET user_id='d16-a', creation_operation_id='create-1', creation_fingerprint=? WHERE id='key'`)
      .bind(fingerprint).run();
    expect(await testEnv.DB.prepare("SELECT name,status,expires_at,creation_operation_id,creation_fingerprint,user_id FROM api_keys WHERE id='key'").first())
      .toEqual({ name: 'Renamed', status: 'revoked', expires_at: 3000, creation_operation_id: 'create-1', creation_fingerprint: fingerprint, user_id: 'd16-a' });
  });

  it('prevents assigning an operation identity or a different owner to a legacy Key', async () => {
    await insert('old', 'd16-a', null, null);
    await expect(testEnv.DB.prepare("UPDATE api_keys SET creation_operation_id='adopted',creation_fingerprint=? WHERE id='old'").bind(fingerprint).run())
      .rejects.toThrow('api_key_creation_identity_immutable');
    await expect(testEnv.DB.prepare("UPDATE api_keys SET user_id='d16-b' WHERE id='old'").run()).rejects.toThrow('api_key_creation_identity_immutable');
  });

  it('rolls back an entire batch if a later statement rewrites creation identity', async () => {
    await insert('key');
    await expect(testEnv.DB.batch([
      testEnv.DB.prepare("UPDATE api_keys SET name='Should rollback' WHERE id='key'"),
      testEnv.DB.prepare("UPDATE api_keys SET creation_operation_id='rewritten' WHERE id='key'"),
    ])).rejects.toThrow();
    expect(await testEnv.DB.prepare("SELECT name FROM api_keys WHERE id='key'").first('name')).toBe('Test key');
  });
});
