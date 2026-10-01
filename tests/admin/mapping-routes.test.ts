import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMappingRoutes, MAPPING_BODY_MAX_BYTES } from '../../apps/worker/admin/mapping-routes';
import { createChannel } from '../../apps/worker/admin/channel-repository';
import { createModel } from '../../apps/worker/admin/model-repository';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { issueCsrfToken } from '../../apps/worker/auth/csrf';
import { testEnv } from '../helpers/database';

const now = 1_788_634_000_000;
const origin = 'https://console.example.com';
const listUrl = `${origin}/api/v1/admin/models/c11-public/mappings`;
let channelId: string; let adminCookie: string; let userCookie: string;
function app() { return createMappingRoutes({ now: () => now, trustedOrigin: origin }); }
function headers(cookie = adminCookie) { const csrf = issueCsrfToken(); return { Cookie: `${cookie}; ${csrf.setCookie.split(';')[0]}`, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.token, 'X-Actor-Id': 'c11-user' }; }
function input(protocol = 'chat') { return { channelId, protocol, upstreamModel: `upstream-${protocol}`, capabilities: { protocol, features: [], maxOutputTokens: 4096 } }; }
async function create(protocol = 'chat') { return app().request(listUrl, { method: 'POST', headers: headers(), body: JSON.stringify(input(protocol)) }, { DB: testEnv.DB }); }

describe('typed administrator model mapping HTTP', () => {
  beforeEach(async () => {
    await testEnv.DB.prepare("INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES ('c11-group','C11 group','active',1,0,0)").run();
    for (const [id, role] of [['c11-admin', 'admin'], ['c11-user', 'user']]) await testEnv.DB.prepare(`INSERT INTO users (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES (?,?,'test-only',?,'active','c11-group',2,60,'admin',0,0)`).bind(id, `${id}@example.invalid`, role).run();
    adminCookie = (await createCookieSession(testEnv.DB, 'c11-admin', now)).setCookie.split(';')[0]!;
    userCookie = (await createCookieSession(testEnv.DB, 'c11-user', now)).setCookie.split(';')[0]!;
    const audit = { actorId: 'c11-admin', operationId: 'setup', now };
    channelId = (await createChannel(testEnv.DB, { name: 'C11 channel', baseUrl: 'https://provider.example.com', upstreamKey: 'private-channel-key', concurrencyLimit: 2, rpmLimit: 60 }, audit, { keyVersion: 'v1', key: crypto.getRandomValues(new Uint8Array(32)) })).id;
    await createModel(testEnv.DB, { publicModelId: 'c11-public', sellPrices: { input: '1', output: '2' }, admissionMinBalanceUnits: '0', maxOutputTokens: 4096 }, audit);
  });
  it('creates separate protocol mappings and lists them without credential leakage or write config', async () => {
    for (const protocol of ['chat', 'responses', 'messages']) expect((await create(protocol)).status).toBe(201);
    const trustedOrigin = vi.fn(() => { throw new Error('unconfigured'); });
    const route = createMappingRoutes({ now: () => now, trustedOrigin });
    const response = await route.request(listUrl, { headers: { Cookie: adminCookie } }, { DB: testEnv.DB });
    expect(response.status).toBe(200);
    const text = await response.text(); expect(text).not.toMatch(/private-channel-key|secret_ciphertext|secret_key_version/);
    expect(JSON.parse(text).data.items).toHaveLength(3); expect(trustedOrigin).not.toHaveBeenCalled();
    const filtered = await route.request(listUrl + '?protocol=responses', { headers: { Cookie: adminCookie } }, { DB: testEnv.DB });
    expect(await filtered.json()).toMatchObject({ data: { items: [{ protocol: 'responses', upstreamModel: 'upstream-responses' }] } });
  });
  it('requires session/admin and CSRF, rejecting identity/group/capability injection', async () => {
    expect((await app().request(listUrl, {}, { DB: testEnv.DB })).status).toBe(401);
    expect((await app().request(listUrl, { headers: { Cookie: userCookie } }, { DB: testEnv.DB })).status).toBe(403);
    expect((await app().request(listUrl, { method: 'POST', headers: { Cookie: adminCookie } }, { DB: testEnv.DB })).status).toBe(403);
    for (const extra of [{ publicModelId: 'other' }, { groupId: 'c11-group' }, { actorId: 'c11-admin' }, { protocol: 'invalid' },
      { capabilities: { protocol: 'messages', features: [] } }, { capabilities: { protocol: 'chat', features: [], supported: true } }]) {
      expect((await app().request(listUrl, { method: 'POST', headers: headers(), body: JSON.stringify({ ...input(), ...extra }) }, { DB: testEnv.DB })).status).toBe(400);
    }
  });
  it('updates only the selected tuple through CAS and audits once', async () => {
    await create(); await create('messages');
    const target = `${listUrl}/${channelId}/chat`;
    const results = await Promise.all(['first', 'second'].map((upstreamModel) => app().request(target, { method: 'PATCH', headers: headers(), body: JSON.stringify({ version: 1, upstreamModel }) }, { DB: testEnv.DB })));
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(await testEnv.DB.prepare("SELECT upstream_model FROM channel_models WHERE protocol='messages'").first('upstream_model')).toBe('upstream-messages');
    expect(await testEnv.DB.prepare("SELECT actor_id FROM admin_audit WHERE action='channel_model.update'").first('actor_id')).toBe('c11-admin');
    expect((await app().request(target, { method: 'PATCH', headers: headers(), body: '{"version":2,"protocol":"messages"}' }, { DB: testEnv.DB })).status).toBe(400);
  });
  it('filters disabled candidates only on request and validates query fields', async () => {
    await create(); await testEnv.DB.prepare('UPDATE channels SET status=? WHERE id=?').bind('disabled', channelId).run();
    const response = await app().request(listUrl + '?activeOnly=true', { headers: { Cookie: adminCookie } }, { DB: testEnv.DB });
    expect(await response.json()).toMatchObject({ data: { items: [] } });
    for (const query of ['?protocol=chat&protocol=messages', '?activeOnly=1', '?groupId=c11-group']) expect((await app().request(listUrl + query, { headers: { Cookie: adminCookie } }, { DB: testEnv.DB })).status).toBe(400);
  });
  it('rejects stream overflow and rolls back writes if audit fails', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(MAPPING_BODY_MAX_BYTES + 1)); controller.close(); } });
    expect((await app().request(new Request(listUrl, { method: 'POST', headers: { ...headers(), 'Content-Length': '1' }, body }), undefined, { DB: testEnv.DB })).status).toBe(413);
    await testEnv.DB.exec("CREATE TRIGGER c11_audit_fail BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'private error'); END;");
    const response = await create(); expect(response.status).toBe(503); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM channel_models').first('count')).toBe(0);
  });
});
