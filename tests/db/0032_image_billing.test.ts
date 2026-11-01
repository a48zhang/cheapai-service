import { expect, inject, it } from 'vitest';
import { applyD1Migrations } from 'cloudflare:test';
import { resetTestDatabase, testEnv } from '../helpers/database';

it('preserves existing ledger facts, pagination rowids and balances during the image migration', async () => {
  const migrations = inject('d1Migrations');
  await resetTestDatabase(migrations.filter((item) => Number(item.name.slice(0, 4)) <= 30));
  await testEnv.DB.prepare(
    "INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('image-migration','Migration','active',1,0,0)",
  ).run();
  await testEnv.DB.prepare(
    "INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at) VALUES('image-migration-user','migration@example.invalid','test','admin','active','image-migration',0,1,60,'bootstrap',0,0)",
  ).run();
  await testEnv.DB.prepare(
    "INSERT INTO billing_entries(rowid,id,operation_id,kind,user_id,delta_units,fingerprint,reason,created_at) VALUES(17,'prior-grant','prior-grant','grant','image-migration-user',1000000,'prior','Migration fixture',1)",
  ).run();
  const before = await testEnv.DB.prepare('SELECT rowid,* FROM billing_entries').first();
  await applyD1Migrations(
    testEnv.DB,
    migrations.filter((item) => Number(item.name.slice(0, 4)) > 30),
  );
  expect(await testEnv.DB.prepare('SELECT rowid,* FROM billing_entries').first()).toEqual({
    ...before,
    image_generation_id: null,
  });
  expect(
    await testEnv.DB.prepare(
      "SELECT balance_units FROM users WHERE id='image-migration-user'",
    ).first('balance_units'),
  ).toBe(1000000);
  await expect(
    testEnv.DB.prepare("UPDATE billing_entries SET delta_units=0 WHERE id='prior-grant'").run(),
  ).rejects.toThrow();
});
