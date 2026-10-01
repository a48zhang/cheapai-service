import { beforeEach, describe, expect, it } from 'vitest';
import { prepare } from '../../apps/worker/db';
import type { DbValue } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const now = 1_788_629_000_123;
const actor = 'a11d-admin';
const otherActor = 'a11d-other-admin';
const base = { id: 'a11d-batch', actor_id: actor, operation_id: 'a11d-operation',
  fingerprint: 'a1'.repeat(32), quantity: 2, expires_at: now + 60_000, created_at: now };

function insertBatch(overrides: Record<string, DbValue> = {}) {
  const row = { ...base, ...overrides };
  const columns = Object.keys(row);
  return prepare(testEnv.DB,
    `INSERT INTO registration_code_batches (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')}) RETURNING *`, Object.values(row)).run();
}

beforeEach(async () => {
  await prepare(testEnv.DB, 'INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES (?,?,?,1,?,?)',
    ['a11d-group', 'A11-D Group', 'active', now, now]).run();
  for (const id of [actor, otherActor]) {
    await prepare(testEnv.DB, `INSERT INTO users (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES (?,?,?,'admin','active',?,2,60,'bootstrap',?,?)`, [id, `${id}@example.invalid`, 'test-only-hash', 'a11d-group', now, now]).run();
  }
});

describe('0015 registration code batch claims on native D1', () => {
  it('stores only the batch identity, request fingerprint and generation metadata', async () => {
    expect((await insertBatch()).rows).toEqual([base]);
    const columns = (await prepare<{ name: string }>(testEnv.DB, "PRAGMA table_info('registration_code_batches')").all()).rows.map((column) => column.name);
    expect(columns).toEqual(['id', 'actor_id', 'operation_id', 'fingerprint', 'quantity', 'expires_at', 'created_at']);
  });

  it('enforces unique IDs and actor-scoped operation keys', async () => {
    await insertBatch();
    await expect(insertBatch({ id: 'a11d-another-id' })).rejects.toThrow();
    await expect(insertBatch({ operation_id: 'a11d-another-operation' })).rejects.toThrow();
    expect((await insertBatch({ id: 'a11d-other-actor', actor_id: otherActor })).changes).toBe(1);
    expect((await insertBatch({ id: 'a11d-other-operation', operation_id: 'a11d-other-operation' })).changes).toBe(1);
  });

  it('permits only one concurrent claim for the same actor and operation', async () => {
    const results = await Promise.allSettled([insertBatch(), insertBatch({ id: 'a11d-racer' })]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await prepare(testEnv.DB, 'SELECT id FROM registration_code_batches WHERE actor_id=? AND operation_id=?',
      [actor, base.operation_id]).all()).rows).toHaveLength(1);
  });

  it('requires existing actors and prevents deleting referenced users', async () => {
    await expect(insertBatch({ actor_id: 'a11d-missing' })).rejects.toThrow();
    await expect(insertBatch({ actor_id: null })).rejects.toThrow();
    await insertBatch();
    await expect(prepare(testEnv.DB, 'DELETE FROM users WHERE id=?', [actor]).run()).rejects.toThrow();
  });

  it('requires nonempty IDs and a lowercase 64-hex fingerprint', async () => {
    for (const field of ['id', 'operation_id']) {
      for (const value of ['', ' ', null]) await expect(insertBatch({ [field]: value })).rejects.toThrow();
    }
    for (const fingerprint of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'z'.repeat(64), null]) {
      await expect(insertBatch({ fingerprint })).rejects.toThrow();
    }
  });

  it('limits batch quantity to integer values from one to one hundred', async () => {
    for (const quantity of [0, -1, 1.5, 101, 'invalid', null]) await expect(insertBatch({ quantity })).rejects.toThrow();
    expect((await insertBatch({ quantity: 1 })).changes).toBe(1);
    expect((await insertBatch({ id: 'a11d-largest', operation_id: 'a11d-largest-op', quantity: 100 })).changes).toBe(1);
  });

  it('requires safe integer times and an optional expiry strictly after creation', async () => {
    for (const field of ['created_at', 'expires_at']) {
      for (const value of [-1, 0.5, 9007199254740992, 'invalid']) await expect(insertBatch({ [field]: value })).rejects.toThrow();
    }
    await expect(insertBatch({ created_at: null })).rejects.toThrow();
    await expect(insertBatch({ expires_at: now })).rejects.toThrow();
    await expect(insertBatch({ expires_at: now - 1 })).rejects.toThrow();
    expect((await insertBatch({ expires_at: null })).rows[0]).toMatchObject({ expires_at: null });
    expect((await insertBatch({ id: 'a11d-time-edge', operation_id: 'a11d-time-edge-op',
      created_at: 9007199254740990, expires_at: 9007199254740991 })).changes).toBe(1);
  });

  it('provides the actor-operation unique index that serializes concurrent issuance', async () => {
    const indexes = (await prepare<{ name: string; unique: number }>(testEnv.DB, "PRAGMA index_list('registration_code_batches')").all()).rows.filter((row) => row.unique === 1);
    const columns = await Promise.all(indexes.map(async ({ name }) =>
      (await prepare<{ name: string }>(testEnv.DB, `PRAGMA index_info('${name}')`).all()).rows.map((row) => row.name)));
    expect(columns).toEqual(expect.arrayContaining([['id'], ['actor_id', 'operation_id']]));
  });
});
