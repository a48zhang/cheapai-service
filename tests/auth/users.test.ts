import { beforeEach, describe, expect, it } from 'vitest';
import { findInternalAuthUserByEmail, findPublicUserById } from '../../apps/worker/auth/users';
import { prepare } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const groupId = 'a01-test-group';
const now = 1_788_619_000_123;
const passwordHash = 'a01-test-only-password-hash';

async function seedUser(id = 'a01-user', email = 'user@example.invalid') {
  await prepare(testEnv.DB,
    `INSERT INTO users (id, email_normalized, password_hash, role, status, group_id,
      balance_units, concurrency_limit, rpm_limit, created_via, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, email, passwordHash, 'user', 'active', groupId, -42, 2, 60, 'admin', now, now]).run();
}

beforeEach(async () => {
  await prepare(testEnv.DB,
    'INSERT INTO groups (id, name, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [groupId, 'A01 Test Group', 'active', 1, now, now]).run();
  await seedUser();
});

describe('user reads on native D1', () => {
  it('looks up a normalized email with internal password access but safe JSON/spread', async () => {
    const user = await findInternalAuthUserByEmail(testEnv.DB, 'user@example.invalid');
    expect(user?.password_hash).toBe(passwordHash);
    expect(user).toMatchObject({
      id: 'a01-user', email_normalized: 'user@example.invalid', role: 'user', status: 'active',
      group_id: groupId, group_status: 'active', balance_units: '-42', email_verified_at: null,
    });
    expect(JSON.stringify(user)).not.toContain(passwordHash);
    expect(JSON.stringify(user)).not.toContain('password_hash');
    expect({ ...user }).not.toHaveProperty('password_hash');
  });

  it('returns only the minimal public projection for the authenticated user', async () => {
    const user = await findPublicUserById(testEnv.DB, 'a01-user', { userId: 'a01-user' });
    expect(user).toEqual({
      id: 'a01-user', email_normalized: 'user@example.invalid', role: 'user', status: 'active',
      group_id: groupId, group_status: 'active', balance_units: '-42', email_verified_at: null,
    });
    expect(user).not.toHaveProperty('password_hash');
    expect(JSON.stringify(user)).not.toContain(passwordHash);
  });

  it('cannot read another user by changing the requested ID', async () => {
    await seedUser('a01-other', 'other@example.invalid');
    expect(await findPublicUserById(testEnv.DB, 'a01-other', { userId: 'a01-user' })).toBeNull();
    expect(await findPublicUserById(testEnv.DB, 'a01-user', { userId: 'a01-other' })).toBeNull();
  });

  it('returns null for missing rows', async () => {
    expect(await findInternalAuthUserByEmail(testEnv.DB, 'missing@example.invalid')).toBeNull();
    expect(await findPublicUserById(testEnv.DB, 'missing', { userId: 'missing' })).toBeNull();
  });

  it('preserves disabled user/group state, admin role and verification timestamp', async () => {
    await prepare(testEnv.DB, 'UPDATE users SET role = ?, status = ?, email_verified_at = ? WHERE id = ?',
      ['admin', 'disabled', now, 'a01-user']).run();
    await prepare(testEnv.DB, 'UPDATE groups SET status = ? WHERE id = ?', ['disabled', groupId]).run();
    for (const user of [
      await findInternalAuthUserByEmail(testEnv.DB, 'user@example.invalid'),
      await findPublicUserById(testEnv.DB, 'a01-user', { userId: 'a01-user' }),
    ]) expect(user).toMatchObject({ role: 'admin', status: 'disabled', group_status: 'disabled', email_verified_at: now });
  });

  it.each([-9007199254740991, 0, 9007199254740991])('returns exact decimal balance string for %s', async (balance) => {
    await prepare(testEnv.DB, 'UPDATE users SET balance_units = ? WHERE id = ?', [balance, 'a01-user']).run();
    expect((await findInternalAuthUserByEmail(testEnv.DB, 'user@example.invalid'))?.balance_units).toBe(String(balance));
    expect((await findPublicUserById(testEnv.DB, 'a01-user', { userId: 'a01-user' }))?.balance_units).toBe(String(balance));
  });

  it('binds email and identity values including SQL metacharacters', async () => {
    const id = "a01-'quoted-id";
    const email = "o'hara@example.invalid";
    await seedUser(id, email);
    expect((await findInternalAuthUserByEmail(testEnv.DB, email))?.id).toBe(id);
    expect((await findPublicUserById(testEnv.DB, id, { userId: id }))?.id).toBe(id);
    expect(await findInternalAuthUserByEmail(testEnv.DB, "'or'1'='1@example.invalid")).toBeNull();
    expect(await findPublicUserById(testEnv.DB, "' OR 1=1 --", { userId: 'a01-user' })).toBeNull();
    expect(await findPublicUserById(testEnv.DB, 'a01-user', { userId: "' OR 1=1 --" })).toBeNull();
  });

  it.each(['', 'user', 'user@', '@example.invalid', 'user@example', 'USER@example.invalid',
    ' user@example.invalid', 'user@example.invalid ', 'user\n@example.invalid', 'user\u0000@example.invalid'])
    ('rejects unnormalized or malformed email %# without silently rewriting it', async (email) => {
      await expect(findInternalAuthUserByEmail(testEnv.DB, email)).rejects.toThrow('Expected a normalized email address.');
    });

  it.each(['', ' ', '\u0000'])('rejects absent or malformed identity %#', async (id) => {
    await expect(findPublicUserById(testEnv.DB, id, { userId: 'a01-user' })).rejects.toThrow(TypeError);
    await expect(findPublicUserById(testEnv.DB, 'a01-user', { userId: id })).rejects.toThrow(TypeError);
  });
});
