import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../../apps/worker/app';
import { createPublicCatalogRoutes, PUBLIC_CATALOG_PATH } from '../../apps/worker/catalog/public-routes';
import { testEnv } from '../helpers/database';

async function model(id: string, channel = 'catalog-channel', status = 'active') {
  await testEnv.DB.prepare(`INSERT INTO models(public_model_id,status,sell_prices_json,price_version,created_at,updated_at)
    VALUES(?,?,'{"input":"0.25","output":"1.5","cacheRead":"0.00000001","cacheWrite":"2"}',1,0,0)`)
    .bind(id, status).run();
  await testEnv.DB.prepare(`INSERT INTO channel_models(channel_id,public_model_id,protocol,upstream_model,config_version)
    VALUES(?,?,'chat','private-upstream-model',1)`).bind(channel, id).run();
}

async function image(id: string, channel = 'catalog-channel', status = 'active') {
  await testEnv.DB.prepare(`INSERT INTO image_models(id,name,channel_id,upstream_model,price_units,sizes_json,quality,response_format,status,version,created_at,updated_at)
    VALUES(?, ?, ?, 'private-image-model', 4000000, '["1024x1024"]', 'standard', 'b64_json', ?, 1, 0, 0)`)
    .bind(id, id, channel, status).run();
}

const get = () => app.request(`https://catalog.example${PUBLIC_CATALOG_PATH}`, {}, testEnv);
async function items() {
  const response = await get();
  expect(response.status).toBe(200);
  return (await response.json<{ data: { items: unknown[] } }>()).data.items;
}

beforeEach(async () => {
  for (const [id, status] of [['catalog-group', 'active'], ['private-group', 'disabled']]) {
    await testEnv.DB.prepare(`INSERT INTO groups(id,name,status,version,billing_multiplier,created_at,updated_at)
      VALUES(?,?,?,1,'3',0,0)`).bind(id, id, status).run();
  }
  for (const [id, group, status] of [
    ['catalog-channel', 'catalog-group', 'active'],
    ['disabled-channel', 'catalog-group', 'disabled'],
    ['private-channel', 'private-group', 'active'],
    ['deleted-channel', 'catalog-group', 'active'],
  ]) {
    await testEnv.DB.prepare(`INSERT INTO channels(id,name,base_url,upstream_key,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
      VALUES(?,?,'https://private.example','private-key',?,0,2,60,1,0,0)`).bind(id, id, status).run();
    await testEnv.DB.prepare('INSERT INTO channel_groups(channel_id,group_id) VALUES(?,?)').bind(id, group).run();
  }
});

describe('public model catalog', () => {
  it('serves anonymous configured base prices, deduplicates routes and excludes private fields', async () => {
    await model('visible-model');
    await image('visible-image');
    await testEnv.DB.prepare(`INSERT INTO channel_models(channel_id,public_model_id,protocol,upstream_model,config_version)
      VALUES('catalog-channel','visible-model','responses','private-second-model',1)`).run();
    const response = await get();
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body).data.items).toEqual([
      { kind: 'text', id: 'visible-model', prices: { input: '0.25', output: '1.5', cacheRead: '0.00000001' } },
      { kind: 'image', id: 'visible-image', name: 'visible-image', price: '0.04000000' },
    ]);
    expect(body).not.toMatch(/private-|upstream|channel|cacheWrite|contextWindow|maxOutput|billing_multiplier/);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Set-Cookie')).toBeNull();
  });

  it('excludes unmapped seeds, disabled models/channels/groups, deleted channels and routes with no groups', async () => {
    expect(await items()).toEqual([]);
    for (const channel of ['disabled-channel', 'private-channel', 'deleted-channel']) {
      await model(`text-${channel}`, channel);
      await image(`image-${channel}`, channel);
    }
    await model('disabled-model', 'catalog-channel', 'disabled');
    await image('disabled-image', 'catalog-channel', 'disabled');
    await testEnv.DB.prepare("UPDATE channels SET status='disabled',deleted_at=1 WHERE id='deleted-channel'").run();
    expect(await items()).toEqual([]);
    await model('no-group-model');
    await image('no-group-image');
    await testEnv.DB.prepare("DELETE FROM channel_groups WHERE channel_id='catalog-channel'").run();
    expect(await items()).toEqual([]);
  });

  it('reflects price changes and exact zero prices without a static reference-price fallback', async () => {
    await model('priced-model');
    await image('priced-image');
    await testEnv.DB.prepare(`UPDATE models SET sell_prices_json='{"input":"0","output":"0.00000001"}',price_version=price_version+1
      WHERE public_model_id='priced-model'`).run();
    await testEnv.DB.prepare("UPDATE image_models SET price_units=1,version=version+1 WHERE id='priced-image'").run();
    expect(await items()).toEqual([
      { kind: 'text', id: 'priced-model', prices: { input: '0', output: '0.00000001' } },
      { kind: 'image', id: 'priced-image', name: 'priced-image', price: '0.00000001' },
    ]);
  });

  it('omits image models when image storage is unavailable', async () => {
    await model('text-model');
    await image('image-model');
    const response = await createPublicCatalogRoutes().request(PUBLIC_CATALOG_PATH, {}, { DB: testEnv.DB });
    expect((await response.json<{ data: { items: unknown[] } }>()).data.items).toHaveLength(1);
  });

  it('does not silently truncate the searchable inventory', async () => {
    for (let index = 0; index < 105; index++) await model(`model-${index}`);
    expect(await items()).toHaveLength(105);
  });

  it('returns 503 for invalid stored pricing rather than empty or free models', async () => {
    await model('invalid-price');
    await testEnv.DB.prepare(`UPDATE models SET sell_prices_json='{"input":"0"}' WHERE public_model_id='invalid-price'`).run();
    const response = await get();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'service_unavailable' } });
  });

  it('returns a generic 503 for storage failures', async () => {
    const database = { prepare() { throw new Error('private database details'); } } as unknown as D1Database;
    const response = await createPublicCatalogRoutes().request(PUBLIC_CATALOG_PATH, {}, { DB: database });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private');
  });
});
