import { describe, expect, inject, it } from 'vitest';
import { prepare } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

// Re-execute the actual checked-in SQL, not the helper's already-applied no-op.
// This tests ON CONFLICT behavior in addition to migration-runner idempotency.
async function rerunDefaults() {
  const migration = inject('d1Migrations').find((entry) => entry.name === '0014_defaults.sql');
  if (!migration) throw new Error('Default seed migration was not loaded.');
  await testEnv.DB.batch(migration.queries.map((sql) => testEnv.DB.prepare(sql)));
}

describe('0014 default seeds on native D1', () => {
  it('initializes the default group and closed registration with email verification', async () => {
    const group = await prepare<{ id: string; name: string; status: string; version: number; created_at: number; updated_at: number }>(testEnv.DB,
      'SELECT * FROM groups WHERE id = ?', ['default']).first();
    expect(group).toMatchObject({ id: 'default', name: 'Default', status: 'active', version: 1 });
    expect(Number.isSafeInteger(group?.created_at)).toBe(true);
    expect(group!.created_at).toBeGreaterThan(0);
    expect(group!.created_at % 1000).toBe(0);
    expect(group!.updated_at).toBe(group!.created_at);
    const registration = await prepare<{ value_json: string; version: number; updated_at: number }>(testEnv.DB,
      'SELECT value_json, version, updated_at FROM settings WHERE key = ?', ['registration']).first();
    expect(JSON.parse(registration!.value_json)).toEqual({ registrationMode: 'closed', emailVerificationEnabled: true });
    expect(registration!.version).toBe(1);
    expect(Number.isSafeInteger(registration!.updated_at)).toBe(true);
    const defaultGroup = await prepare<{ value_json: string }>(testEnv.DB,
      'SELECT value_json FROM settings WHERE key = ?', ['default_group_id']).first();
    expect(JSON.parse(defaultGroup!.value_json)).toBe('default');
  });

  it('reruns actual SQL without changing IDs, values, versions or timestamps', async () => {
    const group = await prepare(testEnv.DB, 'SELECT * FROM groups WHERE id = ?', ['default']).first();
    const settings = await prepare(testEnv.DB, 'SELECT * FROM settings WHERE key IN (?, ?) ORDER BY key', ['registration', 'default_group_id']).all();
    await rerunDefaults();
    await rerunDefaults();
    expect(await prepare(testEnv.DB, 'SELECT * FROM groups WHERE id = ?', ['default']).first()).toEqual(group);
    expect((await prepare(testEnv.DB, 'SELECT * FROM settings WHERE key IN (?, ?) ORDER BY key', ['registration', 'default_group_id']).all()).rows).toEqual(settings.rows);
  });

  it('preserves administrator settings and a renamed/disabled default group', async () => {
    const changedAt = 1_788_626_000_123;
    await prepare(testEnv.DB, 'UPDATE groups SET name = ?, status = ?, version = ?, updated_at = ? WHERE id = ?',
      ['Administrator renamed group', 'disabled', 4, changedAt, 'default']).run();
    const registrationJson = JSON.stringify({ registrationMode: 'invite', emailVerificationEnabled: false });
    await prepare(testEnv.DB, 'UPDATE settings SET value_json = ?, version = ?, updated_at = ? WHERE key = ?',
      [registrationJson, 8, changedAt, 'registration']).run();
    await prepare(testEnv.DB, 'INSERT INTO groups (id, name, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['d14-custom-default', 'D14 Custom Default', 'active', 1, changedAt, changedAt]).run();
    await prepare(testEnv.DB, 'UPDATE settings SET value_json = ?, version = ?, updated_at = ? WHERE key = ?',
      ['"d14-custom-default"', 2, changedAt, 'default_group_id']).run();
    await rerunDefaults();
    expect(await prepare(testEnv.DB, 'SELECT name, status, version, updated_at FROM groups WHERE id = ?', ['default']).first())
      .toEqual({ name: 'Administrator renamed group', status: 'disabled', version: 4, updated_at: changedAt });
    expect(await prepare(testEnv.DB, 'SELECT value_json, version, updated_at FROM settings WHERE key = ?', ['registration']).first())
      .toEqual({ value_json: registrationJson, version: 8, updated_at: changedAt });
    expect(await prepare(testEnv.DB, 'SELECT value_json, version, updated_at FROM settings WHERE key = ?', ['default_group_id']).first())
      .toEqual({ value_json: '"d14-custom-default"', version: 2, updated_at: changedAt });
  });

  it('restores a missing setting independently without inserting users or credit', async () => {
    const usersBefore = await prepare(testEnv.DB, 'SELECT id, balance_units FROM users ORDER BY id').all();
    await prepare(testEnv.DB, 'DELETE FROM settings WHERE key = ?', ['registration']).run();
    await prepare(testEnv.DB, 'INSERT INTO settings (key, value_json, version, updated_at) VALUES (?, ?, ?, ?)',
      ['d14-unrelated-setting', '{"enabled":false}', 3, 1_788_626_000_123]).run();
    await rerunDefaults();
    expect((await prepare(testEnv.DB, 'SELECT id, balance_units FROM users ORDER BY id').all()).rows).toEqual(usersBefore.rows);
    const registration = await prepare<{ value_json: string }>(testEnv.DB, 'SELECT value_json FROM settings WHERE key = ?', ['registration']).first();
    expect(JSON.parse(registration!.value_json)).toEqual({ registrationMode: 'closed', emailVerificationEnabled: true });
    expect(await prepare(testEnv.DB, 'SELECT value_json, version FROM settings WHERE key = ?', ['d14-unrelated-setting']).first())
      .toEqual({ value_json: '{"enabled":false}', version: 3 });
  });
});
