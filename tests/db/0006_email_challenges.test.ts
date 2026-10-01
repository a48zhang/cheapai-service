import { describe, expect, it } from 'vitest';
import { prepare } from '../../apps/worker/db';
import type { DbValue } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const now = 1_788_623_000_123;
const base = { id: 'd06-test-challenge', email_normalized: 'd06-email@example.invalid', purpose: 'registration',
  code_mac: 'a1'.repeat(32), expires_at: now + 600_000, created_at: now, updated_at: now, send_requested_at: now };

async function insertChallenge(overrides: Record<string, DbValue> = {}) {
  const row = { ...base, ...overrides };
  const columns = Object.keys(row);
  return prepare(testEnv.DB,
    `INSERT INTO email_challenges (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) RETURNING *`, Object.values(row)).run();
}

describe('0006 email challenges migration on native D1', () => {
  it('defaults the initial generation, attempts, sending state and unconsumed marker', async () => {
    const saved = await insertChallenge();
    expect(saved.rows).toEqual([{ ...base, generation: 1, attempts: 0, send_status: 'sending', consumed_at: null }]);
    const columns = (await prepare<{ name: string }>(testEnv.DB, "PRAGMA table_info('email_challenges')").all()).rows.map((row) => row.name);
    expect(columns).not.toContain('code');
    expect(columns).not.toContain('plaintext_code');
    await expect(insertChallenge({ id: 'd06-plaintext', email_normalized: 'other@example.invalid', code_mac: '123456' })).rejects.toThrow();
  });

  it('reserves a unique email/purpose slot and unique ID without relying on an empty database', async () => {
    await insertChallenge();
    await expect(insertChallenge({ id: 'd06-other' })).rejects.toThrow();
    await expect(insertChallenge({ email_normalized: 'd06-other@example.invalid' })).rejects.toThrow();
    await prepare(testEnv.DB, 'UPDATE email_challenges SET consumed_at = ? WHERE id = ?', [now + 1, base.id]).run();
    // Consumed state does not permit a second row that could restart generation.
    await expect(insertChallenge({ id: 'd06-new-slot' })).rejects.toThrow();
    expect((await insertChallenge({ id: 'd06-distinct', email_normalized: 'd06-distinct@example.invalid' })).changes).toBe(1);
  });

  it('rejects unnormalized email, other purposes and empty identifiers', async () => {
    for (const email_normalized of ['', ' ', 'UPPER@example.invalid', ' d06@example.invalid', 'd06@example.invalid ', null]) {
      await expect(insertChallenge({ email_normalized })).rejects.toThrow();
    }
    for (const purpose of ['login', 'password_reset', '', null]) await expect(insertChallenge({ purpose })).rejects.toThrow();
    for (const id of ['', ' ', null]) await expect(insertChallenge({ id })).rejects.toThrow();
  });

  it('validates lowercase 64-hex MACs without storing six-digit email codes', async () => {
    for (const code_mac of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'z'.repeat(64), null]) {
      await expect(insertChallenge({ code_mac })).rejects.toThrow();
    }
  });

  it('requires positive integer generation and nonnegative integer attempts', async () => {
    for (const value of [-1, 0.5, 9007199254740992, 'invalid', null]) {
      await expect(insertChallenge({ generation: value })).rejects.toThrow();
      await expect(insertChallenge({ attempts: value })).rejects.toThrow();
    }
    await expect(insertChallenge({ generation: 0 })).rejects.toThrow();
    expect((await insertChallenge({ generation: 9007199254740991, attempts: 9007199254740991 })).changes).toBe(1);
  });

  it('accepts only sending/accepted/failed/unknown delivery states', async () => {
    for (const send_status of ['sent', 'delivered', '', null]) await expect(insertChallenge({ send_status })).rejects.toThrow();
    await insertChallenge();
    for (const state of ['sending', 'accepted', 'failed', 'unknown']) {
      expect((await prepare(testEnv.DB, 'UPDATE email_challenges SET send_status = ? WHERE id = ?', [state, base.id]).run()).changes).toBe(1);
    }
  });

  it('validates safe integer times and expiry after creation', async () => {
    for (const field of ['created_at', 'updated_at', 'expires_at', 'send_requested_at', 'consumed_at']) {
      for (const value of [-1, 0.5, 9007199254740992, 'invalid']) await expect(insertChallenge({ [field]: value })).rejects.toThrow();
    }
    for (const field of ['created_at', 'updated_at', 'expires_at', 'send_requested_at']) await expect(insertChallenge({ [field]: null })).rejects.toThrow();
    await expect(insertChallenge({ expires_at: now })).rejects.toThrow();
    await expect(insertChallenge({ expires_at: now - 1 })).rejects.toThrow();
    expect((await insertChallenge({ consumed_at: now + 1 })).rows[0]).toMatchObject({ consumed_at: now + 1 });
  });

  it('supports generation-conditioned resends and prevents an old callback from changing the new state', async () => {
    await insertChallenge({ attempts: 2, send_status: 'failed' });
    const resendAt = now + 60_000;
    const resent = await prepare(testEnv.DB,
      `UPDATE email_challenges SET generation = generation + 1, code_mac = ?, attempts = 0,
       send_status = 'sending', consumed_at = NULL, send_requested_at = ?, updated_at = ?, expires_at = ?
       WHERE id = ? AND generation = ? RETURNING generation, send_requested_at, attempts`,
      ['b2'.repeat(32), resendAt, resendAt, resendAt + 600_000, base.id, 1]).run();
    expect(resent.rows).toEqual([{ generation: 2, send_requested_at: resendAt, attempts: 0 }]);
    expect((await prepare(testEnv.DB,
      'UPDATE email_challenges SET send_status = ? WHERE id = ? AND generation = ?', ['accepted', base.id, 1]).run()).changes).toBe(0);
    expect(await prepare(testEnv.DB, 'SELECT send_status FROM email_challenges WHERE id = ?', [base.id]).first()).toEqual({ send_status: 'sending' });
    expect((await prepare(testEnv.DB,
      'UPDATE email_challenges SET send_status = ? WHERE id = ? AND generation = ?', ['accepted', base.id, 2]).run()).changes).toBe(1);
  });

  it('allows independent failed-attempt updates and conditional one-time consumption', async () => {
    await insertChallenge({ send_status: 'accepted' });
    await prepare(testEnv.DB, 'UPDATE email_challenges SET attempts = attempts + 1 WHERE id = ? AND generation = ?', [base.id, 1]).run();
    const consume = () => prepare(testEnv.DB,
      `UPDATE email_challenges SET consumed_at = ?, updated_at = ? WHERE id = ? AND generation = ?
       AND code_mac = ? AND send_status = 'accepted' AND consumed_at IS NULL AND expires_at > ? RETURNING attempts, consumed_at`,
      [now + 1, now + 1, base.id, 1, base.code_mac, now + 1]).run();
    expect((await consume()).rows).toEqual([{ attempts: 1, consumed_at: now + 1 }]);
    expect((await consume()).changes).toBe(0);
    expect(await prepare(testEnv.DB, 'SELECT attempts, send_requested_at FROM email_challenges WHERE id = ?', [base.id]).first())
      .toEqual({ attempts: 1, send_requested_at: now });
  });

  it('indexes expiry and the unique email/purpose lookup without table dependencies', async () => {
    expect((await prepare<{ name: string }>(testEnv.DB, "PRAGMA index_info('idx_email_challenges_expires')").all()).rows.map((row) => row.name)).toEqual(['expires_at']);
    const uniqueIndexes = (await prepare<{ name: string; unique: number }>(testEnv.DB, "PRAGMA index_list('email_challenges')").all()).rows.filter((row) => row.unique === 1);
    const columns = await Promise.all(uniqueIndexes.map(async ({ name }) =>
      (await prepare<{ name: string }>(testEnv.DB, `PRAGMA index_info('${name}')`).all()).rows.map((row) => row.name)));
    expect(columns).toEqual(expect.arrayContaining([['id'], ['email_normalized', 'purpose']]));
    expect((await prepare(testEnv.DB, "PRAGMA foreign_key_list('email_challenges')").all()).rows).toEqual([]);
  });
});
