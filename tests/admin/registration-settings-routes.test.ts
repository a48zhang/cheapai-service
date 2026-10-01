import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRegistrationSettingsRoutes, ADMIN_REGISTRATION_SETTINGS_PATH as path, REGISTRATION_SETTINGS_BODY_MAX_BYTES } from '../../apps/worker/admin/registration-settings-routes';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { issueCsrfToken } from '../../apps/worker/auth/csrf';
import { testEnv } from '../helpers/database';

const origin = 'https://console.example.com';
let adminCookie: string;
let userCookie: string;
let csrfHeaders: Record<string, string>;
const deps = { trustedOrigin: origin, emailAvailable: true, now: () => 2000 };
const bindings = () => ({ DB: testEnv.DB });
const app = (emailAvailable = true) => createRegistrationSettingsRoutes({ ...deps, emailAvailable });
function patchHeaders(cookie = adminCookie) { return { ...csrfHeaders, Cookie: `${cookie}; ${csrfHeaders.Cookie}`, 'Content-Type': 'application/json' }; }
async function settings() { return testEnv.DB.prepare("SELECT value_json,version FROM settings WHERE key='registration'").first(); }
async function audits() { return (await testEnv.DB.prepare("SELECT * FROM admin_audit WHERE action='registration.settings.update'").all()).results; }

