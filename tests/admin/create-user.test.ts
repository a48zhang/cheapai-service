import type { CreateUserInput } from '../../apps/worker/admin/create-user';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUser } from '../../apps/worker/admin/create-user';
import * as passwords from '../../apps/worker/auth/password';
import { prepare } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const now = 1_788_619_000_000;
const context = { actorId: 'a21-admin', operationId: 'a21-operation', now };
const input = { email: ' New.User+Tag@Example.Invalid ', password: 'test-only-password-1234', groupId: 'a21-group' };

beforeEach(async () => {
  await prepare(testEnv.DB, 'INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    ['a21-group', 'A21 Group', 'active', 1, now, now]).run();
  await prepare(testEnv.DB, `INSERT INTO users (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES (?,?,?,'admin','active',?,2,60,'bootstrap',?,?)`,
    [context.actorId, 'a21-admin@example.invalid', 'test-only-admin-hash', 'a21-group', now, now]).run();
  vi.spyOn(passwords, 'hashPassword').mockResolvedValue('test-only-mocked-password-hash');
});
afterEach(() => vi.restoreAllMocks());

async function createdCounts() {
  return {
    users: (await prepare(testEnv.DB, "SELECT COUNT(*) AS n FROM users WHERE created_via='admin'").first())?.n,
    audit: (await prepare(testEnv.DB, "SELECT COUNT(*) AS n FROM admin_audit WHERE action='user.create'").first())?.n,
  };
}

describe('administrator user creation on native D1', () => {
  it('uses real password hashing and atomically creates only a zero-balance ordinary user', async () => {
    vi.mocked(passwords.hashPassword).mockRestore();
    const user = await createUser(testEnv.DB, input, context);
    expect(user).toEqual({ id: expect.any(String), email_normalized: 'new.user+tag@example.invalid',
      role: 'user', status: 'active', group_id: 'a21-group', group_status: 'active', balance_units: '0', email_verified_at: null });
    const stored = await prepare<{ password_hash: string; created_via: string }>(testEnv.DB,
      'SELECT password_hash,created_via FROM users WHERE id=?', [user.id]).first();
    expect(stored?.created_via).toBe('admin');
    expect(await passwords.verifyPassword(input.password, stored?.password_hash)).toBe(true);
    const audit = await prepare(testEnv.DB, "SELECT * FROM admin_audit WHERE action='user.create'").first();
    expect(audit?.target_id).toBe(user.id);
    expect(audit?.actor_id).toBe(context.actorId);
    expect(JSON.stringify(user)).not.toContain('hash');
    expect(JSON.stringify(audit)).not.toContain(input.password);
    expect(JSON.stringify(audit)).not.toContain(stored?.password_hash);
    expect(await createdCounts()).toEqual({ users: 1, audit: 1 });
  });

  it('uses the configured active default group when no group is supplied', async () => {
    await prepare(testEnv.DB, `INSERT INTO settings (key,value_json,version,updated_at) VALUES ('default_group_id',?,1,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`, [JSON.stringify('a21-group'), now]).run();
    expect((await createUser(testEnv.DB, { email: input.email, password: input.password }, context)).group_id).toBe('a21-group');
  });

  it('ignores extra and server-owned fields without changing role, status or balance', async () => {
    const result = await createUser(testEnv.DB, { ...input, role: 'admin', balance_units: 100, status: 'disabled', extra: true } as CreateUserInput, context);
    expect(result).toMatchObject({ role: 'user', status: 'active', balance_units: '0' });
  });

  it('rejects duplicate normalized email before hashing', async () => {
    await createUser(testEnv.DB, input, context);
    vi.mocked(passwords.hashPassword).mockClear();
    await expect(createUser(testEnv.DB, { ...input, email: 'new.user+tag@example.invalid' }, context)).rejects.toMatchObject({ code: 'conflict' });
    expect(passwords.hashPassword).not.toHaveBeenCalled();
    expect(await createdCounts()).toEqual({ users: 1, audit: 1 });
  });

  it('rolls back the user when the audit write fails', async () => {
    await prepare(testEnv.DB, "CREATE TRIGGER a21_reject_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'test audit failure'); END").run();
    await expect(createUser(testEnv.DB, input, context)).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(await createdCounts()).toEqual({ users: 0, audit: 0 });
  });

  it('maps an email claimed during KDF to conflict without adding an audit', async () => {
    vi.mocked(passwords.hashPassword).mockImplementation(async () => {
      await prepare(testEnv.DB, `INSERT INTO users
        (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
        VALUES (?, ?, ?, 'user', 'active', ?, 2, 60, 'admin', ?, ?)`,
        ['a21-competing', 'new.user+tag@example.invalid', 'test-only-competing-hash', 'a21-group', now, now]).run();
      return 'test-only-mocked-password-hash';
    });
    await expect(createUser(testEnv.DB, input, context)).rejects.toMatchObject({ code: 'conflict' });
    expect(await createdCounts()).toEqual({ users: 1, audit: 0 });
  });

  it.each(['user', 'disabled'])('rechecks actor authorization after KDF: %s', async (change) => {
    vi.mocked(passwords.hashPassword).mockImplementation(async () => {
      await prepare(testEnv.DB, change === 'user' ? 'UPDATE users SET role=? WHERE id=?' : 'UPDATE users SET status=? WHERE id=?',
        [change, context.actorId]).run();
      return 'test-only-mocked-password-hash';
    });
    await expect(createUser(testEnv.DB, input, context)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await createdCounts()).toEqual({ users: 0, audit: 0 });
  });

  it('rechecks target group activity after KDF inside the batch', async () => {
    await prepare(testEnv.DB, 'INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      ['a21-target', 'A21 Target', 'active', 1, now, now]).run();
    vi.mocked(passwords.hashPassword).mockImplementation(async () => {
      await prepare(testEnv.DB, "UPDATE groups SET status='disabled' WHERE id=?", ['a21-target']).run();
      return 'test-only-mocked-password-hash';
    });
    await expect(createUser(testEnv.DB, { ...input, groupId: 'a21-target' }, context)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await createdCounts()).toEqual({ users: 0, audit: 0 });
  });

  it('maps KDF overload to a safe 503-class error without writes', async () => {
    vi.mocked(passwords.hashPassword).mockRejectedValue(new passwords.PasswordBusyError());
    await expect(createUser(testEnv.DB, input, context)).rejects.toMatchObject({ code: 'service_unavailable', message: 'Service temporarily unavailable.' });
    expect(await createdCounts()).toEqual({ users: 0, audit: 0 });
  });

  it('rejects missing groups and invalid credentials before hashing', async () => {
    await expect(createUser(testEnv.DB, { ...input, groupId: 'missing' }, context)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(createUser(testEnv.DB, { ...input, email: 'invalid' }, context)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(createUser(testEnv.DB, { ...input, password: 'short' }, context)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(passwords.hashPassword).not.toHaveBeenCalled();
  });
});
