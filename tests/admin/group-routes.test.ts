import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_GROUPS_PATH, GROUP_BODY_MAX_BYTES, createGroupRoutes } from '../../apps/worker/admin/group-routes';
import type { GroupView } from '../../apps/worker/admin/group-repository';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { issueCsrfToken } from '../../apps/worker/auth/csrf';
import { prepare } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const now = 1_788_645_000_000;
const origin = 'https://console.example';
const admin = 'c07-admin';
const user = 'c07-user';
const cookies = new Map<string, string>();
function app() { return createGroupRoutes({ database: testEnv.DB, now: () => now }); }
function request(query = '', asActor = admin) {
  return app().request(origin + ADMIN_GROUPS_PATH + query, { headers: { Cookie: cookies.get(asActor) ?? '', 'X-Actor-Id': admin } }, { DB: testEnv.DB });
}
async function page(response: Response): Promise<{ items: GroupView[]; nextCursor: string | null }> {
  expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
  return (await response.json<{ data: { items: GroupView[]; nextCursor: string | null } }>()).data;
}
beforeEach(async () => {
  cookies.clear();
  for (const id of ['c07-admin-group', 'c07-a', 'c07-b', 'c07-c']) {
    await prepare(testEnv.DB, 'INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES(?,?,?,1,?,?)',
      [id, id, id === 'c07-admin-group' ? 'active' : 'disabled', now, now]).run();
  }
  for (const id of [admin, user]) {
    await prepare(testEnv.DB, `INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES(?,?,?,?,'active','c07-admin-group',2,60,'bootstrap',?,?)`, [id, `${id}@example.invalid`, 'test-only-hash', id === admin ? 'admin' : 'user', now, now]).run();
    cookies.set(id, (await createCookieSession(testEnv.DB, id, now)).setCookie.split(';')[0]!);
  }
  for (const id of ['c07-channel-a', 'c07-channel-b']) {
    await prepare(testEnv.DB, `INSERT INTO channels(id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
      VALUES(?,?,?,?,'test','active',1,2,60,1,?,?)`, [id, id, 'https://example.invalid',
      JSON.stringify({ algorithm: 'A256GCM', format_version: 1, key_version: 'test', nonce: 'synthetic', ciphertext: 'PRIVATE CHANNEL CIPHERTEXT' }), now, now]).run();
  }
  await prepare(testEnv.DB, 'INSERT INTO channel_groups(channel_id,group_id) VALUES(?,?)', ['c07-channel-a', 'c07-a']).run();
});

describe('group list HTTP on native D1', () => {
  it('returns only safe group metadata and channel identifiers', async () => {
    const result = await page(await request('?status=disabled'));
    expect(result.items).toHaveLength(3);
    expect(result.items.find(item => item.id === 'c07-a')).toEqual({ id: 'c07-a', name: 'c07-a', status: 'disabled', version: 1,
      createdAt: now, updatedAt: now, channelIds: ['c07-channel-a'], billingMultiplier: '1' });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|ciphertext|base_url|password_hash/);
  });
  it('requires session and admin authorization', async () => {
    const anonymous = await request('', 'missing'); expect(anonymous.status).toBe(401); expect(anonymous.headers.get('Cache-Control')).toBe('no-store');
    const ordinary = await request('', user); expect(ordinary.status).toBe(403); expect(ordinary.headers.get('Cache-Control')).toBe('no-store');
  });
  it('paginates stable timestamp ties and binds the cursor to its status filter', async () => {
    const first = await page(await request('?status=disabled&limit=2'));
    const last = await page(await request(`?status=disabled&limit=2&cursor=${first.nextCursor}`));
    expect([...first.items, ...last.items].map(item => item.id)).toEqual(['c07-c', 'c07-b', 'c07-a']); expect(last.nextCursor).toBeNull();
    expect((await request(`?status=active&cursor=${first.nextCursor}`)).status).toBe(400);
  });
  it('rejects malformed/duplicate/unknown query fields', async () => {
    for (const query of ['?status=', '?status=other', '?status=active&status=disabled', '?limit=0', '?limit=101', '?limit=02',
      '?limit=1&limit=2', '?cursor=', '?cursor=bad!', '?actorId=c07-admin', '?cursor=a&cursor=b']) {
      const response = await request(query); expect(response.status, query).toBe(400); expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
  });
  it('resolves dependencies lazily and never reads Origin on GET', async () => {
    const getter = vi.fn(() => { throw new Error('PRIVATE ORIGIN'); });
    const source = vi.fn(() => Object.defineProperty({ database: testEnv.DB, now: () => now }, 'trustedOrigin', { get: getter }));
    const routes = createGroupRoutes(source); expect(source).not.toHaveBeenCalled();
    expect((await routes.request(origin + ADMIN_GROUPS_PATH, { headers: { Cookie: cookies.get(admin)! } }, { DB: testEnv.DB })).status).toBe(200);
    expect(source).toHaveBeenCalledOnce(); expect(getter).not.toHaveBeenCalled();
  });
  it('keeps unknown methods as 404', async () => {
    expect((await app().request(origin + ADMIN_GROUPS_PATH, { method: 'DELETE' }, { DB: testEnv.DB })).status).toBe(404);
  });
});

