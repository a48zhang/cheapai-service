import { beforeEach, describe, expect, it } from 'vitest';
import { generateToken, getTokenDisplayPrefix, hashToken } from '../../apps/worker/auth/tokens';
import { prepare } from '../../apps/worker/db';
import type { DbValue } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const now = 1_788_621_000_123;
const userId = 'd04-test-user';
const base = { id: 'd04-test-key', user_id: userId, key_hash: 'a1'.repeat(32),
  display_prefix: 's2a_key_ABCDEFGH', name: 'D04 integration key', status: 'active', created_at: now, updated_at: now };

async function insertKey(overrides: Record<string, DbValue> = {}) {
  const row = { ...base, ...overrides };
  const columns = Object.keys(row);
  return prepare(testEnv.DB,
    `INSERT INTO api_keys (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) RETURNING *`, Object.values(row)).run();
}

beforeEach(async () => {
  await prepare(testEnv.DB,
    'INSERT INTO groups (id, name, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['d04-test-group', 'D04 Test Group', 'active', 1, now, now]).run();
  await prepare(testEnv.DB,
    `INSERT INTO users (id, email_normalized, password_hash, role, status, group_id,
      concurrency_limit, rpm_limit, created_via, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, 'd04-user@example.invalid', 'test-only-hash-not-for-authentication', 'user', 'active', 'd04-test-group', 2, 60, 'registration', now, now]).run();
});

describe('0004 API keys migration on native D1', () => {
  it('stores actual F13 hash and display prefix, without the full credential', async () => {
    const token = generateToken('apiKey');
    const key_hash = await hashToken('apiKey', token);
    const display_prefix = getTokenDisplayPrefix('apiKey', token);
    const saved = await insertKey({ key_hash, display_prefix });
    expect(saved.rows).toEqual([{ ...base, key_hash, display_prefix, expires_at: null, allowed_models_json: null, version: 1 }]);
    expect(JSON.stringify(saved.rows)).not.toContain(token);
    await expect(insertKey({ id: 'd04-full-hash', key_hash: token })).rejects.toThrow();
    await expect(insertKey({ id: 'd04-full-prefix', key_hash: 'b'.repeat(64), display_prefix: token })).rejects.toThrow();
  });

  it('enforces ID and digest uniqueness while allowing shared display prefixes/names', async () => {
    await insertKey();
    await expect(insertKey({ id: 'another-id' })).rejects.toThrow();
    await expect(insertKey({ key_hash: 'b'.repeat(64) })).rejects.toThrow();
    expect((await insertKey({ id: 'second-key', key_hash: 'b'.repeat(64) })).changes).toBe(1);
  });

  it.each(['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), null])('rejects invalid key hash %s', async (key_hash) => {
    await expect(insertKey({ key_hash })).rejects.toThrow();
  });

  it.each(['s2a_key_', 's2a_key_ABCDEFGH9', 's2a_key_ABCDEF+H', 's2a_key_ABCDEF/H', 'wrong___ABCDEFGH', null])('rejects invalid display prefix %s', async (display_prefix) => {
    await expect(insertKey({ display_prefix })).rejects.toThrow();
  });

  it('distinguishes SQL NULL inheritance from an empty model list and explicit models', async () => {
    await insertKey();
    const empty = await insertKey({ id: 'd04-none', key_hash: 'b'.repeat(64), allowed_models_json: '[]' });
    const scoped = await insertKey({ id: 'd04-scoped', key_hash: 'c'.repeat(64), allowed_models_json: '["model-a","model-b"]' });
    expect(empty.rows[0]).toMatchObject({ allowed_models_json: '[]' });
    expect(scoped.rows[0]).toMatchObject({ allowed_models_json: '["model-a","model-b"]' });
    expect(await prepare(testEnv.DB, 'SELECT allowed_models_json FROM api_keys WHERE id = ?', [base.id]).first()).toEqual({ allowed_models_json: null });
  });

  it.each(['', '{invalid}', '{}', 'null', 'true', '42', '"model-a"'])('rejects non-array model JSON %s', async (allowed_models_json) => {
    await expect(insertKey({ allowed_models_json })).rejects.toThrow();
  });

  it('requires a real owner and prevents deletion of referenced users', async () => {
    await expect(insertKey({ user_id: 'd04-missing-user' })).rejects.toThrow();
    await expect(insertKey({ user_id: null })).rejects.toThrow();
    await insertKey();
    await expect(prepare(testEnv.DB, 'DELETE FROM users WHERE id = ?', [userId]).run()).rejects.toThrow();
  });

  it('supports explicit revocation and rejects other statuses or empty identities', async () => {
    for (const status of ['disabled', 'expired', '', null]) await expect(insertKey({ status })).rejects.toThrow();
    for (const field of ['id', 'name']) {
      for (const value of ['', ' ', null]) await expect(insertKey({ [field]: value })).rejects.toThrow();
    }
    await insertKey();
    const revoked = await prepare(testEnv.DB,
      'UPDATE api_keys SET status = ?, updated_at = ?, version = version + 1 WHERE id = ? AND status = ? RETURNING status, version',
      ['revoked', now + 1, base.id, 'active']).run();
    expect(revoked.rows).toEqual([{ status: 'revoked', version: 2 }]);
    expect((await prepare(testEnv.DB, 'SELECT id FROM api_keys WHERE user_id = ? AND status = ?', [userId, 'active']).all()).rows).toEqual([]);
  });

  it('requires safe integer timestamps, positive version and strictly later non-null expiry', async () => {
    for (const field of ['created_at', 'updated_at', 'expires_at']) {
      for (const value of [-1, 0.5, 9007199254740992, 'invalid']) await expect(insertKey({ [field]: value })).rejects.toThrow();
    }
    for (const field of ['created_at', 'updated_at']) await expect(insertKey({ [field]: null })).rejects.toThrow();
    for (const version of [0, -1, 1.5, 9007199254740992, 'invalid', null]) await expect(insertKey({ version })).rejects.toThrow();
    await expect(insertKey({ expires_at: now })).rejects.toThrow();
    await expect(insertKey({ expires_at: now - 1 })).rejects.toThrow();
    expect((await insertKey({ expires_at: now + 1 })).rows[0]).toMatchObject({ expires_at: now + 1 });
  });

  it('applies constraints to updates as well as insertion', async () => {
    await insertKey();
    await expect(prepare(testEnv.DB, 'UPDATE api_keys SET expires_at = created_at WHERE id = ?', [base.id]).run()).rejects.toThrow();
    await expect(prepare(testEnv.DB, 'UPDATE api_keys SET allowed_models_json = ? WHERE id = ?', ['{}', base.id]).run()).rejects.toThrow();
  });

  it('indexes owner/status, expiration and unique key digest', async () => {
    expect((await prepare<{ name: string }>(testEnv.DB, "PRAGMA index_info('idx_api_keys_user_status')").all()).rows.map((row) => row.name)).toEqual(['user_id', 'status']);
    expect((await prepare<{ name: string }>(testEnv.DB, "PRAGMA index_info('idx_api_keys_expires')").all()).rows.map((row) => row.name)).toEqual(['expires_at']);
    expect((await prepare(testEnv.DB, "PRAGMA index_list('api_keys')").all()).rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'idx_api_keys_expires', partial: 1 }),
      expect.objectContaining({ origin: 'pk', unique: 1 }), expect.objectContaining({ origin: 'u', unique: 1 }),
    ]));
  });
});
