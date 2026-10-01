import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_LIMITS, buildAuditStatement, redactAuditChanges } from '../../apps/worker/admin/audit';
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

describe('safe structured audit projection', () => {
  it('removes secret fields recursively through snapshots and arrays', () => {
    const secret = 'DO-NOT-PERSIST';
    const cleaned = redactAuditChanges({
      password: secret, raw_key: secret, code: secret, secret: secret, authorization: secret,
      ciphertext: secret, headers: { authorization: secret }, request: { headers: secret },
      before: { status: 'active', password_hash: secret, config_version: 1 },
      after: { status: 'disabled', secret_ciphertext: secret, credential_changed: true },
      changes: [{ rpm_limit: 5, code_mac: secret }, { priority: 2, api_key: secret }],
    });
    expect(cleaned).toEqual({ before: { status: 'active', config_version: 1 },
      after: { status: 'disabled', credential_changed: true }, changes: [{ rpm_limit: 5 }, { priority: 2 }] });
    expect(JSON.stringify(cleaned)).not.toContain(secret);
  });

  it('keeps reviewed typed diffs/model lists and drops free text or credential-shaped identifiers', () => {
    expect(redactAuditChanges({
      status: { before: 'active', after: 'disabled', secret: 'hidden' },
      allowed_models_json: ['model-a', 's2a_key_secret', 'sk-secret'],
      name: 'secret pasted as a name', base_url: 'https://user:secret@example.invalid',
      group_id: 's2a_session_secret', rpm_limit: 'secret', password_changed: true,
    })).toEqual({ status: { before: 'active', after: 'disabled' }, allowed_models_json: ['model-a'], password_changed: true });
  });

  it('never invokes accessors, toJSON or class serialization', () => {
    const getter = vi.fn(() => { throw new Error('SECRET'); });
    const toJSON = vi.fn(() => ({ password: 'SECRET' }));
    const input = { status: 'active', toJSON };
    Object.defineProperty(input, 'before', { enumerable: true, get: getter });
    Object.defineProperty(input, 'password', { enumerable: true, get: getter });
    expect(redactAuditChanges(input)).toEqual({ status: 'active' });
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    expect(redactAuditChanges(new Error('SECRET'))).toEqual({});
    expect(redactAuditChanges(new Headers({ authorization: 'SECRET' }))).toEqual({});
    class Unknown { status = 'active'; password = 'SECRET'; }
    expect(redactAuditChanges({ before: new Unknown() })).toEqual({});
    const array = [{ status: 'active' }];
    Object.defineProperty(array, '0', { get: getter });
    expect(redactAuditChanges({ changes: array })).toEqual({ changes: [] });
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects depth, array and string limits with safe errors', () => {
    let nested: unknown = { status: 'active' };
    for (let i = 0; i <= AUDIT_LIMITS.depth; i++) nested = { before: nested };
    expect(() => redactAuditChanges(nested)).toThrow('Request body too large.');
    expect(() => redactAuditChanges({ changes: Array(AUDIT_LIMITS.array + 1).fill({}) })).toThrow('Request body too large.');
    expect(() => redactAuditChanges({ group_id: 'a'.repeat(AUDIT_LIMITS.string + 1) })).toThrow('Request body too large.');
    const cyclic: Record<string, unknown> = {}; cyclic.before = cyclic;
    expect(() => redactAuditChanges(cyclic)).toThrow('Invalid request.');
    const proxy = new Proxy({}, { getPrototypeOf() { throw new Error('SECRET'); } });
    expect(() => redactAuditChanges(proxy)).toThrow('Invalid request.');
  });

  it('caps visited nodes and total serialized bytes even within individual field limits', () => {
    expect(() => redactAuditChanges({ changes: Array(9).fill({ allowed_models: Array(28).fill('model') }) }))
      .toThrow('Request body too large.');
    expect(() => redactAuditChanges({ changes: Array(4).fill({ allowed_models: Array(24).fill('a'.repeat(128)) }) }))
      .toThrow('Request body too large.');
  });
});

describe('audit statements in native D1 batches', () => {
  const disable = () => prepare(testEnv.DB, 'UPDATE groups SET status = ? WHERE id = ?', ['disabled', 'o01-group']);

  it('builds without writing and commits business state and redacted audit in one batch', async () => {
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

  it('rejects malformed event metadata and does not evaluate metadata getters', () => {
    for (const patch of [{ actor_id: '' }, { action: 'Bad action' }, { target_type: '' }, { target_id: 's2a_key_secret' },
      { operation_id: '' }, { created_at: -1 }, { created_at: 0.5 }, { created_at: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect(() => buildAuditStatement(testEnv.DB, { ...event, ...patch })).toThrow('Invalid request.');
    }
    const getter = vi.fn(() => 'secret');
    const unsafe = { ...event };
    Object.defineProperty(unsafe, 'actor_id', { get: getter });
    expect(() => buildAuditStatement(testEnv.DB, unsafe)).toThrow('Invalid request.');
    expect(getter).not.toHaveBeenCalled();
    expect(() => buildAuditStatement(testEnv.DB, { ...event, id: null } as unknown as AuditEvent)).toThrow('Invalid request.');
  });
});
