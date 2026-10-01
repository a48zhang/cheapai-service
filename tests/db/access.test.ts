import { beforeEach, describe, expect, it } from 'vitest';
import { batch, prepare } from '../../apps/worker/db';
import { migrateTestDatabase, testEnv } from '../helpers/database';

interface ProbeRow { id: string; value: string; quantity: number; optional: string | null }

beforeEach(async () => {
  await migrateTestDatabase([{
    name: '9998_db_access_probe.sql',
    queries: ['CREATE TABLE db_access_probe (id TEXT PRIMARY KEY, value TEXT NOT NULL, quantity INTEGER NOT NULL CHECK (quantity >= 0), optional TEXT)'],
  }]);
});

describe('parameterized native D1 access', () => {
  it('binds SQL-looking text, numbers, null and binary without interpolation', async () => {
    const value = "'); DROP TABLE db_access_probe; --";
    const written = await prepare<ProbeRow>(testEnv.DB,
      'INSERT INTO db_access_probe (id, value, quantity, optional) VALUES (?, ?, ?, ?) RETURNING *',
      ['bound', value, 7, null]).run();
    expect(written.changes).toBe(1);
    expect(written.rows).toEqual([{ id: 'bound', value, quantity: 7, optional: null }]);
    expect(written.meta.changes).toBe(written.changes);
    const selected = await prepare<ProbeRow>(testEnv.DB, 'SELECT * FROM db_access_probe WHERE id = ?').bind('bound').first();
    expect(selected).toEqual(written.rows[0]);
    const blob = await prepare<{ bytes: string }>(testEnv.DB, 'SELECT hex(?) AS bytes', [new Uint8Array([0, 255, 42])]).first();
    expect(blob).toEqual({ bytes: '00FF2A' });
  });

  it('keeps a prepared query reusable and exposes empty query and zero write results', async () => {
    const statement = prepare<{ value: string }>(testEnv.DB, 'SELECT ? AS value');
    const a = statement.bind('a');
    const b = statement.bind('b');
    expect((await a.first())?.value).toBe('a');
    expect((await b.first())?.value).toBe('b');
    expect(await prepare(testEnv.DB, 'SELECT * FROM db_access_probe').first()).toBeNull();
    expect((await prepare(testEnv.DB, 'SELECT * FROM db_access_probe').all()).rows).toEqual([]);
    const updated = await prepare<ProbeRow>(testEnv.DB,
      'UPDATE db_access_probe SET value = ? WHERE id = ? RETURNING *', ['changed', 'absent']).run();
    expect(updated.changes).toBe(0);
    expect(updated.rows).toEqual([]);
  });

  it('returns each atomic batch result in order with its RETURNING projection', async () => {
    const [inserted, selected] = await batch(testEnv.DB, [
      prepare<{ id: string }>(testEnv.DB,
        'INSERT INTO db_access_probe (id, value, quantity) VALUES (?, ?, ?) RETURNING id', ['batch', 'value', 1]),
      prepare<{ quantity: number }>(testEnv.DB, 'SELECT quantity FROM db_access_probe WHERE id = ?', ['batch']),
    ]);
    expect(inserted.changes).toBe(1);
    expect(inserted.rows).toEqual([{ id: 'batch' }]);
    expect(selected.rows).toEqual([{ quantity: 1 }]);
  });

  it('rolls back an earlier write when a later SQL constraint fails', async () => {
    await expect(batch(testEnv.DB, [
      prepare(testEnv.DB, 'INSERT INTO db_access_probe (id, value, quantity) VALUES (?, ?, ?)', ['rollback', 'first', 1]),
      prepare(testEnv.DB, 'INSERT INTO db_access_probe (id, value, quantity) VALUES (?, ?, ?)', ['invalid', 'second', -1]),
    ])).rejects.toThrow();
    expect((await prepare(testEnv.DB, 'SELECT * FROM db_access_probe').all()).rows).toEqual([]);
  });

  it('does not invent rollback or business success when a batch update matches zero rows', async () => {
    const [inserted, missing] = await batch(testEnv.DB, [
      prepare(testEnv.DB, 'INSERT INTO db_access_probe (id, value, quantity) VALUES (?, ?, ?)', ['committed', 'first', 1]),
      prepare(testEnv.DB, 'UPDATE db_access_probe SET quantity = ? WHERE id = ? RETURNING id', [2, 'absent']),
    ]);
    expect(inserted.changes).toBe(1);
    expect(missing.changes).toBe(0);
    expect(missing.rows).toEqual([]);
    expect(await prepare(testEnv.DB, 'SELECT id FROM db_access_probe WHERE id = ?', ['committed']).first()).toEqual({ id: 'committed' });
  });
});
