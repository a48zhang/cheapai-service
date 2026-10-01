import { beforeEach, describe, expect, it } from 'vitest';
import { generateToken, getTokenDisplayPrefix, hashToken } from '../../apps/worker/auth/tokens';
import { prepare } from '../../apps/worker/db';
import type { DbValue } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const now = 1_788_622_000_123;
const creator = 'd05-test-admin';
const consumer = 'd05-test-consumer';
const base = { id: 'd05-test-code', code_hash: 'a1'.repeat(32), display_prefix: 's2a_invite_ABCDEFGH',
  created_by: creator, created_at: now, operation_id: 'd05-test-operation', ordinal: 0 };

async function insertCode(overrides: Record<string, DbValue> = {}) {
  const row = { ...base, ...overrides };
  const columns = Object.keys(row);
  return prepare(testEnv.DB,
    `INSERT INTO registration_codes (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) RETURNING *`, Object.values(row)).run();
}

beforeEach(async () => {
  await prepare(testEnv.DB,
    'INSERT INTO groups (id, name, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['d05-test-group', 'D05 Test Group', 'active', 1, now, now]).run();
  for (const [id, role] of [[creator, 'admin'], [consumer, 'user']] as const) {
    await prepare(testEnv.DB,
      `INSERT INTO users (id, email_normalized, password_hash, role, status, group_id,
        concurrency_limit, rpm_limit, created_via, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, `${id}@example.invalid`, 'test-only-hash-not-for-authentication', role, 'active', 'd05-test-group', 2, 60, 'admin', now, now]).run();
  }
});

describe('0005 registration codes migration on native D1', () => {
  it('stores actual F13 invitation metadata and defaults optional lifecycle fields to NULL', async () => {
    const token = generateToken('invitation');
    const code_hash = await hashToken('invitation', token);
    const display_prefix = getTokenDisplayPrefix('invitation', token);
    const saved = await insertCode({ code_hash, display_prefix });
    expect(saved.rows).toEqual([{ ...base, code_hash, display_prefix, expires_at: null, revoked_at: null, used_by: null, used_at: null }]);
    expect(JSON.stringify(saved.rows)).not.toContain(token);
    await expect(insertCode({ id: 'plaintext-hash', code_hash: token })).rejects.toThrow();
    await expect(insertCode({ id: 'plaintext-prefix', code_hash: 'b'.repeat(64), ordinal: 1, display_prefix: token })).rejects.toThrow();
  });

  it('enforces unique IDs/digests and the generation operation plus ordinal mapping', async () => {
    await insertCode();
    await expect(insertCode({ code_hash: 'b'.repeat(64), ordinal: 1 })).rejects.toThrow();
    await expect(insertCode({ id: 'd05-other', ordinal: 1 })).rejects.toThrow();
    await expect(insertCode({ id: 'd05-other', code_hash: 'b'.repeat(64) })).rejects.toThrow();
    await insertCode({ id: 'd05-second', code_hash: 'b'.repeat(64), ordinal: 1 });
    await insertCode({ id: 'd05-new-operation', code_hash: 'c'.repeat(64), operation_id: 'd05-other-operation' });
    expect((await prepare(testEnv.DB,
      'SELECT id, ordinal FROM registration_codes WHERE operation_id = ? ORDER BY ordinal', [base.operation_id]).all()).rows)
      .toEqual([{ id: base.id, ordinal: 0 }, { id: 'd05-second', ordinal: 1 }]);
  });

  it('rejects malformed digests and display prefixes', async () => {
    for (const code_hash of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), null]) {
      await expect(insertCode({ code_hash })).rejects.toThrow();
    }
    for (const display_prefix of ['', 's2a_invite_', 's2a_invite_ABCDEFGH9', 's2a_invite_ABCDEF+H', 's2a_key_ABCDEFGH', null]) {
      await expect(insertCode({ display_prefix })).rejects.toThrow();
    }
  });

  it('requires usage identity/time together on both insertion and update', async () => {
    await expect(insertCode({ used_by: consumer })).rejects.toThrow();
    await expect(insertCode({ used_at: now + 1 })).rejects.toThrow();
    await insertCode();
    await expect(prepare(testEnv.DB, 'UPDATE registration_codes SET used_by = ? WHERE id = ?', [consumer, base.id]).run()).rejects.toThrow();
    await prepare(testEnv.DB, 'UPDATE registration_codes SET used_by = ?, used_at = ? WHERE id = ?', [consumer, now + 1, base.id]).run();
    expect(await prepare(testEnv.DB, 'SELECT used_by, used_at FROM registration_codes WHERE id = ?', [base.id]).first())
      .toEqual({ used_by: consumer, used_at: now + 1 });
    await expect(prepare(testEnv.DB, 'UPDATE registration_codes SET used_at = NULL WHERE id = ?', [base.id]).run()).rejects.toThrow();
  });

  it('requires existing creator/consumer users and restricts referenced-user deletion', async () => {
    await expect(insertCode({ created_by: 'd05-missing' })).rejects.toThrow();
    await expect(insertCode({ created_by: null })).rejects.toThrow();
    await expect(insertCode({ used_by: 'd05-missing', used_at: now + 1 })).rejects.toThrow();
    await insertCode({ used_by: consumer, used_at: now + 1 });
    for (const id of [creator, consumer]) {
      await expect(prepare(testEnv.DB, 'DELETE FROM users WHERE id = ?', [id]).run()).rejects.toThrow();
    }
  });

  it('validates safe integer lifecycle times and a later optional expiry', async () => {
    for (const field of ['created_at', 'expires_at', 'revoked_at', 'used_at']) {
      for (const value of [-1, 0.5, 9007199254740992, 'invalid']) {
        await expect(insertCode({ [field]: value, ...(field === 'used_at' ? { used_by: consumer } : {}) })).rejects.toThrow();
      }
    }
    await expect(insertCode({ created_at: null })).rejects.toThrow();
    await expect(insertCode({ expires_at: now })).rejects.toThrow();
    await expect(insertCode({ expires_at: now - 1 })).rejects.toThrow();
    expect((await insertCode({ expires_at: now + 1, revoked_at: now })).rows[0]).toMatchObject({ expires_at: now + 1, revoked_at: now });
  });

  it('requires nonempty identities and a zero-based safe integer ordinal', async () => {
    for (const field of ['id', 'operation_id']) {
      for (const value of ['', ' ', null]) await expect(insertCode({ [field]: value })).rejects.toThrow();
    }
    for (const ordinal of [-1, 0.5, 9007199254740992, 'invalid', null]) await expect(insertCode({ ordinal })).rejects.toThrow();
    expect((await insertCode({ ordinal: 9007199254740991 })).changes).toBe(1);
  });

  it('allows recording revocation after use without granting any balance', async () => {
    await insertCode({ used_by: consumer, used_at: now + 1 });
    const updated = await prepare(testEnv.DB,
      'UPDATE registration_codes SET revoked_at = ? WHERE id = ? RETURNING used_by, revoked_at', [now + 2, base.id]).run();
    expect(updated.rows).toEqual([{ used_by: consumer, revoked_at: now + 2 }]);
    expect(await prepare(testEnv.DB, 'SELECT balance_units FROM users WHERE id = ?', [consumer]).first()).toEqual({ balance_units: 0 });
  });

  it('keeps the user provenance column free of a premature cyclic insertion requirement', async () => {
    const foreignKeys = await prepare<{ from: string }>(testEnv.DB, "PRAGMA foreign_key_list('users')").all();
    expect(foreignKeys.rows.some((row) => row.from === 'registration_code_id')).toBe(false);
  });

  it('indexes creator history, consumers, expiry and unique operation positions', async () => {
    const expected = [
      ['idx_registration_codes_creator_created', ['created_by', 'created_at', 'id']],
      ['idx_registration_codes_used_by', ['used_by']], ['idx_registration_codes_expires', ['expires_at']],
    ] as const;
    for (const [index, columns] of expected) {
      expect((await prepare<{ name: string }>(testEnv.DB, `PRAGMA index_info('${index}')`).all()).rows.map((row) => row.name)).toEqual(columns);
    }
    const uniqueIndexes = (await prepare<{ name: string; unique: number }>(testEnv.DB, "PRAGMA index_list('registration_codes')").all()).rows.filter((row) => row.unique === 1);
    const uniqueColumns = await Promise.all(uniqueIndexes.map(async ({ name }) =>
      (await prepare<{ name: string }>(testEnv.DB, `PRAGMA index_info('${name}')`).all()).rows.map((row) => row.name)));
    expect(uniqueColumns).toEqual(expect.arrayContaining([['id'], ['code_hash'], ['operation_id', 'ordinal']]));
  });
});
