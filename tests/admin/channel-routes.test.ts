import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChannelRoutes, ADMIN_CHANNELS_PATH, CHANNEL_BODY_MAX_BYTES } from '../../apps/worker/admin/channel-routes';
import { createChannel, readChannelForForwarding } from '../../apps/worker/admin/channel-repository';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { issueCsrfToken } from '../../apps/worker/auth/csrf';
import { testEnv } from '../helpers/database';

const now = 1_788_632_000_000;
const origin = 'https://console.example.com';
let adminCookie: string;
let userCookie: string;
let channelIds: string[];
function app() { return createChannelRoutes({ now: () => now }); }
function get(query = '', cookie = adminCookie) {
  return app().request(origin + ADMIN_CHANNELS_PATH + query, { headers: { Cookie: cookie, 'X-Role': 'admin' } }, { DB: testEnv.DB });
}

beforeEach(async () => {
  await testEnv.DB.prepare("INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES ('c04-group','C04 group','active',1,0,0)").run();
  for (const [id, role] of [['c04-admin', 'admin'], ['c04-user', 'user']]) await testEnv.DB.prepare(`INSERT INTO users
    (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES (?,?,'test-only',?,'active','c04-group',2,60,'admin',0,0)`).bind(id, `${id}@example.invalid`, role).run();
  adminCookie = (await createCookieSession(testEnv.DB, 'c04-admin', now)).setCookie.split(';')[0]!;
  userCookie = (await createCookieSession(testEnv.DB, 'c04-user', now)).setCookie.split(';')[0]!;
  channelIds = [];
  for (let index = 0; index < 3; index++) {
    const saved = await createChannel(testEnv.DB, { name: `channel-${index}`, baseUrl: 'https://provider.example.com', upstreamKey: `private-test-key-${index}`,
      concurrencyLimit: 2, rpmLimit: 60, status: index === 2 ? 'disabled' : 'active' }, { actorId: 'c04-admin', operationId: `setup-${index}`, now });
    channelIds.push(saved.id);
  }
});

describe('administrator channel list HTTP', () => {
  it('returns safe paginated metadata with no credential configuration dependency', async () => {
    const trustedOrigin = vi.fn(() => { throw new Error('origin not configured'); });
    const route = createChannelRoutes({ now: () => now, trustedOrigin });
    const response = await route.request(origin + ADMIN_CHANNELS_PATH + '?limit=2', { headers: { Cookie: adminCookie } }, { DB: testEnv.DB });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const text = await response.text();
    expect(text).not.toMatch(/upstream_key|secret_key_version|upstreamKey|private-test-key-/);
    const body = JSON.parse(text);
    expect(body.data.items).toHaveLength(2);
    expect(body.data.items.every((item: { hasCredential: boolean }) => item.hasCredential)).toBe(true);
    const next = await get(`?limit=2&cursor=${body.data.nextCursor}`);
    const nextBody = await next.json() as { data: { items: { id: string }[]; nextCursor: null } };
    expect(nextBody.data.items).toHaveLength(1);
    expect(nextBody.data.nextCursor).toBeNull();
    expect(trustedOrigin).not.toHaveBeenCalled();
  });
  it('enforces session/admin before considering optional write configuration', async () => {
    expect((await get('', '')).status).toBe(401);
    expect((await get('', userCookie)).status).toBe(403);
    await testEnv.DB.prepare("UPDATE users SET status='disabled' WHERE id='c04-admin'").run();
    expect((await get()).status).toBe(401);
  });
  it('filters status and rejects malformed, duplicate or injected query fields', async () => {
    expect(await (await get('?status=disabled')).json()).toMatchObject({ data: { items: [{ status: 'disabled' }] } });
    for (const query of ['?status=other', '?status=active&status=disabled', '?limit=0', '?limit=101', '?limit=1&limit=2', '?cursor=bad!']) expect((await get(query)).status).toBe(400);
  });
  it('sanitizes database errors and rejects writes without trusted origin configuration', async () => {
    const broken = { prepare() { throw new Error('private database error'); } } as unknown as D1Database;
    const response = await app().request(origin + ADMIN_CHANNELS_PATH, { headers: { Cookie: adminCookie } }, { DB: broken });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private database');
    expect((await app().request(origin + ADMIN_CHANNELS_PATH, { method: 'POST', headers: { Cookie: adminCookie } }, { DB: testEnv.DB })).status).toBe(503);
  });
});

function writeHeaders(cookie = adminCookie) {
  const csrf = issueCsrfToken();
  return { Cookie: `${cookie}; ${csrf.setCookie.split(';')[0]}`, Origin: origin, 'X-CSRF-Token': csrf.token, 'Content-Type': 'application/json', 'X-Actor-Id': 'c04-user' };
}
const newChannel = { name: 'New channel', baseUrl: 'https://API.example.com:443/%76%31', upstreamKey: 'new-private-secret', concurrencyLimit: 3, rpmLimit: 90 };
function writes() { return createChannelRoutes({ now: () => now, trustedOrigin: origin }); }
async function rowCount() { return testEnv.DB.prepare('SELECT COUNT(*) AS count FROM channels').first('count'); }

