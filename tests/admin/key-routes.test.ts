import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdminKeyRoutes, ADMIN_KEY_REVOKE_BODY_MAX_BYTES } from '../../apps/worker/admin/key-routes';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { issueCsrfToken } from '../../apps/worker/auth/csrf';
import { testEnv } from '../helpers/database';

const now = 1_788_631_000_000;
const origin = 'https://console.example.com';
let adminCookie: string;
let userCookie: string;
let csrf: ReturnType<typeof issueCsrfToken>;
function app() { return createAdminKeyRoutes({ now: () => now, trustedOrigin: origin }); }
function headers(cookie = adminCookie) {
  return { 'Content-Type': 'application/json', Origin: origin, Cookie: `${cookie}; ${csrf.setCookie.split(';')[0]}`,
    'X-CSRF-Token': csrf.token, 'X-Owner-Id': 'attacker-owner', 'X-Actor-Id': 'owner' };
}
const url = (id = 'a28-key') => `${origin}/api/v1/admin/keys/${id}/revoke`;
async function state() {
  return {
    key: await testEnv.DB.prepare("SELECT status,version,updated_at FROM api_keys WHERE id='a28-key'").first(),
    audits: (await testEnv.DB.prepare("SELECT * FROM admin_audit WHERE action='api_keys.revoke'").all()).results,
  };
}

