import { beforeEach, describe, expect, it } from 'vitest';
import { createRequestQueryRoutes, PERSONAL_REQUESTS_PATH, ADMIN_REQUESTS_PATH } from '../../apps/worker/gateway/request-query-routes';
import { createPriceSnapshot } from '../../apps/worker/billing/fingerprint';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { testEnv } from '../helpers/database';

const now = 10000;
const owner = 'b12-owner', other = 'b12-other', admin = 'b12-admin';
const cookies = new Map<string, string>();
let price: string;
async function insert(id: string, user = owner, time = 5000) {
  await testEnv.DB.prepare(`INSERT INTO requests(id,user_id,api_key_id,channel_id,public_model_id,upstream_model,downstream_protocol,upstream_protocol,price_snapshot,created_at,updated_at)
    VALUES(?, ?, ?, 'b12-channel','b12-model','upstream','chat','chat',?,?,?)`).bind(id, user, `${user}-key`, price, time, time).run();
}
function request(path = PERSONAL_REQUESTS_PATH, user = owner, time = now) {
  return createRequestQueryRoutes({ now: () => time }).request('https://console.example' + path,
    { headers: { Cookie: cookies.get(user) ?? '', 'X-Actor-Id': admin } }, { DB: testEnv.DB });
}
beforeEach(async () => {
  cookies.clear();
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('b12-group','B12','active',1,0,0)").run();
  for (const [index, user] of [owner, other, admin].entries()) {
    await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES(?,?,?,?,'active','b12-group',2,60,'bootstrap',0,0)`).bind(user, `${user}@example.invalid`, 'PRIVATE PASSWORD HASH', user === admin ? 'admin' : 'user').run();
    await testEnv.DB.prepare("INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at) VALUES(?,?,?,'s2a_key_ABCDEFGH','key','active',0,0)")
      .bind(`${user}-key`, user, String(index + 1).repeat(64)).run();
    cookies.set(user, (await createCookieSession(testEnv.DB, user, 1000)).setCookie.split(';')[0]!);
  }
  await testEnv.DB.prepare(`INSERT INTO channels(id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES('b12-channel','channel','https://example.invalid',?,'test','active',1,2,60,1,0,0)`).bind(JSON.stringify({ algorithm: 'A256GCM', format_version: 1, key_version: 'test', nonce: 'synthetic', ciphertext: 'PRIVATE CHANNEL SECRET' })).run();
  await testEnv.DB.prepare(`INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES ('b12-model','active','{"input":"1","output":"2"}',1,0,4096,0,0)`).run();
  price = createPriceSnapshot({ publicModelId: 'b12-model', upstreamModel: 'upstream', upstreamProtocol: 'chat', priceVersion: 1, sellPrices: { input: '1', output: '2' } }).json;
  await insert('b12-a'); await insert('b12-b'); await insert('b12-c'); await insert('b12-foreign', other);
});

describe('request query HTTP on native D1', () => {
  it('projects persisted request source and group without exposing chat message contents', async () => {
    await testEnv.DB.prepare("UPDATE requests SET source='web_chat',group_id='b12-group' WHERE id='b12-a'").run();
    const chat = await request(`${PERSONAL_REQUESTS_PATH}/b12-a`);
    expect(chat.status).toBe(200);
    expect(await chat.json()).toMatchObject({ data: { source: 'web_chat', group_id: 'b12-group' } });
    const api = await request(`${PERSONAL_REQUESTS_PATH}/b12-b`);
    expect(await api.json()).toMatchObject({ data: { source: 'api', group_id: null } });
  });
  it('isolates personal list/detail and ignores no client-selected admin scope', async () => {
    const response = await request(); expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json<{ data: { items: { user_id: string }[] } }>(); expect(body.data.items).toHaveLength(3);
    expect(body.data.items.every(row => row.user_id === owner)).toBe(true);
    expect((await request(`${PERSONAL_REQUESTS_PATH}/b12-foreign`)).status).toBe(404);
    expect((await request(PERSONAL_REQUESTS_PATH + '?userId=' + other)).status).toBe(400);
    expect((await request(PERSONAL_REQUESTS_PATH + '?scope=admin')).status).toBe(400);
    expect((await request(ADMIN_REQUESTS_PATH)).status).toBe(403);
    expect((await request(PERSONAL_REQUESTS_PATH, 'missing')).status).toBe(401);
    expect((await request(`${ADMIN_REQUESTS_PATH}/b12-foreign`, admin)).status).toBe(200);
  });
  it('returns controlled price/usage/error evidence and preserves unknown cost rather than zero', async () => {
    await testEnv.DB.prepare(`UPDATE requests SET usage_json=?,usage_quality='partial',error_code='upstream_error',error_message=?,attempts_json=? WHERE id='b12-a'`)
      .bind(JSON.stringify({ protocol: 'chat', quality: 'partial', counts: { inputTokens: 7 }, sources: [{ raw: { prompt: 'PRIVATE PROMPT', authorization: 'PRIVATE KEY' } }], issues: ['PRIVATE ERROR'] }),
        'PRIVATE UPSTREAM ERROR', '[{"prompt":"PRIVATE PROMPT"}]').run();
    const response = await request(`${PERSONAL_REQUESTS_PATH}/b12-a`); const text = await response.text(); expect(text).not.toContain('PRIVATE');
    const body = JSON.parse(text).data;
    expect(body.price_snapshot.sell_prices).toEqual({ input: '1', output: '2' });
    expect(body.usage.counts).toEqual({ inputTokens: 7 }); expect(body.usage.counts).not.toHaveProperty('outputTokens');
    expect(body.cost_units).toBeNull(); expect(body.error).toEqual({ code: 'upstream_error', message: 'Upstream request failed.' });
    await testEnv.DB.prepare("UPDATE requests SET cost_units=9007199254740991 WHERE id='b12-a'").run();
    expect(await (await request(`${PERSONAL_REQUESTS_PATH}/b12-a`)).json()).toMatchObject({ data: { cost_units: '9007199254740991' } });
  });
  it('marks malformed evidence unavailable without returning arbitrary JSON', async () => {
    await testEnv.DB.prepare("UPDATE requests SET price_snapshot=?,usage_json=?,error_code=? WHERE id='b12-a'")
      .bind('{"prompt":"PRIVATE"}', '{"raw":"PRIVATE"}', 'PRIVATE ERROR').run();
    const response = await request(`${PERSONAL_REQUESTS_PATH}/b12-a`); const text = await response.text(); expect(text).not.toContain('PRIVATE');
    expect(JSON.parse(text).data).toMatchObject({ price_snapshot: null, price_snapshot_valid: false, usage: null, usage_valid: false, error: { code: 'unclassified_error' } });
  });
  it('filters admin user/time/status/model and validates query boundaries', async () => {
    await testEnv.DB.prepare("UPDATE requests SET execution_status='failed',billing_status='usage_unknown' WHERE id='b12-a'").run();
    const path = `${ADMIN_REQUESTS_PATH}?userId=${owner}&from=5000&to=5000&status=failed&billingStatus=usage_unknown&model=b12-model`;
    expect(await (await request(path, admin)).json()).toMatchObject({ data: { items: [{ id: 'b12-a' }] } });
    for (const query of ['from=-1', 'to=1.5', 'from=01', 'from=1%0A', 'from=10&to=9', 'to=9007199254740992', 'status=wrong', 'billingStatus=wrong', 'limit=101', 'limit=2&limit=3', 'cursor=', "model='%20OR%201=1", 'actorId=other']) {
      expect((await request(`${ADMIN_REQUESTS_PATH}?${query}`, admin)).status, query).toBe(400);
    }
  });
  it('paginates ties with actor/filter/scope-bound cursor and fixed creation ceiling', async () => {
    const first = await (await request(PERSONAL_REQUESTS_PATH + '?limit=2')).json<{ data: { items: { id: string }[]; nextCursor: string } }>();
    await insert('b12-new', owner, now + 1);
    const second = await (await request(`${PERSONAL_REQUESTS_PATH}?limit=2&cursor=${first.data.nextCursor}`, owner, now + 2)).json<{ data: { items: { id: string }[]; nextCursor: null } }>();
    expect([...first.data.items, ...second.data.items].map(row => row.id)).toEqual(['b12-c', 'b12-b', 'b12-a']); expect(second.data.nextCursor).toBeNull();
    expect((await request(`${PERSONAL_REQUESTS_PATH}?cursor=${first.data.nextCursor}`, other)).status).toBe(400);
    expect((await request(`${ADMIN_REQUESTS_PATH}?cursor=${first.data.nextCursor}`, admin)).status).toBe(400);
    expect((await request(`${PERSONAL_REQUESTS_PATH}?status=failed&cursor=${first.data.nextCursor}`)).status).toBe(400);
  });
});