describe('administrator channel creation HTTP', () => {
  it('logs the original database write error with the response request ID', async () => {
    const original = new Error('Channel database write failed');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const route = createChannelRoutes({ now: () => now, trustedOrigin: origin });
      const database = {
        prepare: (sql: string) => testEnv.DB.prepare(sql),
        batch: async () => { throw original; },
      } as unknown as D1Database;
      const response = await route.request(origin + ADMIN_CHANNELS_PATH, {
        method: 'POST', headers: writeHeaders(), body: JSON.stringify(newChannel),
      }, { DB: database });
      const body = await response.json() as { error: { code: string }; request_id: string };
      expect(response.status).toBe(503);
      expect(log).toHaveBeenCalledWith({
        event: 'API request failed',
        request_id: body.request_id, code: 'service_unavailable', status: 503,
        errors: [
          expect.objectContaining({ name: 'ApiError', message: 'Service temporarily unavailable.', stack: expect.any(String) }),
          { name: original.name, message: original.message, stack: original.stack },
        ],
      });
      // Workers Logs receives JSON data, not the native Error object's hidden fields.
      const serialized = JSON.parse(JSON.stringify(log.mock.calls.at(-1)?.[0]));
      expect(serialized.errors[1]).toEqual({ name: original.name, message: original.message, stack: original.stack });
      expect(JSON.stringify(body)).not.toContain(original.message);
      expect(await rowCount()).toBe(3);
    } finally { log.mockRestore(); }
  });
  it('creates normalized configuration and atomic audit with no secrets in the response', async () => {
    const response = await writes().request(origin + ADMIN_CHANNELS_PATH, { method: 'POST', headers: writeHeaders(), body: JSON.stringify(newChannel) }, { DB: testEnv.DB });
    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).not.toMatch(/new-private-secret|upstream_key|secret_key_version/);
    const body = JSON.parse(text);
    expect(body.data).toMatchObject({ hasCredential: true, baseUrl: 'https://api.example.com/%76%31', configVersion: 1 });
    expect((await readChannelForForwarding(testEnv.DB, body.data.id))?.upstreamKey).toBe(newChannel.upstreamKey);
    expect(await testEnv.DB.prepare('SELECT actor_id FROM admin_audit WHERE target_id=?').bind(body.data.id).first('actor_id')).toBe('c04-admin');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('does not resolve origin configuration for anonymous/non-admin requests', async () => {
    const trustedOrigin = vi.fn(() => { throw new Error('unconfigured origin'); });
    const route = createChannelRoutes({ now: () => now, trustedOrigin });
    expect((await route.request(origin + ADMIN_CHANNELS_PATH, { method: 'POST' }, { DB: testEnv.DB })).status).toBe(401);
    expect((await route.request(origin + ADMIN_CHANNELS_PATH, { method: 'POST', headers: writeHeaders(userCookie) }, { DB: testEnv.DB })).status).toBe(403);
    expect(trustedOrigin).not.toHaveBeenCalled();
  });
  it('rejects unsafe targets, empty keys, invalid limits and server configuration injection', async () => {
    for (const extra of [{ baseUrl: 'ftp://api.example.com' }, { baseUrl: '/v1' }, { upstreamKey: '' }, { concurrencyLimit: -1 }, { rpmLimit: 0.5 }]) {
      expect((await writes().request(origin + ADMIN_CHANNELS_PATH, { method: 'POST', headers: writeHeaders(), body: JSON.stringify({ ...newChannel, ...extra }) }, { DB: testEnv.DB })).status).toBe(400);
    }
    expect(await rowCount()).toBe(3);
  });
  it('accepts private HTTP targets and extra fields without writing server-owned values', async () => {
    const response = await writes().request(origin + ADMIN_CHANNELS_PATH, {
      method: 'POST', headers: writeHeaders(), body: JSON.stringify({ ...newChannel, baseUrl: 'http://127.0.0.1:8080/v1?tenant=a',
        actorId: 'not-the-admin', upstream_key: 'injected-key', configVersion: 100, extension: true }),
    }, { DB: testEnv.DB });
    expect(response.status).toBe(201);
    const { data } = await response.json<{ data: { id: string; configVersion: number; baseUrl: string } }>();
    expect(data).toMatchObject({ configVersion: 1, baseUrl: 'http://127.0.0.1:8080/v1?tenant=a' });
    expect((await readChannelForForwarding(testEnv.DB, data.id))!.upstreamKey).toBe(newChannel.upstreamKey);
    expect(await testEnv.DB.prepare('SELECT actor_id FROM admin_audit WHERE target_id=?').bind(data.id).first('actor_id')).toBe('c04-admin');
  });
  it('checks CSRF and streamed byte limits, and rolls back audit failures', async () => {
    const forbidden = await writes().request(origin + ADMIN_CHANNELS_PATH, { method: 'POST', headers: { ...writeHeaders(), Origin: 'https://attacker.example' }, body: JSON.stringify(newChannel) }, { DB: testEnv.DB });
    expect(forbidden.status).toBe(403);
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(CHANNEL_BODY_MAX_BYTES + 1)); controller.close(); } });
    expect((await writes().request(new Request(origin + ADMIN_CHANNELS_PATH, { method: 'POST', headers: { ...writeHeaders(), 'Content-Length': '1' }, body }), undefined, { DB: testEnv.DB })).status).toBe(413);
    await testEnv.DB.exec("CREATE TRIGGER c04c_audit_failure BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'private failure'); END;");
    expect((await writes().request(origin + ADMIN_CHANNELS_PATH, { method: 'POST', headers: writeHeaders(), body: JSON.stringify(newChannel) }, { DB: testEnv.DB })).status).toBe(503);
    expect(await rowCount()).toBe(3);
  });
});

