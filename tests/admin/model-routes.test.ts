import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createModelRoutes, ADMIN_MODELS_PATH, MODEL_BODY_MAX_BYTES } from '../../apps/worker/admin/model-routes';
import { createModel } from '../../apps/worker/admin/model-repository';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { issueCsrfToken } from '../../apps/worker/auth/csrf';
import { testEnv } from '../helpers/database';

const now = 1_788_633_000_000;
const origin = 'https://console.example.com';
let adminCookie: string;
let userCookie: string;
function route() { return createModelRoutes({ now: () => now }); }
function get(query = '', cookie = adminCookie) { return route().request(origin + ADMIN_MODELS_PATH + query, { headers: { Cookie: cookie } }, { DB: testEnv.DB }); }
beforeEach(async () => {
  // Keep pagination fixtures independent of the installed built-in catalog.
  await testEnv.DB.prepare('DELETE FROM models').run();
  await testEnv.DB.prepare("INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES ('c09-group','C09 group','active',1,0,0)").run();
  for (const [id, role] of [['c09-admin', 'admin'], ['c09-user', 'user']]) await testEnv.DB.prepare(`INSERT INTO users (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES (?,?,'test-only',?,'active','c09-group',2,60,'admin',0,0)`).bind(id, `${id}@example.invalid`, role).run();
  adminCookie = (await createCookieSession(testEnv.DB, 'c09-admin', now)).setCookie.split(';')[0]!;
  userCookie = (await createCookieSession(testEnv.DB, 'c09-user', now)).setCookie.split(';')[0]!;
  for (let index = 0; index < 3; index++) await createModel(testEnv.DB, { publicModelId: `c09-${index}`, status: index === 2 ? 'disabled' : 'active',
    sellPrices: { input: '1', output: '2', cacheRead: '0' }, admissionMinBalanceUnits: '100', maxOutputTokens: 4096 },
  { actorId: 'c09-admin', operationId: `setup-${index}`, now });
});

function headers(cookie = adminCookie) {
  const nonce = issueCsrfToken();
  return { Cookie: `${cookie}; ${nonce.setCookie.split(';')[0]}`, Origin: origin, 'X-CSRF-Token': nonce.token, 'Content-Type': 'application/json', 'X-Actor-Id': 'c09-user' };
}
function writes() { return createModelRoutes({ now: () => now, trustedOrigin: origin }); }
const newModel = { publicModelId: 'c09-new', sellPrices: { input: '1', output: '2' }, admissionMinBalanceUnits: '0', maxOutputTokens: 4096 };
describe('administrator model creation', () => {
  it('stores exact prices and limits with trusted-actor atomic audit', async () => {
    const response = await writes().request(origin + ADMIN_MODELS_PATH, { method: 'POST', headers: headers(), body: JSON.stringify(newModel) }, { DB: testEnv.DB });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ data: { ...newModel, priceVersion: 1 } });
    expect(await testEnv.DB.prepare("SELECT actor_id FROM admin_audit WHERE target_id='c09-new'").first('actor_id')).toBe('c09-admin');
    expect((await writes().request(origin + ADMIN_MODELS_PATH, { method: 'POST', headers: headers(), body: JSON.stringify(newModel) }, { DB: testEnv.DB })).status).toBe(409);
  });
  it('requires explicit input/output rates and bounds every supplied optional rate', async () => {
    for (const sellPrices of [{}, { input: '1' }, { input: '1', output: 0 }, { input: '1', output: '2', cacheRead: '-1' }, { input: '1', output: '2', cacheWrite: '1e2' }]) {
      expect((await writes().request(origin + ADMIN_MODELS_PATH, { method: 'POST', headers: headers(), body: JSON.stringify({ ...newModel, sellPrices }) }, { DB: testEnv.DB })).status).toBe(400);
    }
    expect((await writes().request(origin + ADMIN_MODELS_PATH, { method: 'POST', headers: headers(), body: JSON.stringify({ ...newModel, sellPrices: { input: '0', output: '0' } }) }, { DB: testEnv.DB })).status).toBe(201);
    expect(await testEnv.DB.prepare("SELECT sell_prices_json FROM models WHERE public_model_id='c09-new'").first('sell_prices_json')).toBe('{"input":"0","output":"0"}');
  });
  it('enforces authorization/CSRF and typed limits without trusting injected configuration', async () => {
    const trustedOrigin = vi.fn(() => { throw new Error('unset'); });
    const lazy = createModelRoutes({ now: () => now, trustedOrigin });
    expect((await lazy.request(origin + ADMIN_MODELS_PATH, { method: 'POST' }, { DB: testEnv.DB })).status).toBe(401);
    expect((await lazy.request(origin + ADMIN_MODELS_PATH, { method: 'POST', headers: headers(userCookie) }, { DB: testEnv.DB })).status).toBe(403);
    expect(trustedOrigin).not.toHaveBeenCalled();
    expect((await writes().request(origin + ADMIN_MODELS_PATH, { method: 'POST', headers: { Cookie: adminCookie } }, { DB: testEnv.DB })).status).toBe(403);
    for (const patch of [{ maxOutputTokens: 0 }, { admissionMinBalanceUnits: 0.1 }, { admissionMinBalanceUnits: '-1' }]) {
      expect((await writes().request(origin + ADMIN_MODELS_PATH, { method: 'POST', headers: headers(), body: JSON.stringify({ ...newModel, ...patch }) }, { DB: testEnv.DB })).status).toBe(400);
    }
  });
  it('checks streamed bytes and rolls back audit failure', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MODEL_BODY_MAX_BYTES + 1)); controller.close(); } });
    expect((await writes().request(new Request(origin + ADMIN_MODELS_PATH, { method: 'POST', headers: { ...headers(), 'Content-Length': '1' }, body }), undefined, { DB: testEnv.DB })).status).toBe(413);
    await testEnv.DB.exec("CREATE TRIGGER c09c_audit_fail BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'private failure'); END;");
    expect((await writes().request(origin + ADMIN_MODELS_PATH, { method: 'POST', headers: headers(), body: JSON.stringify(newModel) }, { DB: testEnv.DB })).status).toBe(503);
    expect(await testEnv.DB.prepare("SELECT public_model_id FROM models WHERE public_model_id='c09-new'").first()).toBeNull();
  });
});

