import { beforeEach, describe, expect, it } from 'vitest';
import { prepare } from '../../apps/worker/db';
import type { DbValue } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const groupId = 'd02-test-group';
const userId = 'd02-test-user';
const now = 1_788_619_000_123;
const baseUser = {
  id: userId,
  email_normalized: 'd02-user@example.invalid',
  password_hash: 'test-only-hash-not-for-authentication',
  role: 'user', status: 'active', group_id: groupId,
  concurrency_limit: 2, rpm_limit: 60, created_via: 'registration',
  created_at: now, updated_at: now,
};

// Only fixed, test-owned column keys enter SQL; all values remain parameterized.
async function insertUser(overrides: Record<string, DbValue> = {}) {
  const row = { ...baseUser, ...overrides };
  const columns = Object.keys(row);
  return prepare(testEnv.DB,
    `INSERT INTO users (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) RETURNING *`,
    Object.values(row)).run();
}

beforeEach(async () => {
  await prepare(testEnv.DB,
    'INSERT INTO groups (id, name, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [groupId, 'D02 Test Group', 'active', 1, now, now]).run();
});

describe('0002 users migration on native D1', () => {
  it('defaults only balance/version and leaves verification/source-code optional', async () => {
    const inserted = await insertUser();
    expect(inserted.changes).toBe(1);
    expect(inserted.rows).toEqual([{ ...baseUser, balance_units: 0, version: 1,
      email_verified_at: null, registration_code_id: null }]);
  });

  it('enforces unique IDs and normalized emails', async () => {
    await insertUser();
    await expect(insertUser({ id: 'other-user' })).rejects.toThrow();
    await expect(insertUser({ email_normalized: 'other@example.invalid' })).rejects.toThrow();
    for (const email of ['', '   ', 'UPPER@example.invalid', ' user@example.invalid', 'user@example.invalid ', null]) {
      await expect(insertUser({ id: 'invalid-email', email_normalized: email })).rejects.toThrow();
    }
  });

  it.each(['user', 'admin'])('accepts explicit %s role', async (role) => {
    expect((await insertUser({ role })).rows[0]).toMatchObject({ role });
  });

  it.each(['active', 'disabled'])('accepts explicit %s status', async (status) => {
    expect((await insertUser({ status })).rows[0]).toMatchObject({ status });
  });

  it.each(['registration', 'admin', 'bootstrap'])('preserves %s creation provenance', async (created_via) => {
    expect((await insertUser({ created_via })).rows[0]).toMatchObject({ created_via });
  });

  it('rejects invalid enum values and missing identities/hashes', async () => {
    const invalidUsers: Record<string, DbValue>[] = [
      { role: 'owner' }, { role: null }, { status: 'enabled' }, { status: null },
      { created_via: 'unknown' }, { created_via: null }, { id: null }, { id: ' ' },
      { password_hash: '' }, { password_hash: null }, { registration_code_id: '' },
    ];
    for (const overrides of invalidUsers) await expect(insertUser(overrides)).rejects.toThrow();
  });

  it.each([-9007199254740991, -1, 0, 1, 9007199254740991])('allows safe integer balance %s including debt', async (balance_units) => {
    expect((await insertUser({ balance_units })).rows[0]).toMatchObject({ balance_units });
  });

  it.each([-9007199254740992, 9007199254740992, 0.5, 'not-integer', null])('rejects unsafe/non-integer balance %s', async (balance_units) => {
    await expect(insertUser({ balance_units })).rejects.toThrow();
  });

  it('rejects non-positive/fractional/unsafe counters and versions', async () => {
    for (const column of ['concurrency_limit', 'rpm_limit', 'version']) {
      for (const value of [0, -1, 1.5, 9007199254740992, 'not-integer', null]) {
        await expect(insertUser({ [column]: value })).rejects.toThrow();
      }
    }
  });

  it('requires safe nonnegative integer timestamps and permits unverified null', async () => {
    for (const column of ['created_at', 'updated_at', 'email_verified_at']) {
      for (const value of [-1, 0.5, 9007199254740992, 'not-integer']) {
        await expect(insertUser({ [column]: value })).rejects.toThrow();
      }
    }
    await expect(insertUser({ created_at: null })).rejects.toThrow();
    await expect(insertUser({ updated_at: null })).rejects.toThrow();
    expect((await insertUser({ email_verified_at: now })).rows[0]).toMatchObject({ email_verified_at: now });
  });

  it('requires an existing group and restricts deleting a referenced group', async () => {
    await expect(insertUser({ group_id: 'd02-nonexistent-group' })).rejects.toThrow();
    await expect(insertUser({ group_id: null })).rejects.toThrow();
    await insertUser();
    await expect(prepare(testEnv.DB, 'DELETE FROM groups WHERE id = ?', [groupId]).run()).rejects.toThrow();
    expect(await prepare(testEnv.DB, 'SELECT id FROM groups WHERE id = ?', [groupId]).first()).toEqual({ id: groupId });
  });

  it('has no forward reference to a future registration table', async () => {
    const keys = await prepare<{ table: string; from: string }>(testEnv.DB, "PRAGMA foreign_key_list('users')").all();
    expect(keys.rows.map(({ table, from }) => ({ table, from }))).toEqual([{ table: 'groups', from: 'group_id' }]);
    // Source validation is added with D05; D02 itself does not consume a code.
    expect((await insertUser({ registration_code_id: 'd02-source-code' })).rows[0]).toMatchObject({ registration_code_id: 'd02-source-code' });
  });

  it('rejects overflow on update and preserves the previous balance', async () => {
    await insertUser({ balance_units: 9007199254740991 });
    await expect(prepare(testEnv.DB, 'UPDATE users SET balance_units = balance_units + 1 WHERE id = ?', [userId]).run()).rejects.toThrow();
    expect(await prepare(testEnv.DB, 'SELECT balance_units FROM users WHERE id = ?', [userId]).first()).toEqual({ balance_units: 9007199254740991 });
  });

  it('exposes group/status and status/time pagination indexes plus unique keys', async () => {
    expect((await prepare<{ name: string }>(testEnv.DB, "PRAGMA index_info('idx_users_group_status')").all()).rows.map((row) => row.name)).toEqual(['group_id', 'status']);
    expect((await prepare<{ name: string }>(testEnv.DB, "PRAGMA index_info('idx_users_status_created_id')").all()).rows.map((row) => row.name)).toEqual(['status', 'created_at', 'id']);
    const indexes = await prepare(testEnv.DB, "PRAGMA index_list('users')").all();
    expect(indexes.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: 'pk', unique: 1 }), expect.objectContaining({ origin: 'u', unique: 1 }),
    ]));
  });
});