describe('administrator channel update HTTP', () => {
  const target = () => `${origin}${ADMIN_CHANNELS_PATH}/${channelIds[0]}`;
  it('disables/enables via CAS without replacing the existing secret', async () => {
    const route = createChannelRoutes({ now: () => now, trustedOrigin: origin });
    const before = await testEnv.DB.prepare('SELECT upstream_key FROM channels WHERE id=?').bind(channelIds[0]).first('upstream_key');
    const disabled = await route.request(target(), { method: 'PATCH', headers: writeHeaders(), body: '{"version":1,"status":"disabled"}' }, { DB: testEnv.DB });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ data: { status: 'disabled', configVersion: 2, hasCredential: true } });
    const enabled = await route.request(target(), { method: 'PATCH', headers: writeHeaders(), body: '{"version":2,"status":"active","rpmLimit":120}' }, { DB: testEnv.DB });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({ data: { status: 'active', configVersion: 3, rpmLimit: 120 } });
    expect(await testEnv.DB.prepare('SELECT upstream_key FROM channels WHERE id=?').bind(channelIds[0]).first('upstream_key')).toBe(before);
  });
  it('replaces credentials only explicitly and never returns the stored key', async () => {
    const route = createChannelRoutes({ now: () => now, trustedOrigin: () => origin });
    const response = await route.request(target(), { method: 'PATCH', headers: writeHeaders(), body: '{"version":1,"upstreamKey":"rotated-private-secret"}' }, { DB: testEnv.DB });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toMatch(/rotated-private-secret|upstream_key|secret_key_version/);
    expect((await readChannelForForwarding(testEnv.DB, channelIds[0]!))?.upstreamKey).toBe('rotated-private-secret');
  });
  it('rejects empty/null/clear keys, invalid inputs and missing/non-admin/CSRF authorization', async () => {
    for (const patch of [{ version: 1 }, { version: 0, status: 'active' }, { version: 1, upstreamKey: '' }, { version: 1, upstreamKey: null },
      { version: 1, clear: true }, { version: 1, actorId: 'c04-admin' }, { version: 1, baseUrl: 'ftp://api.example.com' }, { version: 1, status: 'removed' }]) {
      expect((await writes().request(target(), { method: 'PATCH', headers: writeHeaders(), body: JSON.stringify(patch) }, { DB: testEnv.DB })).status).toBe(400);
    }
    expect((await writes().request(target(), { method: 'PATCH' }, { DB: testEnv.DB })).status).toBe(401);
    expect((await writes().request(target(), { method: 'PATCH', headers: writeHeaders(userCookie), body: '{"version":1,"status":"disabled"}' }, { DB: testEnv.DB })).status).toBe(403);
    expect((await writes().request(target(), { method: 'PATCH', headers: { Cookie: adminCookie }, body: '{"version":1,"status":"disabled"}' }, { DB: testEnv.DB })).status).toBe(403);
    expect(await testEnv.DB.prepare('SELECT config_version FROM channels WHERE id=?').bind(channelIds[0]).first('config_version')).toBe(1);
  });
  it('returns one concurrent success and one conflict, with one audit', async () => {
    const route = writes();
    const responses = await Promise.all([5, 9].map((priority) => route.request(target(), { method: 'PATCH', headers: writeHeaders(), body: JSON.stringify({ version: 1, priority }) }, { DB: testEnv.DB })));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM admin_audit WHERE target_id=? AND action=?').bind(channelIds[0], 'channel.update').first('count')).toBe(1);
    expect((await route.request(target(), { method: 'PATCH', headers: writeHeaders(), body: '{"version":1,"status":"disabled"}' }, { DB: testEnv.DB })).status).toBe(409);
  });
  it('rolls back audit failures and rejects oversized update streams', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(CHANNEL_BODY_MAX_BYTES + 1)); controller.close(); } });
    expect((await writes().request(new Request(target(), { method: 'PATCH', headers: { ...writeHeaders(), 'Content-Length': '1' }, body }), undefined, { DB: testEnv.DB })).status).toBe(413);
    await testEnv.DB.exec("CREATE TRIGGER c05_audit_failure BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'private failure'); END;");
    const response = await writes().request(target(), { method: 'PATCH', headers: writeHeaders(), body: '{"version":1,"status":"disabled"}' }, { DB: testEnv.DB });
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await testEnv.DB.prepare('SELECT status,config_version FROM channels WHERE id=?').bind(channelIds[0]).first()).toEqual({ status: 'active', config_version: 1 });
  });
});
