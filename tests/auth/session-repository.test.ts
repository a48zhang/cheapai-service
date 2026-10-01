import { beforeEach, describe, expect, it } from 'vitest';
import { createSession, findActiveSessionByHash, revokeSession, revokeUserSessions, SessionCreationError } from '../../apps/worker/auth/session-repository';
import { generateToken, hashToken } from '../../apps/worker/auth/tokens';
import { prepare } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const now = 1_788_619_000_123;
const userId = 'a02-user';
const hash = 'a'.repeat(64);
const input = { id: 'a02-session', userId, tokenHash: hash, expiresAt: now + 1000 };

async function seedUser(id: string) {
  await prepare(testEnv.DB,
    `INSERT INTO users (id, email_normalized, password_hash, role, status, group_id,
     concurrency_limit, rpm_limit, created_via, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, `${id}@example.invalid`, 'test-only-password-hash', 'user', 'active', 'a02-group', 2, 60, 'admin', now, now]).run();
}

beforeEach(async () => {
  await prepare(testEnv.DB,
    'INSERT INTO groups (id, name, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['a02-group', 'A02 Test Group', 'active', 1, now, now]).run();
  await seedUser(userId);
});

describe('session repository on native D1', () => {
  it('stores only the F13 token digest and returns the minimum internal record', async () => {
    const raw = generateToken('session');
    const tokenHash = await hashToken('session', raw);
    const session = await createSession(testEnv.DB, { ...input, tokenHash }, now);
    expect(session).toEqual({ id: input.id, user_id: userId, expires_at: input.expiresAt, created_at: now });
    const stored = await prepare(testEnv.DB, 'SELECT * FROM sessions WHERE id = ?', [input.id]).first();
    expect(stored).toEqual({ ...session, token_hash: tokenHash, revoked_at: null });
    expect(JSON.stringify(stored)).not.toContain(raw);
    expect(session).not.toHaveProperty('token_hash');
  });

  it('loads without writing or extending lifetime and rejects the exact expiry boundary', async () => {
    const session = await createSession(testEnv.DB, input, now);
    expect(await findActiveSessionByHash(testEnv.DB, hash, now)).toEqual(session);
    expect(await findActiveSessionByHash(testEnv.DB, hash, input.expiresAt - 1)).toEqual(session);
    expect(await findActiveSessionByHash(testEnv.DB, hash, input.expiresAt)).toBeNull();
    expect(await findActiveSessionByHash(testEnv.DB, hash, input.expiresAt + 1)).toBeNull();
    expect(await findActiveSessionByHash(testEnv.DB, hash, now - 1)).toBeNull();
    expect(await prepare(testEnv.DB, 'SELECT created_at, expires_at FROM sessions WHERE id = ?', [input.id]).first())
      .toEqual({ created_at: now, expires_at: input.expiresAt });
  });

  it('returns null for an unknown hash', async () => {
    expect(await findActiveSessionByHash(testEnv.DB, hash, now)).toBeNull();
  });

  it('rejects duplicate hashes and IDs without overwriting the original', async () => {
    await createSession(testEnv.DB, input, now);
    await expect(createSession(testEnv.DB, { ...input, id: 'duplicate-hash' }, now)).rejects.toThrow();
    await expect(createSession(testEnv.DB, { ...input, tokenHash: 'b'.repeat(64) }, now)).rejects.toThrow();
    expect((await prepare(testEnv.DB, 'SELECT COUNT(*) AS count FROM sessions').first())?.count).toBe(1);
  });

  it('explicitly fails zero-row creation when the user was disabled after password verification', async () => {
    await prepare(testEnv.DB, 'UPDATE users SET status = ? WHERE id = ?', ['disabled', userId]).run();
    await expect(createSession(testEnv.DB, input, now)).rejects.toThrow(SessionCreationError);
    expect((await prepare(testEnv.DB, 'SELECT COUNT(*) AS count FROM sessions').first())?.count).toBe(0);
  });

  it('does not create sessions for a nonexistent referenced user', async () => {
    await expect(createSession(testEnv.DB, { ...input, userId: 'missing' }, now)).rejects.toThrow(SessionCreationError);
  });

  it('stops loading an existing session when the user is disabled', async () => {
    await createSession(testEnv.DB, input, now);
    await prepare(testEnv.DB, 'UPDATE users SET status = ? WHERE id = ?', ['disabled', userId]).run();
    expect(await findActiveSessionByHash(testEnv.DB, hash, now)).toBeNull();
  });

  it('revokes only the current user session and preserves the original revocation time', async () => {
    await createSession(testEnv.DB, input, now);
    expect(await revokeSession(testEnv.DB, input.id, 'different-user', now + 1)).toBe(false);
    expect(await findActiveSessionByHash(testEnv.DB, hash, now + 1)).not.toBeNull();
    expect(await revokeSession(testEnv.DB, input.id, userId, now + 2)).toBe(true);
    expect(await findActiveSessionByHash(testEnv.DB, hash, now + 2)).toBeNull();
    expect(await revokeSession(testEnv.DB, input.id, userId, now + 3)).toBe(false);
    expect((await prepare(testEnv.DB, 'SELECT revoked_at FROM sessions WHERE id = ?', [input.id]).first())?.revoked_at).toBe(now + 2);
    expect(await revokeSession(testEnv.DB, 'missing', userId, now)).toBe(false);
  });

  it('revokes all sessions for one user without affecting another and is idempotent', async () => {
    await createSession(testEnv.DB, input, now);
    await createSession(testEnv.DB, { ...input, id: 'second', tokenHash: 'b'.repeat(64) }, now);
    await seedUser('a02-other');
    await createSession(testEnv.DB, { ...input, id: 'other', userId: 'a02-other', tokenHash: 'c'.repeat(64) }, now);
    expect(await revokeUserSessions(testEnv.DB, userId, now + 1)).toBe(2);
    expect(await revokeUserSessions(testEnv.DB, userId, now + 2)).toBe(0);
    expect(await findActiveSessionByHash(testEnv.DB, hash, now + 2)).toBeNull();
    expect(await findActiveSessionByHash(testEnv.DB, 'b'.repeat(64), now + 2)).toBeNull();
    expect(await findActiveSessionByHash(testEnv.DB, 'c'.repeat(64), now + 2)).not.toBeNull();
  });

  it('binds identifiers containing SQL metacharacters', async () => {
    const id = "a02-'quoted";
    await createSession(testEnv.DB, { ...input, id }, now);
    expect(await revokeSession(testEnv.DB, "' OR 1=1 --", userId, now)).toBe(false);
    expect(await revokeUserSessions(testEnv.DB, "' OR 1=1 --", now)).toBe(0);
    expect(await revokeSession(testEnv.DB, id, userId, now)).toBe(true);
  });

  it.each(['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), 's2a_session_raw-token'])
    ('rejects invalid hashes rather than storing a raw token %#', async (tokenHash) => {
      await expect(createSession(testEnv.DB, { ...input, tokenHash }, now)).rejects.toThrow(TypeError);
      await expect(findActiveSessionByHash(testEnv.DB, tokenHash, now)).rejects.toThrow(TypeError);
    });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid timestamp %s', async (time) => {
    await expect(createSession(testEnv.DB, input, time)).rejects.toThrow(TypeError);
    await expect(findActiveSessionByHash(testEnv.DB, hash, time)).rejects.toThrow(TypeError);
    await expect(revokeSession(testEnv.DB, input.id, userId, time)).rejects.toThrow(TypeError);
    await expect(revokeUserSessions(testEnv.DB, userId, time)).rejects.toThrow(TypeError);
  });

  it.each([now - 1, now])('rejects a session already expired at creation: %s', async (expiresAt) => {
    await expect(createSession(testEnv.DB, { ...input, expiresAt }, now)).rejects.toThrow(TypeError);
  });
});
