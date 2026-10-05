import { beforeEach, describe, expect, it } from 'vitest';
import { buildAuditStatement } from '../../apps/worker/admin/audit';
import type { AuditEvent } from '../../apps/worker/admin/audit';
import { batch, prepare } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const now = 1_788_625_000_123;
const actor = 'o01-admin';
const event: AuditEvent = { id: 'o01-audit', actor_id: actor, action: 'group.update', target_type: 'group',
  target_id: 'o01-group', operation_id: 'o01-operation', created_at: now, changes: { status: { before: 'active', after: 'disabled' } } };

beforeEach(async () => {
  await prepare(testEnv.DB, 'INSERT INTO groups (id, name, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['o01-group', 'O01 Test Group', 'active', 1, now, now]).run();
  await prepare(testEnv.DB,
    `INSERT INTO users (id, email_normalized, password_hash, role, status, group_id,
    concurrency_limit, rpm_limit, created_via, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [actor, 'o01-admin@example.invalid', 'test-only-hash', 'admin', 'active', 'o01-group', 2, 60, 'bootstrap', now, now]).run();
});

describe('audit statements in native D1 batches', () => {
  const disable = () => prepare(testEnv.DB, 'UPDATE groups SET status = ? WHERE id = ?', ['disabled', 'o01-group']);

  it('builds without writing and commits business state and audit in one batch', async () => {
    const audit = buildAuditStatement(testEnv.DB, event);
    expect(await prepare(testEnv.DB, 'SELECT id FROM admin_audit WHERE id = ?', [event.id!]).first()).toBeNull();
    const [, saved] = await batch(testEnv.DB, [disable(), audit]);
    expect(saved.rows).toEqual([{ id: event.id }]);
    expect(await prepare(testEnv.DB, 'SELECT status FROM groups WHERE id = ?', ['o01-group']).first()).toEqual({ status: 'disabled' });
    const row = await prepare<{ redacted_change_json: string }>(testEnv.DB,
      'SELECT redacted_change_json FROM admin_audit WHERE id = ?', [event.id!]).first();
    expect(JSON.parse(row!.redacted_change_json)).toEqual(event.changes);
  });

  it('rolls back the business write when the actor FK makes audit insertion fail', async () => {
    await expect(batch(testEnv.DB, [disable(), buildAuditStatement(testEnv.DB, { ...event, actor_id: 'o01-missing' })])).rejects.toThrow();
    expect(await prepare(testEnv.DB, 'SELECT status FROM groups WHERE id = ?', ['o01-group']).first()).toEqual({ status: 'active' });
    expect(await prepare(testEnv.DB, 'SELECT id FROM admin_audit WHERE id = ?', [event.id!]).first()).toBeNull();
  });

  it('rolls back an audit inserted before a later failed business statement', async () => {
    await expect(batch(testEnv.DB, [buildAuditStatement(testEnv.DB, event),
      prepare(testEnv.DB, 'UPDATE groups SET status = ? WHERE id = ?', ['invalid', 'o01-group'])])).rejects.toThrow();
    expect(await prepare(testEnv.DB, 'SELECT id FROM admin_audit WHERE id = ?', [event.id!]).first()).toBeNull();
  });

  it('persists caller-selected business fields without a central allowlist or array limit', async () => {
    const changes = { billing_multiplier_changed: true, channel_ids: Array.from({ length: 150 }, (_, i) => `channel-${i}`) };
    await buildAuditStatement(testEnv.DB, { ...event, changes }).run();
    const row = await prepare<{ redacted_change_json: string }>(testEnv.DB,
      'SELECT redacted_change_json FROM admin_audit WHERE id=?', [event.id!]).first();
    expect(JSON.parse(row!.redacted_change_json)).toEqual(changes);
  });
});
