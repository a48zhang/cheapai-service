import { exports as workerExports } from 'cloudflare:workers';
import { beforeEach, describe, expect, inject, it } from 'vitest';
import { migrateTestDatabase, migrationsForTest, resetTestDatabase, testEnv } from './helpers/database';

const probeMigrations = [{
  name: '9999_runtime_isolation_probe.sql',
  queries: ['CREATE TABLE runtime_isolation_probe (id TEXT PRIMARY KEY, value TEXT NOT NULL)'],
}];

describe.sequential('local Workers bindings and D1 isolation', () => {
  beforeEach(async () => {
    await migrateTestDatabase(probeMigrations);
  });

  // Both cases reuse the same primary key and assert an empty database first.
  // Without the reset hook, the second case sees the prior row and fails.
  it.each(['first', 'second'])('%s case starts with clean native D1 and KV', async (value) => {
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM runtime_isolation_probe').first('count')).toBe(0);
    expect(await testEnv.CACHE.get('runtime-isolation-probe')).toBeNull();
    await testEnv.DB.prepare('INSERT INTO runtime_isolation_probe (id, value) VALUES (?, ?)').bind('same-id', value).run();
    await testEnv.CACHE.put('runtime-isolation-probe', value);
    expect(await testEnv.DB.prepare('SELECT value FROM runtime_isolation_probe WHERE id = ?').bind('same-id').first('value')).toBe(value);

    // Applying the same migration again must not recreate an existing table.
    await migrateTestDatabase(probeMigrations);
    const response = await workerExports.default.fetch('https://local.test/healthz');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });

    const gate = testEnv.GATE.get(testEnv.GATE.idFromName('runtime-isolation-probe'));
    expect((await gate.fetch('https://local.test/')).status).toBe(501);
  });
});

it('isolates numbered schema tests while ordinary integration tests retain all migrations', async () => {
  const all = inject('d1Migrations');
  expect(migrationsForTest(all, 'C:/project/tests/auth/login.test.ts')).toBe(all);
  const first = migrationsForTest(all, 'C:\\project\\tests\\db\\0001_groups_settings.test.ts');
  expect(first.map((migration) => migration.name)).toEqual(['0001_groups_settings.sql']);
  await resetTestDatabase(first);
  const tables = await testEnv.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
  expect(tables.results.map((row) => row.name)).toContain('groups');
  expect(tables.results.map((row) => row.name)).not.toContain('users');
});