describe('group creation HTTP on native D1', () => {
  function headers(asActor = admin) {
    const csrf = issueCsrfToken();
    return { Cookie: `${cookies.get(asActor) ?? ''}; ${csrf.setCookie.split(';')[0]}`, Origin: origin,
      'X-CSRF-Token': csrf.token, 'Content-Type': 'application/json' };
  }
  function post(body: unknown, options: { headers?: Record<string, string>; raw?: BodyInit; query?: string } = {}) {
    const routes = createGroupRoutes({ database: testEnv.DB, now: () => now, trustedOrigin: async () => origin });
    return routes.request(origin + ADMIN_GROUPS_PATH + (options.query ?? ''), { method: 'POST', headers: options.headers ?? headers(),
      body: options.raw ?? JSON.stringify(body) }, { DB: testEnv.DB });
  }
  it('creates a group and deduplicated channel relations with same-transaction audit', async () => {
    const response = await post({ name: 'C07 Created', channelIds: ['c07-channel-b', 'c07-channel-a', 'c07-channel-b'] });
    expect(response.status).toBe(201); expect(response.headers.get('Cache-Control')).toBe('no-store');
    const result = await response.json<{ data: GroupView }>();
    expect(result.data).toMatchObject({ name: 'C07 Created', status: 'active', version: 1, channelIds: ['c07-channel-a', 'c07-channel-b'] });
    const audits = (await prepare(testEnv.DB, 'SELECT actor_id,action FROM admin_audit WHERE target_id=?', [result.data.id]).all()).rows;
    expect(audits.map(row => row.action).sort()).toEqual(['group.channel.attach', 'group.channel.attach', 'group.create']);
    expect(audits.every(row => row.actor_id === admin)).toBe(true);
  });
  it('allows only one concurrent creation of the same name', async () => {
    const responses = await Promise.all([post({ name: 'C07 Concurrent' }), post({ name: 'C07 Concurrent' })]);
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
  });
  it('checks permissions before Origin config and enforces CSRF', async () => {
    expect((await app().request(origin + ADMIN_GROUPS_PATH, { method: 'POST' }, { DB: testEnv.DB })).status).toBe(401);
    expect((await app().request(origin + ADMIN_GROUPS_PATH, { method: 'POST', headers: headers(user) }, { DB: testEnv.DB })).status).toBe(403);
    expect((await app().request(origin + ADMIN_GROUPS_PATH, { method: 'POST', headers: headers() }, { DB: testEnv.DB })).status).toBe(503);
    expect((await post({ name: 'Wrong Origin' }, { headers: { ...headers(), Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await post({ name: 'No CSRF' }, { headers: { ...headers(), 'X-CSRF-Token': '' } })).status).toBe(403);
  });
  it('rejects unknown fields, invalid references and malformed bodies', async () => {
    for (const value of [null, [], {}, { name: '' }, { name: 'bad', actorId: admin }, { name: 'bad', id: 'injected' },
      { name: 'bad', version: 2 }, { name: 'bad', status: 'other' }, { name: 'bad', channelIds: ['missing'] }]) {
      expect((await post(value)).status).toBe(400);
    }
    expect((await post({}, { raw: '{bad' })).status).toBe(400);
    expect((await post({ name: 'bad' }, { query: '?actorId=other' })).status).toBe(400);
  });
  it('caps actual bytes despite forged Content-Length', async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('界'.repeat(GROUP_BODY_MAX_BYTES / 2))); controller.close(); } });
    const response = await post({}, { raw: stream, headers: { ...headers(), 'Content-Length': '1' } });
    expect(response.status).toBe(413); expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('rolls back group and relation rows when audit storage fails', async () => {
    await testEnv.DB.exec("CREATE TRIGGER c07c_fail_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'private audit detail'); END");
    const response = await post({ name: 'C07 Rollback', channelIds: ['c07-channel-a'] });
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('private');
    expect(await prepare(testEnv.DB, 'SELECT id FROM groups WHERE name=?', ['C07 Rollback']).first()).toBeNull();
  });
});

