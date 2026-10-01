import { beforeEach, describe, expect, it } from 'vitest';
import { generateToken, hashToken } from '../../apps/worker/auth/tokens';
import { prepare } from '../../apps/worker/db';
import type { DbValue } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const now = 1_788_620_000_123;
const userId = 'd03-test-user';
const hash = 'a1'.repeat(32);
const base = { id: 'd03-test-session', token_hash: hash, user_id: userId, expires_at: now + 60_000, created_at: now };

async function insertSession(overrides: Record<string, DbValue> = {}) {
  const row = { ...base, ...overrides };
  const columns = Object.keys(row);
  return prepare(testEnv.DB,
    `INSERT INTO sessions (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) RETURNING *`,
    Object.values(row)).run();
}

beforeEach(async () => {
  await prepare(testEnv.DB,
    'INSERT INTO groups (id, name, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['d03-test-group', 'D03 Test Group', 'active', 1, now, now]).run();
  await prepare(testEnv.DB,
    `INSERT INTO users (id, email_normalized, password_hash, role, status, group_id,
      concurrency_limit, rpm_limit, created_via, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, 'd03-user@example.invalid', 'test-only-hash-not-for-authentication', 'user', 'active', 'd03-test-group', 2, 60, 'registration', now, now]).run();
});

describe('0003 sessions migration on native D1', () => {
  it('accepts the actual F13 digest while retaining no plaintext token', async () => {
    const token = generateToken('session');
    const token_hash = await hashToken('session', token);
    expect(token_hash).toMatch(/^[0-9a-f]{64}$/);
    const saved = await insertSession({ token_hash });
    expect(saved.rows).toEqual([{ ...base, token_hash, revoked_at: null }]);
    expect(JSON.stringify(saved.rows)).not.toContain(token);
    const columns = (await prepare<{ name: string }>(testEnv.DB, "PRAGMA table_info('sessions')").all()).rows.map((column) => column.name);
    expect(columns).toEqual(['id', 'token_hash', 'user_id', 'expires_at', 'revoked_at', 'created_at']);
    await expect(insertSession({ id: 'plaintext-attempt', token_hash: token })).rejects.toThrow();
  });

  it('enforces unique IDs and token digests', async () => {
    await insertSession();
    await expect(insertSession({ id: 'another-session' })).rejects.toThrow();
    await expect(insertSession({ token_hash: 'b2'.repeat(32) })).rejects.toThrow();
  });

  it.each(['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), ' '.repeat(64), null])('rejects malformed digest %s', async (token_hash) => {
    await expect(insertSession({ token_hash })).rejects.toThrow();
  });

  it('requires a nonempty ID and an existing user, preserving referenced users', async () => {
    await expect(insertSession({ id: null })).rejects.toThrow();
    await expect(insertSession({ id: ' ' })).rejects.toThrow();
    await expect(insertSession({ user_id: null })).rejects.toThrow();
    await expect(insertSession({ user_id: 'd03-unknown-user' })).rejects.toThrow();
    await insertSession();
    await expect(prepare(testEnv.DB, 'DELETE FROM users WHERE id = ?', [userId]).run()).rejects.toThrow();
    expect(await prepare(testEnv.DB, 'SELECT id FROM users WHERE id = ?', [userId]).first()).toEqual({ id: userId });
  });

  it('requires safe integer times and a strictly later expiry', async () => {
    for (const column of ['created_at', 'expires_at', 'revoked_at']) {
      for (const value of [-1, 0.5, 9007199254740992, 'invalid']) {
        await expect(insertSession({ [column]: value })).rejects.toThrow();
      }
    }
    await expect(insertSession({ expires_at: null })).rejects.toThrow();
    await expect(insertSession({ created_at: null })).rejects.toThrow();
    await expect(insertSession({ expires_at: now })).rejects.toThrow();
    await expect(insertSession({ expires_at: now - 1 })).rejects.toThrow();
    const edge = await insertSession({ created_at: 9007199254740990, expires_at: 9007199254740991 });
    expect(edge.rows[0]).toMatchObject({ created_at: 9007199254740990, expires_at: 9007199254740991 });
  });

  it('queries only live unrevoked sessions and records explicit revocation', async () => {
    await insertSession();
    await insertSession({ id: 'd03-expired', token_hash: 'b'.repeat(64), created_at: now - 2, expires_at: now - 1 });
    await insertSession({ id: 'd03-revoked', token_hash: 'c'.repeat(64), revoked_at: now });
    const live = () => prepare<{ id: string }>(testEnv.DB,
      'SELECT id FROM sessions WHERE user_id = ? AND expires_at > ? AND revoked_at IS NULL ORDER BY expires_at', [userId, now]).all();
    expect((await live()).rows).toEqual([{ id: base.id }]);
    const revoked = await prepare<{ revoked_at: number }>(testEnv.DB,
      'UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL RETURNING revoked_at', [now + 1, base.id]).run();
    expect(revoked.changes).toBe(1);
    expect(revoked.rows).toEqual([{ revoked_at: now + 1 }]);
    expect((await live()).rows).toEqual([]);
  });

  it('rejects expiry or digest corruption on UPDATE', async () => {
    await insertSession();
    await expect(prepare(testEnv.DB, 'UPDATE sessions SET expires_at = created_at WHERE id = ?', [base.id]).run()).rejects.toThrow();
    await expect(prepare(testEnv.DB, 'UPDATE sessions SET token_hash = ? WHERE id = ?', ['not-a-hash', base.id]).run()).rejects.toThrow();
  });

  it('indexes user expiry, global expiry, revocation and unique token lookup', async () => {
    for (const [index, expected] of [
      ['idx_sessions_user_expires', ['user_id', 'expires_at']],
      ['idx_sessions_expires', ['expires_at']],
      ['idx_sessions_revoked', ['revoked_at']],
    ] as const) {
      const columns = await prepare<{ name: string }>(testEnv.DB, `PRAGMA index_info('${index}')`).all();
      expect(columns.rows.map((column) => column.name)).toEqual(expected);
    }
    const indexes = await prepare(testEnv.DB, "PRAGMA index_list('sessions')").all();
    expect(indexes.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'idx_sessions_revoked', partial: 1 }),
      expect.objectContaining({ origin: 'pk', unique: 1 }),
      expect.objectContaining({ origin: 'u', unique: 1 }),
    ]));
  });
});
