import { describe, expect, it } from 'vitest';
import builtinSeed from '../../seeds/builtin-models.sql?raw';
import { BUILTIN_MODELS } from '../../packages/model-catalog/index';
import { getModelById } from '../../apps/worker/admin/model-repository';
import { testEnv } from '../helpers/database';

async function seedAgain() {
  await testEnv.DB.batch(builtinSeed.split(';').filter(sql => sql.trim()).map(sql => testEnv.DB.prepare(sql)));
}

describe('built-in model installation', () => {
  it('installs the complete catalog as usable, editable model records without granting channel access', async () => {
    expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM models').first('COUNT(*)')).toBe(BUILTIN_MODELS.length);
    for (const model of BUILTIN_MODELS) {
      expect(await getModelById(testEnv.DB, model.id)).toMatchObject({ publicModelId: model.id, status: 'active', sellPrices: model.prices,
        priceVersion: 1 });
    }
    expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM channel_models').first('COUNT(*)')).toBe(0);
  });
  it('preserves administrator prices, status and versions on repeated installation', async () => {
    await testEnv.DB.prepare(`UPDATE models SET sell_prices_json='{"input":"0.01","output":"0.02"}',status='disabled',price_version=7 WHERE public_model_id='gpt-5'`).run();
    const before = await getModelById(testEnv.DB, 'gpt-5');
    await seedAgain();
    await seedAgain();
    expect(await getModelById(testEnv.DB, 'gpt-5')).toEqual(before);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) FROM models').first('COUNT(*)')).toBe(BUILTIN_MODELS.length);
  });
});