describe('group update HTTP on native D1', () => {
  function headers(asActor = admin) {
    const csrf = issueCsrfToken();
    return { Cookie: `${cookies.get(asActor) ?? ''}; ${csrf.setCookie.split(';')[0]}`, Origin: origin,
      'X-CSRF-Token': csrf.token, 'Content-Type': 'application/json' };
  }
  function patch(body: unknown, options: { id?: string; headers?: Record<string, string>; raw?: BodyInit; query?: string } = {}) {
    const routes = createGroupRoutes({ database: testEnv.DB, now: () => now + 1, trustedOrigin: () => origin });
    return routes.request(`${origin}${ADMIN_GROUPS_PATH}/${options.id ?? 'c07-a'}${options.query ?? ''}`, {
      method: 'PATCH', headers: options.headers ?? headers(), body: options.raw ?? JSON.stringify(body) }, { DB: testEnv.DB });
  }
  it('updates name/status and replaces channel relationships with audit', async () => {
    const response = await patch({ version: 1, name: 'C07 Renamed', status: 'active', channelIds: ['c07-channel-b', 'c07-channel-b'] });
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    const result = await response.json<{ data: GroupView }>();
    expect(result.data).toMatchObject({ id: 'c07-a', name: 'C07 Renamed', status: 'active', version: 2, channelIds: ['c07-channel-b'] });
    expect((await prepare(testEnv.DB, 'SELECT channel_id FROM channel_groups WHERE group_id=?', ['c07-a']).all()).rows).toEqual([{ channel_id: 'c07-channel-b' }]);
    const audit = (await prepare(testEnv.DB, 'SELECT actor_id,action FROM admin_audit WHERE target_id=?', ['c07-a']).all()).rows;
    expect(audit.map(row => row.action).sort()).toEqual(['group.channel.attach', 'group.channel.detach', 'group.update']);
    expect(audit.every(row => row.actor_id === admin)).toBe(true);
  });
  it('uses CAS for concurrent updates without overwriting the winner or its relations', async () => {
    const responses = await Promise.all([
      patch({ version: 1, name: 'C07 First', channelIds: [] }), patch({ version: 1, name: 'C07 Second', channelIds: ['c07-channel-b'] }),
    ]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const saved = await prepare(testEnv.DB, 'SELECT name,version FROM groups WHERE id=?', ['c07-a']).first();
    const relations = (await prepare(testEnv.DB, 'SELECT channel_id FROM channel_groups WHERE group_id=?', ['c07-a']).all()).rows;
    expect((await patch({ version: 1, name: 'C07 Stale', channelIds: [] })).status).toBe(409);
    expect(await prepare(testEnv.DB, 'SELECT name,version FROM groups WHERE id=?', ['c07-a']).first()).toEqual(saved);
    expect((await prepare(testEnv.DB, 'SELECT channel_id FROM channel_groups WHERE group_id=?', ['c07-a']).all()).rows).toEqual(relations);
  });
  it('preserves the configured default group and the final usable administrator group', async () => {
    expect((await patch({ version: 1, status: 'disabled' }, { id: 'default' })).status).toBe(409);
    expect((await patch({ version: 1, status: 'disabled' }, { id: 'c07-admin-group' })).status).toBe(409);
    expect(await prepare(testEnv.DB, 'SELECT status FROM groups WHERE id=?', ['c07-admin-group']).first()).toEqual({ status: 'active' });
    expect((await prepare(testEnv.DB, "SELECT id FROM admin_audit WHERE action='group.update'").all()).rows).toEqual([]);
  });
  it('authenticates before Origin configuration and rejects CSRF bypass', async () => {
    const target = `${origin}${ADMIN_GROUPS_PATH}/c07-a`;
    expect((await app().request(target, { method: 'PATCH' }, { DB: testEnv.DB })).status).toBe(401);
    expect((await app().request(target, { method: 'PATCH', headers: headers(user) }, { DB: testEnv.DB })).status).toBe(403);
    expect((await app().request(target, { method: 'PATCH', headers: headers() }, { DB: testEnv.DB })).status).toBe(503);
    expect((await patch({ version: 1, name: 'Bad' }, { headers: { ...headers(), 'X-CSRF-Token': '' } })).status).toBe(403);
    expect((await patch({ version: 1, name: 'Bad' }, { headers: { ...headers(), Origin: 'https://evil.example' } })).status).toBe(403);
  });
  it('rejects bad versions/fields, unknown targets and oversized streamed JSON', async () => {
    for (const value of [{}, { version: 1 }, { version: 0, name: 'Bad' }, { version: '1', name: 'Bad' },
      { version: 1, actorId: admin }, { version: 1, name: '' }, { version: 1, status: 'other' }, { version: 1, channelIds: ['missing'] }]) {
      expect((await patch(value)).status).toBe(400);
    }
    expect((await patch({ version: 1, name: 'Missing' }, { id: 'missing' })).status).toBe(404);
    expect((await patch({ version: 1, name: 'Bad' }, { query: '?actorId=other' })).status).toBe(400);
    const response = await patch({}, { raw: ' '.repeat(GROUP_BODY_MAX_BYTES + 1), headers: { ...headers(), 'Content-Length': '1' } });
    expect(response.status).toBe(413); expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('rolls back group state and relationship replacement when audit fails', async () => {
    await testEnv.DB.exec("CREATE TRIGGER c07u_fail_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'private audit detail'); END");
    const response = await patch({ version: 1, name: 'Rollback', status: 'active', channelIds: ['c07-channel-b'] });
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('private');
    expect(await prepare(testEnv.DB, 'SELECT name,status,version FROM groups WHERE id=?', ['c07-a']).first()).toEqual({ name: 'c07-a', status: 'disabled', version: 1 });
    expect((await prepare(testEnv.DB, 'SELECT channel_id FROM channel_groups WHERE group_id=?', ['c07-a']).all()).rows).toEqual([{ channel_id: 'c07-channel-a' }]);
  });
});