describe('administrator model update and pricing CAS', () => {
  const target = () => `${origin}${ADMIN_MODELS_PATH}/c09-0`;
  it('updates status/prices atomically and preserves omitted fields', async () => {
    const response = await writes().request(target(), { method: 'PATCH', headers: headers(), body: '{"version":1,"status":"disabled","sellPrices":{"input":"3","output":"4","cacheRead":"0"}}' }, { DB: testEnv.DB });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { status: 'disabled', priceVersion: 2, sellPrices: { input: '3', output: '4', cacheRead: '0' }, admissionMinBalanceUnits: '100', maxOutputTokens: 4096 } });
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM admin_audit WHERE action='model.update' AND target_id='c09-0'").first('count')).toBe(1);
  });
  it('allows only typed patches and rejects missing replacement prices or privilege claims', async () => {
    for (const patch of [{ version: 1 }, { version: 1, sellPrices: { input: '1' } }, { version: 1, sellPrices: { input: '1', output: '2', reasoning: null } },
      { version: 1, publicModelId: 'other' }, { version: 1, actorId: 'c09-admin' }, { version: 1, admissionMinBalanceUnits: '1.2' }]) {
      expect((await writes().request(target(), { method: 'PATCH', headers: headers(), body: JSON.stringify(patch) }, { DB: testEnv.DB })).status).toBe(400);
    }
    expect((await writes().request(target(), { method: 'PATCH', headers: headers(userCookie), body: '{"version":1,"status":"disabled"}' }, { DB: testEnv.DB })).status).toBe(403);
    expect((await writes().request(target(), { method: 'PATCH', headers: { Cookie: adminCookie }, body: '{"version":1,"status":"disabled"}' }, { DB: testEnv.DB })).status).toBe(403);
  });
  it('does not overwrite concurrent changes and rolls back an audit failure', async () => {
    const app = writes();
    const responses = await Promise.all(['active', 'disabled'].map((status) => app.request(target(), { method: 'PATCH', headers: headers(), body: JSON.stringify({ version: 1, status }) }, { DB: testEnv.DB })));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const before = await testEnv.DB.prepare("SELECT * FROM models WHERE public_model_id='c09-0'").first();
    await testEnv.DB.exec("CREATE TRIGGER c09u_audit_fail BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'private failure'); END;");
    expect((await app.request(target(), { method: 'PATCH', headers: headers(), body: '{"version":2,"sellPrices":{"input":"5","output":"6"}}' }, { DB: testEnv.DB })).status).toBe(503);
    expect(await testEnv.DB.prepare("SELECT * FROM models WHERE public_model_id='c09-0'").first()).toEqual(before);
  });
});
describe('administrator public-model listing', () => {
  it('returns explicit prices/versions/limits without resolving write configuration', async () => {
    const trustedOrigin = vi.fn(() => { throw new Error('not configured'); });
    const app = createModelRoutes({ now: () => now, trustedOrigin });
    const response = await app.request(origin + ADMIN_MODELS_PATH + '?limit=2', { headers: { Cookie: adminCookie } }, { DB: testEnv.DB });
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json() as { data: { items: unknown[]; nextCursor: string } };
    expect(body.data.items).toHaveLength(2);
    expect(body.data.items[0]).toMatchObject({ publicModelId: 'c09-2', sellPrices: { input: '1', output: '2', cacheRead: '0' }, priceVersion: 1, maxOutputTokens: 4096, admissionMinBalanceUnits: '100' });
    expect(await (await get(`?limit=2&cursor=${body.data.nextCursor}`)).json()).toMatchObject({ data: { items: [{ publicModelId: 'c09-0' }], nextCursor: null } });
    expect(trustedOrigin).not.toHaveBeenCalled();
  });
  it('requires session/admin and rejects invalid pagination/status', async () => {
    expect((await get('', '')).status).toBe(401); expect((await get('', userCookie)).status).toBe(403);
    for (const query of ['?limit=0', '?limit=101', '?limit=1&limit=2', '?status=other', '?status=active&status=disabled', '?cursor=bad!']) expect((await get(query)).status).toBe(400);
    expect(await (await get('?status=disabled')).json()).toMatchObject({ data: { items: [{ publicModelId: 'c09-2' }] } });
  });
  it('fails closed for corrupted prices rather than treating absent prices as free', async () => {
    await testEnv.DB.prepare("UPDATE models SET sell_prices_json='{}' WHERE public_model_id='c09-1'").run();
    expect((await get()).status).toBe(503);
  });
});
