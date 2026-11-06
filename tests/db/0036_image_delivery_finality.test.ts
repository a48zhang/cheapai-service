import { expect, inject, it } from 'vitest';
import { applyD1Migrations } from 'cloudflare:test';
import { resetTestDatabase, testEnv } from '../helpers/database';

it('closes legacy indeterminate deliveries without changing balances or reopening them', async () => {
  const migrations = inject('d1Migrations');
  await resetTestDatabase(migrations.filter((item) => Number(item.name.slice(0, 4)) <= 35));
  for (const sql of [
    "INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('g','Images','active',1,0,0)",
    "INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at) VALUES('u','migration@example.invalid','test','user','active','g',0,1,60,'bootstrap',0,0)",
    "INSERT INTO channels(id,name,base_url,upstream_key,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at) VALUES('c','Images','https://example.invalid','test','active',1,1,60,1,0,0)",
    `INSERT INTO image_models(id,name,channel_id,upstream_model,price_units,sizes_json,quality,response_format,status,version,created_at,updated_at) VALUES('m','Images','c','model',1,'["1024x1024"]','default','default','active',1,0,0)`,
    `INSERT INTO image_generations(id,user_id,operation_id,model_id,model_name,group_id,prompt,size,status,error,price_units,price_snapshot,billing_status,created_at,updated_at,expires_at) VALUES('j','u','op','m','Images','g','cat','1024x1024','unknown','result_unknown',1,'{}','unbilled',0,0,1)`,
  ])
    await testEnv.DB.prepare(sql).run();
  await applyD1Migrations(
    testEnv.DB,
    migrations.filter((item) => item.name.startsWith('0036')),
  );
  expect(
    await testEnv.DB.prepare(
      "SELECT status,error,billing_status FROM image_generations WHERE id='j'",
    ).first(),
  ).toEqual({ status: 'failed', error: 'delivery_failed', billing_status: 'unbilled' });
  expect(
    await testEnv.DB.prepare("SELECT balance_units FROM users WHERE id='u'").first('balance_units'),
  ).toBe(0);
  expect(await testEnv.DB.prepare('SELECT count(*) AS n FROM billing_entries').first('n')).toBe(0);
  await expect(
    testEnv.DB.prepare("UPDATE image_generations SET status='generating' WHERE id='j'").run(),
  ).rejects.toThrow();
});
