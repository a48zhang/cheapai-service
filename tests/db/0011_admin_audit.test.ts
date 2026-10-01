import { beforeEach, describe, expect, it } from 'vitest';
import { prepare } from '../../apps/worker/db';
import type { DbValue } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const now = 1_788_624_000_123;
const actorId = 'd11-test-admin';
const base = { id: 'd11-test-audit', actor_id: actorId, action: 'channel.update', target_type: 'channel',
  target_id: 'd11-target-channel', redacted_change_json: '{"status":{"before":"active","after":"disabled"},"credential_changed":true}',
  operation_id: 'd11-test-operation', created_at: now };

async function insertAudit(overrides: Record<string, DbValue> = {}) {
  const row = { ...base, ...overrides };
  const columns = Object.keys(row);
  return prepare(testEnv.DB,
    `INSERT INTO admin_audit (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) RETURNING *`, Object.values(row)).run();
}

beforeEach(async () => {
  await prepare(testEnv.DB,
    'INSERT INTO groups (id, name, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['d11-test-group', 'D11 Test Group', 'active', 1, now, now]).run();
  await prepare(testEnv.DB,
    `INSERT INTO users (id, email_normalized, password_hash, role, status, group_id,
      concurrency_limit, rpm_limit, created_via, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [actorId, 'd11-admin@example.invalid', 'test-only-hash-not-for-authentication', 'admin', 'active', 'd11-test-group', 2, 60, 'bootstrap', now, now]).run();
});

describe('0011 admin audit migration on native D1', () => {
  it('round-trips application-redacted object metadata and explicit event identity', async () => {
    expect((await insertAudit()).rows).toEqual([base]);
    const stored = await prepare<{ redacted_change_json: string }>(testEnv.DB,
      'SELECT redacted_change_json FROM admin_audit WHERE id = ?', [base.id]).first();
    expect(JSON.parse(stored!.redacted_change_json)).toEqual({ status: { before: 'active', after: 'disabled' }, credential_changed: true });
  });

  it('allows one operation to record multiple targets without claiming global idempotency', async () => {
    await insertAudit();
    await insertAudit({ id: 'd11-second-event', target_id: 'd11-other-channel', created_at: now + 1 });
    expect((await prepare(testEnv.DB,
      'SELECT id, target_id FROM admin_audit WHERE operation_id = ? ORDER BY created_at, id', [base.operation_id]).all()).rows)
      .toEqual([{ id: base.id, target_id: base.target_id }, { id: 'd11-second-event', target_id: 'd11-other-channel' }]);
    // Event IDs remain unique even though operation IDs intentionally are not.
    await expect(insertAudit({ operation_id: 'd11-other-operation' })).rejects.toThrow();
  });

  it.each(['', '{invalid}', '[]', 'null', 'true', '42', '"text"', null])('rejects non-object or malformed change JSON %s', async (redacted_change_json) => {
    await expect(insertAudit({ redacted_change_json })).rejects.toThrow();
  });

  it.each(['{}', '{"count":2}', '{"nested":{"items":["redacted"]}}'])('accepts valid object shape %s without guessing a field schema', async (redacted_change_json) => {
    expect((await insertAudit({ redacted_change_json })).rows[0]).toMatchObject({ redacted_change_json });
  });

  it('requires nonempty event, action, target and operation identifiers', async () => {
    for (const field of ['id', 'action', 'target_type', 'target_id', 'operation_id']) {
      for (const value of ['', ' ', null]) await expect(insertAudit({ [field]: value })).rejects.toThrow();
    }
  });

  it('requires an existing actor and restricts deletion of referenced actors', async () => {
    for (const actor_id of ['d11-missing-user', '', null]) await expect(insertAudit({ actor_id })).rejects.toThrow();
    await insertAudit();
    await expect(prepare(testEnv.DB, 'DELETE FROM users WHERE id = ?', [actorId]).run()).rejects.toThrow();
    expect(await prepare(testEnv.DB, 'SELECT id FROM users WHERE id = ?', [actorId]).first()).toEqual({ id: actorId });
  });

  it('requires nonnegative safe integer millisecond event time', async () => {
    for (const created_at of [-1, 0.5, 9007199254740992, 'invalid', null]) await expect(insertAudit({ created_at })).rejects.toThrow();
    expect((await insertAudit({ created_at: 9007199254740991 })).rows[0]).toMatchObject({ created_at: 9007199254740991 });
  });

  it('enforces JSON and actor constraints when records are updated', async () => {
    await insertAudit();
    await expect(prepare(testEnv.DB, 'UPDATE admin_audit SET redacted_change_json = ? WHERE id = ?', ['[]', base.id]).run()).rejects.toThrow();
    await expect(prepare(testEnv.DB, 'UPDATE admin_audit SET actor_id = ? WHERE id = ?', ['d11-missing', base.id]).run()).rejects.toThrow();
  });

  it('indexes actor chronology, target chronology and nonunique operation lookup', async () => {
    for (const [index, columns] of [
      ['idx_admin_audit_actor_created', ['actor_id', 'created_at', 'id']],
      ['idx_admin_audit_target_created', ['target_type', 'target_id', 'created_at']],
      ['idx_admin_audit_operation', ['operation_id']],
    ] as const) {
      expect((await prepare<{ name: string }>(testEnv.DB, `PRAGMA index_info('${index}')`).all()).rows.map((row) => row.name)).toEqual(columns);
    }
    const indexes = (await prepare<{ name: string; unique: number }>(testEnv.DB, "PRAGMA index_list('admin_audit')").all()).rows;
    expect(indexes).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'idx_admin_audit_operation', unique: 0 })]));
    expect(indexes.filter((row) => row.unique === 1)).toHaveLength(1);
  });
});
