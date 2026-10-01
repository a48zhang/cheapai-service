import { beforeEach, describe, expect, it } from 'vitest';
import { createModelsRoute, MODELS_PATH } from '../../apps/worker/gateway/models-route';
import { generateToken, hashToken } from '../../apps/worker/auth/tokens';
import { testEnv } from '../helpers/database';

const now = 1_800_000_000_000;
let token: string;
function app() { return createModelsRoute({ now: () => now }); }
function get(query = '', headers: Record<string, string> = { Authorization: `Bearer ${token}` }) {
  return app().request('https://gateway.example' + MODELS_PATH + query, { headers }, { DB: testEnv.DB });
}
async function model(id: string, channel = 'g15-channel', status = 'active', protocol = 'chat') {
  await testEnv.DB.prepare(`INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES (?,?,'{"input":"1","output":"2"}',1,0,100,0,0)`).bind(id, status).run();
  await testEnv.DB.prepare('INSERT INTO channel_models(channel_id,public_model_id,protocol,upstream_model,capabilities_json,config_version) VALUES(?,?,?,?,?,1)')
    .bind(channel, id, protocol, 'private-upstream-model', JSON.stringify({ protocol, features: [] })).run();
}
beforeEach(async () => {
  for (const id of ['g15-group', 'g15-other']) await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES(?,?,'active',1,0,0)").bind(id, id).run();
  await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES('g15-user','g15@example.invalid','private-hash','user','active','g15-group',2,60,'admin',0,0)`).run();
  token = generateToken('apiKey');
  await testEnv.DB.prepare("INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at) VALUES('g15-key','g15-user',?,'s2a_key_ABCDEFGH','G15 key','active',0,0)").bind(await hashToken('apiKey', token)).run();
  for (const [id, group, status] of [['g15-channel', 'g15-group', 'active'], ['g15-other-channel', 'g15-other', 'active'], ['g15-disabled-channel', 'g15-group', 'disabled']]) {
    await testEnv.DB.prepare(`INSERT INTO channels(id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
      VALUES(?,?,'https://private.example',?,'test',?,0,2,60,1,0,0)`).bind(id, id, JSON.stringify({ algorithm: 'A256GCM', format_version: 1, key_version: 'test', nonce: 'private-nonce', ciphertext: 'private-ciphertext' }), status).run();
    await testEnv.DB.prepare('INSERT INTO channel_groups(channel_id,group_id) VALUES(?,?)').bind(id, group).run();
  }
  await model('visible-a'); await model('visible-b'); await model('foreign-group', 'g15-other-channel');
  await model('disabled-model', 'g15-channel', 'disabled'); await model('disabled-channel', 'g15-disabled-channel');
  await testEnv.DB.prepare("INSERT INTO channel_models(channel_id,public_model_id,protocol,upstream_model,capabilities_json,config_version) VALUES('g15-channel','visible-a','responses','private-second-upstream','{}',1)").run();
});

describe('native authenticated model catalog', () => {
  it('lists only active current-group mappings, deduplicated across protocols with native fields', async () => {
    const response = await get(); expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ object: 'list', data: [
      { id: 'visible-a', object: 'model', created: 0, owned_by: 'sub2api' },
      { id: 'visible-b', object: 'model', created: 0, owned_by: 'sub2api' },
    ] });
    expect(text).not.toMatch(/private-|channel_id|key_hash|request_id|sellPrices/);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('intersects Key restrictions with group permissions and distinguishes null from empty arrays', async () => {
    await testEnv.DB.prepare("UPDATE api_keys SET allowed_models_json=? WHERE id='g15-key'").bind(JSON.stringify(['visible-b', 'foreign-group'])).run();
    expect(await (await get()).json()).toMatchObject({ data: [{ id: 'visible-b' }] });
    await testEnv.DB.prepare("UPDATE api_keys SET allowed_models_json='[]' WHERE id='g15-key'").run();
    expect(await (await get()).json()).toEqual({ object: 'list', data: [] });
    await testEnv.DB.prepare("UPDATE api_keys SET allowed_models_json=NULL WHERE id='g15-key'").run();
    expect((await (await get()).json() as { data: unknown[] }).data).toHaveLength(2);
  });
  it('uses native credential errors and rejects cookies/forged ownership as authentication', async () => {
    for (const headers of [{}, { Cookie: '__Host-sub2api_session=fake' }, { Authorization: 'Bearer bad', 'X-User-Id': 'g15-user' }]) {
      const response = await get('', headers); expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { message: 'Invalid API key.', type: 'authentication_error', code: 'invalid_api_key', param: null } });
    }
    expect((await get('', { Authorization: `Bearer ${token}`, 'x-api-key': generateToken('apiKey') })).status).toBe(400);
    expect((await get('', { 'x-api-key': token })).status).toBe(200);
    expect((await get('?userId=g15-user')).status).toBe(400);
    expect((await get('?limit=1')).status).toBe(400);
  });
  it('rechecks revoked/expired Keys and disabled users/groups in D1', async () => {
    await testEnv.DB.prepare("UPDATE api_keys SET status='revoked' WHERE id='g15-key'").run(); expect((await get()).status).toBe(401);
    await testEnv.DB.prepare("UPDATE api_keys SET status='active',expires_at=? WHERE id='g15-key'").bind(now).run(); expect((await get()).status).toBe(401);
    await testEnv.DB.prepare("UPDATE api_keys SET expires_at=NULL WHERE id='g15-key'").run();
    await testEnv.DB.prepare("UPDATE users SET status='disabled' WHERE id='g15-user'").run(); expect((await get()).status).toBe(401);
    await testEnv.DB.prepare("UPDATE users SET status='active' WHERE id='g15-user'").run();
    await testEnv.DB.prepare("UPDATE groups SET status='disabled' WHERE id='g15-group'").run(); expect((await get()).status).toBe(401);
  });
  it('does not silently truncate a catalog to an arbitrary page limit', async () => {
    for (let index = 0; index < 105; index++) await model(`bulk-${String(index).padStart(3, '0')}`);
    const response = await get(); expect(response.status).toBe(200);
    expect((await response.json() as { data: unknown[] }).data).toHaveLength(107);
  });
  it('returns native 503 on database failure instead of a successful empty catalog', async () => {
    const database = { prepare() { throw new Error('private database details'); } } as unknown as D1Database;
    const response = await app().request('https://gateway.example/v1/models', { headers: { Authorization: `Bearer ${token}` } }, { DB: database });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { message: 'Service temporarily unavailable.', type: 'server_error', code: 'service_unavailable', param: null } });
  });
});
