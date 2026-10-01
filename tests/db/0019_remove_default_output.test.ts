import { expect, inject, it } from 'vitest';
import { resetTestDatabase, testEnv } from '../helpers/database';

it('removes the obsolete model column while preserving existing model prices and limits', async () => {
  const migrations = inject('d1Migrations');
  await resetTestDatabase(migrations.filter(m => m.name < '0019'));
  await testEnv.DB.prepare(`INSERT INTO channels(id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES('legacy-output','Legacy output','https://fixture.example.invalid','{"algorithm":"A256GCM","format_version":1,"key_version":"v1","nonce":"fixture","ciphertext":"fixture"}','v1','disabled',1,2,60,1,0,0)`).run();
  await testEnv.DB.prepare(`INSERT INTO channel_models(channel_id,public_model_id,upstream_model,protocol,capabilities_json,config_version)
    VALUES('legacy-output','gpt-5','provider','responses','{"protocol":"responses","features":["streaming"],"maxOutputTokens":128000,"defaultOutputTokens":4096}',3)`).run();
  const before = (await testEnv.DB.prepare('SELECT public_model_id,sell_prices_json,max_output_tokens,price_version FROM models ORDER BY public_model_id').all()).results;
  const migration = migrations.find(m => m.name === '0019_remove_default_output.sql')!;
  await testEnv.DB.batch(migration.queries.map(sql => testEnv.DB.prepare(sql)));
  const columns = (await testEnv.DB.prepare('PRAGMA table_info(models)').all()).results;
  expect(columns.map(c => c.name)).not.toContain('default_output_tokens');
  expect((await testEnv.DB.prepare('SELECT public_model_id,sell_prices_json,max_output_tokens,price_version FROM models ORDER BY public_model_id').all()).results).toEqual(before);
  const mapping = await testEnv.DB.prepare("SELECT capabilities_json,config_version FROM channel_models WHERE channel_id='legacy-output'").first<{ capabilities_json: string; config_version: number }>();
  expect(JSON.parse(mapping!.capabilities_json)).toEqual({ protocol: 'responses', features: ['streaming'], maxOutputTokens: 128000 });
  expect(mapping!.config_version).toBe(4);
});