describe('administrator registration settings HTTP', () => {
  beforeEach(async () => {
    await testEnv.DB.prepare("INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES ('a10-group','A10 group','active',1,0,0)").run();
    for (const [id, role] of [['a10-admin', 'admin'], ['a10-user', 'user']]) {
      await testEnv.DB.prepare(`INSERT INTO users (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
        VALUES (?,?,'test-only',?,'active','a10-group',2,60,'admin',0,0)`).bind(id, `${id}@example.invalid`, role).run();
    }
    await testEnv.DB.prepare(`INSERT INTO settings (key,value_json,version,updated_at) VALUES ('registration',?,1,1000)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,version=1,updated_at=1000`).bind(JSON.stringify({ registrationMode: 'closed', emailVerificationEnabled: true })).run();
    adminCookie = (await createCookieSession(testEnv.DB, 'a10-admin', 1000)).setCookie.split(';')[0]!;
    userCookie = (await createCookieSession(testEnv.DB, 'a10-user', 1000)).setCookie.split(';')[0]!;
    const nonce = issueCsrfToken();
    csrfHeaders = { Origin: origin, Cookie: nonce.setCookie.split(';')[0]!, 'X-CSRF-Token': nonce.token };
  });

  it('returns actual open settings/version and readiness problems to an administrator', async () => {
    await testEnv.DB.prepare("UPDATE settings SET value_json=?,version=7 WHERE key='registration'").bind(JSON.stringify({ registrationMode: 'open', emailVerificationEnabled: true })).run();
    const response = await app(false).request(origin + path, { headers: { Cookie: adminCookie } }, bindings());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { registrationMode: 'open', emailVerificationEnabled: true, version: 7, updatedAt: 1000, valid: true, ready: false, emailAvailable: false, issues: ['email_unavailable'] }, request_id: expect.any(String) });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('reports missing/corrupt settings without exposing arbitrary raw JSON', async () => {
    await testEnv.DB.prepare("UPDATE settings SET value_json=? WHERE key='registration'").bind(JSON.stringify({ registrationMode: 'broken', emailVerificationEnabled: true, accidentalSecret: 'do-not-expose' })).run();
    const response = await app().request(origin + path, { headers: { Cookie: adminCookie } }, bindings());
    const text = await response.text();
    expect(text).not.toContain('do-not-expose');
    expect(JSON.parse(text)).toMatchObject({ data: { valid: false, ready: false, version: 1, issues: ['invalid_settings'] } });
    await testEnv.DB.prepare("DELETE FROM settings WHERE key='registration'").run();
    const missing = await app().request(origin + path, { headers: { Cookie: adminCookie } }, bindings());
    expect(await missing.json()).toMatchObject({ data: { version: null, registrationMode: null, issues: ['missing_settings'] } });
  });

  it('requires an active authenticated administrator and ignores forged role claims', async () => {
    for (const method of ['GET', 'PATCH']) {
      const anonymous = await app().request(origin + path, { method, headers: { 'X-Role': 'admin' } }, bindings());
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get('Cache-Control')).toBe('no-store');
      const denied = await app().request(origin + path, { method, headers: { Cookie: userCookie, 'X-Role': 'admin' } }, bindings());
      expect(denied.status).toBe(403);
    }
    await testEnv.DB.prepare("UPDATE users SET status='disabled' WHERE id='a10-admin'").run();
    expect((await app().request(origin + path, { headers: { Cookie: adminCookie } }, bindings())).status).toBe(401);
  });

  it('updates only the supplied policy field and audits the actor from trusted session context', async () => {
    const response = await app().request(origin + path, { method: 'PATCH', headers: patchHeaders(), body: JSON.stringify({ version: 1, registrationMode: 'invite' }) }, bindings());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { registrationMode: 'invite', emailVerificationEnabled: true, version: 2, ready: true } });
    const logs = await audits();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actor_id: 'a10-admin', target_id: 'registration' });
    expect(logs[0]?.operation_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('rejects missing CSRF before reading PATCH bodies', async () => {
    const pull = vi.fn(() => { throw new Error('must not read body'); });
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const response = await app().request(new Request(origin + path, { method: 'PATCH', headers: { Cookie: adminCookie }, body }), undefined, bindings());
    expect(response.status).toBe(403);
    expect(pull).not.toHaveBeenCalled();
    expect(await audits()).toEqual([]);
  });

  it('does not accept client readiness/actor fields or invalid versions/policies', async () => {
    for (const body of [{ version: 1 }, { version: 0, registrationMode: 'open' }, { version: '1', registrationMode: 'open' },
      { version: 1, registrationMode: 'other' }, { version: 1, emailVerificationEnabled: 'false' },
      { version: 1, registrationMode: 'open', emailAvailable: true }, { version: 1, registrationMode: 'open', actorId: 'a10-admin' }]) {
      expect((await app(false).request(origin + path, { method: 'PATCH', headers: patchHeaders(), body: JSON.stringify(body) }, bindings())).status).toBe(400);
    }
    expect((await app(false).request(origin + path, { method: 'PATCH', headers: patchHeaders(), body: JSON.stringify({ version: 1, registrationMode: 'open' }) }, bindings())).status).toBe(400);
    expect((await app(false).request(origin + path, { method: 'PATCH', headers: patchHeaders(), body: JSON.stringify({ version: 1, registrationMode: 'open', emailVerificationEnabled: false }) }, bindings())).status).toBe(200);
    expect(await audits()).toHaveLength(1);
  });

  it('uses real streamed byte limits despite forged Content-Length and rejects broken JSON', async () => {
    const oversized = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(' '.repeat(REGISTRATION_SETTINGS_BODY_MAX_BYTES + 1))); controller.close(); } });
    const response = await app().request(new Request(origin + path, { method: 'PATCH', headers: { ...patchHeaders(), 'Content-Length': '1' }, body: oversized }), undefined, bindings());
    expect(response.status).toBe(413);
    expect((await app().request(origin + path, { method: 'PATCH', headers: patchHeaders(), body: '{bad' }, bindings())).status).toBe(400);
    expect((await settings())?.version).toBe(1);
    expect(await audits()).toEqual([]);
  });

  it('returns 409 on stale/concurrent versions and keeps one committed audit', async () => {
    const route = app();
    const responses = await Promise.all(['open', 'invite'].map((registrationMode) => route.request(origin + path, { method: 'PATCH', headers: patchHeaders(), body: JSON.stringify({ version: 1, registrationMode }) }, bindings())));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect((await settings())?.version).toBe(2);
    expect(await audits()).toHaveLength(1);
  });

  it('rolls back failed audit writes and resolves trusted configuration lazily', async () => {
    const resolver = vi.fn((_env: { DB: D1Database; MAIL_READY: boolean }) => ({ ...deps, emailAvailable: _env.MAIL_READY }));
    const route = createRegistrationSettingsRoutes(resolver);
    expect(resolver).not.toHaveBeenCalled();
    await testEnv.DB.exec("CREATE TRIGGER a10_fail_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT,'private audit failure'); END;");
    const response = await route.request(origin + path, { method: 'PATCH', headers: patchHeaders(), body: JSON.stringify({ version: 1, registrationMode: 'open' }) }, { DB: testEnv.DB, MAIL_READY: true });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private audit');
    expect((await settings())?.version).toBe(1);
    expect(await audits()).toEqual([]);
    expect(resolver).toHaveBeenCalledOnce();
  });

  it('does not resolve Origin for GET and reports missing email readiness as diagnostics', async () => {
    const trustedOrigin = vi.fn(() => { throw new Error('invalid origin configuration'); });
    const route = createRegistrationSettingsRoutes({ now: deps.now, emailAvailable: false, trustedOrigin });
    const response = await route.request(origin + path, { headers: { Cookie: adminCookie } }, bindings());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ data: { emailAvailable: false } });
    expect(trustedOrigin).not.toHaveBeenCalled();
    const omitted = createRegistrationSettingsRoutes({ now: deps.now, emailAvailable: false });
    expect((await omitted.request(origin + path, { headers: { Cookie: adminCookie } }, bindings())).status).toBe(200);
  });

  it('authenticates before resolving PATCH Origin, with missing or failing config as authenticated 503', async () => {
    const trustedOrigin = vi.fn(() => { throw new Error('SECRET ORIGIN DETAILS'); });
    const route = createRegistrationSettingsRoutes({ now: deps.now, emailAvailable: true, trustedOrigin });
    const body = JSON.stringify({ version: 1, registrationMode: 'closed' });
    const missing = await route.request(origin + path, { method: 'PATCH', body }, bindings());
    expect(missing.status).toBe(401); expect(missing.headers.get('Cache-Control')).toBe('no-store');
    const ordinary = await route.request(origin + path, { method: 'PATCH', headers: patchHeaders(userCookie), body }, bindings());
    expect(ordinary.status).toBe(403); expect(trustedOrigin).not.toHaveBeenCalled();
    const badConfig = await route.request(origin + path, { method: 'PATCH', headers: patchHeaders(), body }, bindings());
    expect(badConfig.status).toBe(503); expect(await badConfig.text()).not.toContain('SECRET');
    const omitted = createRegistrationSettingsRoutes({ now: deps.now, emailAvailable: true });
    expect((await omitted.request(origin + path, { method: 'PATCH', headers: patchHeaders(), body }, bindings())).status).toBe(503);
    const lazy = createRegistrationSettingsRoutes({ now: deps.now, emailAvailable: true, trustedOrigin: async () => origin });
    expect((await lazy.request(origin + path, { method: 'PATCH', headers: patchHeaders(), body }, bindings())).status).toBe(200);
  });
});
