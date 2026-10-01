import { expect, inject, it } from 'vitest';
import { prepare } from '../../apps/worker/db';
import { resetTestDatabase, testEnv } from '../helpers/database';

it('adds a string multiplier with a legacy 1x default and rejects imprecise forms', async () => {
  const migrations = inject('d1Migrations');
  await resetTestDatabase(migrations.filter(migration => migration.name < '0020_group_billing_multiplier.sql'));
  const migration = migrations.find(item => item.name === '0020_group_billing_multiplier.sql');
  if (!migration) throw new Error('0020 migration is missing');
  await testEnv.DB.batch(migration.queries.map(sql => testEnv.DB.prepare(sql)));

  const columns = (await testEnv.DB.prepare('PRAGMA table_info(groups)').all()).results;
  expect(columns.map(column => column.name)).toContain('billing_multiplier');
  await prepare(testEnv.DB, `INSERT INTO groups(id,name,status,version,created_at,updated_at)
    VALUES('multiplier-default','Multiplier default','active',1,0,0)`).run();
  expect(await testEnv.DB.prepare("SELECT billing_multiplier FROM groups WHERE id='multiplier-default'").first('billing_multiplier')).toBe('1');

  for (const [id, multiplier] of [['multiplier-zero', '0'], ['multiplier-fraction', '0.2'], ['multiplier-precise', '1.000000000000000000']] as const) {
    await prepare(testEnv.DB, `INSERT INTO groups(id,name,status,version,created_at,updated_at,billing_multiplier)
      VALUES(?,?,?,1,0,0,?)`, [id, id, 'active', multiplier]).run();
  }
  for (const multiplier of ['', '01', '-1', '1e2', '1.', '.2', '0.1234567890123456789', ' 1']) {
    await expect(prepare(testEnv.DB, `INSERT INTO groups(id,name,status,version,created_at,updated_at,billing_multiplier)
      VALUES(?,?,?,?,?,?,?)`, [`invalid-${multiplier || 'empty'}`, `Invalid ${multiplier || 'empty'}`, 'active', 1, 0, 0, multiplier]).run()).rejects.toThrow();
  }
});