describe('administrator Key revocation with native D1 and Hono', () => {
  beforeEach(async () => {
    for (const id of ['a28-admin-group', 'a28-owner-group']) await testEnv.DB.prepare("INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES (?,?,'active',1,0,0)").bind(id, id).run();
    for (const [id, role, group] of [['a28-admin', 'admin', 'a28-admin-group'], ['a28-owner', 'user', 'a28-owner-group']]) {
      await testEnv.DB.prepare(`INSERT INTO users (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
        VALUES (?,?,'test-only',?,'active',?,2,60,'admin',0,0)`).bind(id, `${id}@example.invalid`, role, group).run();
    }
    adminCookie = (await createCookieSession(testEnv.DB, 'a28-admin', now)).setCookie.split(';')[0]!;
    userCookie = (await createCookieSession(testEnv.DB, 'a28-owner', now)).setCookie.split(';')[0]!;
    csrf = issueCsrfToken();
    await testEnv.DB.prepare(`INSERT INTO api_keys (id,user_id,key_hash,display_prefix,name,status,expires_at,created_at,updated_at,version)
      VALUES ('a28-key','a28-owner',?,'s2a_key_ABCDEFGH','test-key','active',?,0,0,1)`).bind('a'.repeat(64), now - 1).run();
  });

  it('revokes an expired Key of a disabled owner/group and records only a sanitized trusted-actor audit', async () => {
    await testEnv.DB.prepare("UPDATE users SET status='disabled' WHERE id='a28-owner'").run();
    await testEnv.DB.prepare("UPDATE groups SET status='disabled' WHERE id='a28-owner-group'").run();
    const response = await app().request(url(), { method: 'POST', headers: headers(), body: '{"version":1}' }, { DB: testEnv.DB });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ data: { kind: 'revoked', key: { id: 'a28-key', userId: 'a28-owner', status: 'revoked', version: 2 } } });
    expect(text).not.toMatch(/key_hash|token|creation_fingerprint/);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const saved = await state();
    expect(saved.audits).toHaveLength(1);
    expect(saved.audits[0]).toMatchObject({ actor_id: 'a28-admin', target_id: 'a28-key' });
    expect(saved.audits[0]?.operation_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.stringify(saved.audits)).not.toContain('a'.repeat(64));
  });

  it('replays concurrent or repeated revocations without another write or audit', async () => {
    const route = app();
    const responses = await Promise.all([1, 2].map(() => route.request(url(), { method: 'POST', headers: headers(), body: '{"version":1}' }, { DB: testEnv.DB })));
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const bodies = await Promise.all(responses.map((response) => response.json())) as { data: { kind: string } }[];
    expect(bodies.map((body) => body.data.kind).sort()).toEqual(['already_revoked', 'revoked']);
    const before = await state();
    expect((await route.request(url(), { method: 'POST', headers: headers(), body: '{"version":1}' }, { DB: testEnv.DB })).status).toBe(200);
    expect(await state()).toEqual(before);
    expect(before.audits).toHaveLength(1);
  });

  it('rejects anonymous/users and missing CSRF before reading the body', async () => {
    expect((await app().request(url(), { method: 'POST' }, { DB: testEnv.DB })).status).toBe(401);
    expect((await app().request(url(), { method: 'POST', headers: headers(userCookie), body: '{"version":1}' }, { DB: testEnv.DB })).status).toBe(403);
    const pull = vi.fn(() => { throw new Error('Do not read'); });
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const response = await app().request(new Request(url(), { method: 'POST', headers: { Cookie: adminCookie }, body }), undefined, { DB: testEnv.DB });
    expect(response.status).toBe(403);
    expect(pull).not.toHaveBeenCalled();
    expect((await state()).audits).toEqual([]);
  });

  it('rejects stale versions, missing Keys, malformed IDs and owner/actor injection', async () => {
    expect((await app().request(url(), { method: 'POST', headers: headers(), body: '{"version":2}' }, { DB: testEnv.DB })).status).toBe(409);
    expect((await app().request(url('missing'), { method: 'POST', headers: headers(), body: '{"version":1}' }, { DB: testEnv.DB })).status).toBe(404);
    for (const body of ['{}', 'null', '{bad', '{"version":0}', '{"version":1.5}', '{"version":1,"userId":"a28-admin"}', '{"version":1,"actorId":"a28-admin"}', '{"version":1,"operationId":"client"}']) {
      expect((await app().request(url(), { method: 'POST', headers: headers(), body }, { DB: testEnv.DB })).status).toBe(400);
    }
    for (const id of ['bad%0A', 'a%2Fb', 's2a_key_fake', 'x'.repeat(129)]) expect((await app().request(url(id), { method: 'POST', headers: headers(), body: '{"version":1}' }, { DB: testEnv.DB })).status).toBe(400);
    expect((await state()).audits).toEqual([]);
  });

  it('rejects streamed byte overflow even when Content-Length lies', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(' '.repeat(ADMIN_KEY_REVOKE_BODY_MAX_BYTES + 1))); controller.close(); } });
    const response = await app().request(new Request(url(), { method: 'POST', headers: { ...headers(), 'Content-Length': '1' }, body }), undefined, { DB: testEnv.DB });
    expect(response.status).toBe(413);
    expect((await state()).key).toMatchObject({ status: 'active', version: 1 });
  });

  it('rolls back on audit failure and zero-row writes', async () => {
    const before = await state();
    await testEnv.DB.exec("CREATE TRIGGER a28_audit_failure BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'private audit error'); END;");
    const failure = await app().request(url(), { method: 'POST', headers: headers(), body: '{"version":1}' }, { DB: testEnv.DB });
    expect(failure.status).toBe(503);
    expect(await failure.text()).not.toContain('private audit');
    expect(await state()).toEqual(before);
    await testEnv.DB.exec('DROP TRIGGER a28_audit_failure;');
    await testEnv.DB.exec("CREATE TRIGGER a28_ignore_key BEFORE UPDATE ON api_keys BEGIN SELECT RAISE(IGNORE); END;");
    expect((await app().request(url(), { method: 'POST', headers: headers(), body: '{"version":1}' }, { DB: testEnv.DB })).status).toBe(409);
    expect(await state()).toEqual(before);
  });

  it('rechecks administrator authority inside the write transaction', async () => {
    const database = {
      prepare: testEnv.DB.prepare.bind(testEnv.DB),
      async batch(statements: D1PreparedStatement[]) {
        await testEnv.DB.prepare("UPDATE users SET role='user' WHERE id='a28-admin'").run();
        return testEnv.DB.batch(statements);
      },
    } as unknown as D1Database;
    const response = await app().request(url(), { method: 'POST', headers: headers(), body: '{"version":1}' }, { DB: database });
    expect(response.status).toBe(403);
    expect((await state()).key).toMatchObject({ status: 'active', version: 1 });
    expect((await state()).audits).toEqual([]);
  });
});
