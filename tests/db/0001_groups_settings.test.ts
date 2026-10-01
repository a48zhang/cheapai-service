import { describe, expect, it } from 'vitest';
import { prepare } from '../../apps/worker/db';
import type { DbValue } from '../../apps/worker/db';
import { migrateTestDatabase, testEnv } from '../helpers/database';

const now = 1_788_617_000_123;
const insertGroup = (id: DbValue = 'group-1', name: DbValue = 'Group One', status: DbValue = 'active', version: DbValue = 1, createdAt: DbValue = now, updatedAt: DbValue = now) =>
  prepare(testEnv.DB, 'INSERT INTO groups (id, name, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, name, status, version, createdAt, updatedAt]).run();
const insertSetting = (key: DbValue = 'test.registration', json: DbValue = '{"mode":"closed"}', version: DbValue = 1, updatedAt: DbValue = now) =>
  prepare(testEnv.DB, 'INSERT INTO settings (key, value_json, version, updated_at) VALUES (?, ?, ?, ?)',
    [key, json, version, updatedAt]).run();

describe('0001 groups/settings migration on native D1', () => {
  it('is loaded once without creating this test fixture, regardless of later seeds', async () => {
    expect((await prepare(testEnv.DB, 'SELECT * FROM groups WHERE id = ?', ['group-1']).all()).rows).toEqual([]);
    expect((await prepare(testEnv.DB, 'SELECT * FROM settings WHERE key = ?', ['test.registration']).all()).rows).toEqual([]);
    await migrateTestDatabase();
    const migrations = await prepare<{ name: string }>(testEnv.DB,
      'SELECT name FROM d1_migrations WHERE name = ?', ['0001_groups_settings.sql']).all();
    expect(migrations.rows).toEqual([{ name: '0001_groups_settings.sql' }]);
  });

  it('round-trips groups, JSON settings and millisecond integer timestamps', async () => {
    await insertGroup();
    await insertGroup('group-2', 'Group Two', 'disabled', 2);
    await insertSetting();
    expect(await prepare(testEnv.DB, 'SELECT * FROM groups WHERE id = ?', ['group-1']).first()).toEqual({
      id: 'group-1', name: 'Group One', status: 'active', version: 1, created_at: now, updated_at: now,
    });
    expect(await prepare(testEnv.DB,
      "SELECT json_extract(value_json, '$.mode') AS mode, typeof(updated_at) AS time_type, updated_at, version FROM settings WHERE key = ?",
      ['test.registration']).first()).toEqual({ mode: 'closed', time_type: 'integer', updated_at: now, version: 1 });
  });

  it('enforces unique group IDs/names and setting keys', async () => {
    await insertGroup();
    await insertSetting();
    await expect(insertGroup('group-1', 'Other')).rejects.toThrow();
    await expect(insertGroup('other', 'Group One')).rejects.toThrow();
    await expect(insertSetting()).rejects.toThrow();
  });

  it.each(['enabled', '', 'ACTIVE', null])('rejects invalid group status %s', async (status) => {
    await expect(insertGroup('invalid', 'Invalid', status)).rejects.toThrow();
  });

  it.each([0, -1, 1.5, 'invalid', null])('rejects non-positive/non-integer version %s on both tables', async (version) => {
    await expect(insertGroup('invalid', 'Invalid', 'active', version)).rejects.toThrow();
    await expect(insertSetting('invalid', '{}', version)).rejects.toThrow();
  });

  it.each(['{invalid}', '', '{"key":}', null])('rejects malformed or missing JSON %s', async (json) => {
    await expect(insertSetting('invalid', json)).rejects.toThrow();
  });

  it.each(['{}', '[]', 'null', 'true', '42', '"text"'])('accepts valid JSON value %s without inventing a settings schema', async (json) => {
    await expect(insertSetting('json', json)).resolves.toMatchObject({ changes: 1 });
  });

  it.each([-1, 1.5, 'invalid', null])('rejects invalid timestamp %s', async (time) => {
    await expect(insertGroup('invalid', 'Invalid', 'active', 1, time)).rejects.toThrow();
    await expect(insertGroup('invalid', 'Invalid', 'active', 1, now, time)).rejects.toThrow();
    await expect(insertSetting('invalid', '{}', 1, time)).rejects.toThrow();
  });

  it('requires nonempty identities and group names, including explicit NOT NULL text primary keys', async () => {
    await expect(insertGroup(null)).rejects.toThrow();
    await expect(insertGroup('')).rejects.toThrow();
    await expect(insertGroup('valid', '   ')).rejects.toThrow();
    await expect(insertGroup('valid', null)).rejects.toThrow();
    await expect(insertSetting(null)).rejects.toThrow();
    await expect(insertSetting(' ')).rejects.toThrow();
  });

  it('enforces checks on UPDATE as well as INSERT', async () => {
    await insertGroup();
    await insertSetting();
    await expect(prepare(testEnv.DB, 'UPDATE groups SET status = ? WHERE id = ?', ['invalid', 'group-1']).run()).rejects.toThrow();
    await expect(prepare(testEnv.DB, 'UPDATE settings SET version = ? WHERE key = ?', [0, 'test.registration']).run()).rejects.toThrow();
    await expect(prepare(testEnv.DB, 'UPDATE settings SET value_json = ? WHERE key = ?', ['broken', 'test.registration']).run()).rejects.toThrow();
  });

  it('provides ordered group status lookup plus primary/unique key indexes', async () => {
    const columns = await prepare<{ name: string }>(testEnv.DB, "PRAGMA index_info('idx_groups_status_id')").all();
    expect(columns.rows.map((column) => column.name)).toEqual(['status', 'id']);
    const groupIndexes = await prepare<{ origin: string; unique: number }>(testEnv.DB, "PRAGMA index_list('groups')").all();
    expect(groupIndexes.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: 'pk', unique: 1 }),
      expect.objectContaining({ origin: 'u', unique: 1 }),
    ]));
    const settingIndexes = await prepare<{ origin: string; unique: number }>(testEnv.DB, "PRAGMA index_list('settings')").all();
    expect(settingIndexes.rows).toEqual(expect.arrayContaining([expect.objectContaining({ origin: 'pk', unique: 1 })]));
  });
});
