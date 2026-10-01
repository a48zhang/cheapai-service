import { describe, expect, it } from 'vitest';
import { app } from '../../apps/worker/app';
import type { Env } from '../../apps/worker/env';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { testEnv } from '../helpers/database';

const origin = 'https://console.example';
interface Client { cookie: string; csrf: string; csrfCookie: string }
const bindings = (): Env => ({ ...testEnv, ENVIRONMENT: 'local', PUBLIC_BASE_URL: origin, EMAIL_VERIFICATION_READY: false });
function call(path: string, options: { method?: string; body?: unknown; client?: Client; env?: Env; headers?: Record<string, string> } = {}) {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (options.client) {
    headers.Cookie = [options.client.cookie, options.client.csrfCookie].filter(Boolean).join('; ');
    if (method !== 'GET') headers['X-CSRF-Token'] = options.client.csrf;
  }
  if (method !== 'GET') headers.Origin = origin;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  return app.fetch(new Request(origin + path, { method, headers: { ...headers, ...options.headers },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }), options.env ?? bindings());
}
async function data<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const envelope = await response.json<{ data: T; request_id: string }>();
  expect(envelope.request_id).toEqual(expect.any(String));
  return envelope.data;
}
async function nonce(): Promise<Client> {
  const response = await call('/api/v1/settings/public');
  const value = await data<{ csrfToken: string }>(response);
  return { cookie: '', csrf: value.csrfToken, csrfCookie: response.headers.get('Set-Cookie')!.split(';')[0]! };
}
async function fixture(id: string, role: 'user' | 'admin'): Promise<Client> {
  const now = Date.now();
  await testEnv.DB.prepare(`INSERT INTO users
    (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES (?,?,?,?,'active','default',2,60,'bootstrap',?,?)`).bind(id, `${id}@example.invalid`, 'fixture-only-hash', role, now, now).run();
  const client = await nonce();
  client.cookie = (await createCookieSession(testEnv.DB, id, Date.now())).setCookie.split(';')[0]!;
  return client;
}

describe('complete identity and management app entry with native D1/DO', () => {
  it('runs nonce/register/me and the personal-key lifecycle, then fixture-admin user/code/settings management', async () => {
    await testEnv.DB.prepare("UPDATE settings SET value_json=? WHERE key='registration'")
      .bind('{"registrationMode":"open","emailVerificationEnabled":false}').run();
    const client = await nonce();
    const password = 'a31-real-password-123456';
    const registration = await call('/api/v1/auth/register', { method: 'POST', client,
      body: { email: 'a31-registered@example.invalid', password } });
    const registered = await data<{ user: { id: string }; session: string }>(registration, 201);
    expect(registered.session).toBe('created');
    client.cookie = registration.headers.get('Set-Cookie')!.split(';')[0]!;
    const me = await data<{ id: string; balance_units: string }>(await call('/api/v1/auth/me', { client }));
    expect(me).toMatchObject({ id: registered.user.id, balance_units: '0' });
    expect((await call('/api/v1/admin/users', { client })).status).toBe(403);

    const keyPayload = { name: 'Integration key', allowedModels: [] };
    const key = await data<{ kind: string; token: string; key: { id: string; version: number } }>(await call('/api/v1/keys',
      { method: 'POST', client, body: keyPayload, headers: { 'Idempotency-Key': 'a31-key-create' } }), 201);
    expect(key.token).toMatch(/^s2a_key_/);
    const replay = await data<{ kind: string; key: { id: string }; token?: string }>(await call('/api/v1/keys',
      { method: 'POST', client, body: keyPayload, headers: { 'Idempotency-Key': 'a31-key-create' } }));
    expect(replay.kind).toBe('replayed'); expect(replay.key.id).toBe(key.key.id); expect(replay).not.toHaveProperty('token');
    const keyList = await data<{ items: { id: string }[] }>(await call('/api/v1/keys', { client }));
    expect(keyList.items).toHaveLength(1); expect(JSON.stringify(keyList)).not.toContain(key.token);
    const updatedKey = await data<{ version: number; name: string }>(await call(`/api/v1/keys/${key.key.id}`,
      { method: 'PATCH', client, body: { version: 1, name: 'Renamed integration key' } }));
    expect(updatedKey).toMatchObject({ version: 2, name: 'Renamed integration key' });
    await data(await call(`/api/v1/keys/${key.key.id}/revoke`, { method: 'POST', client, body: { version: 2 } }));
    expect(await data(await call(`/api/v1/keys/${key.key.id}`, { client }))).toMatchObject({ status: 'revoked' });

    // Test fixture only. Production has no public promotion endpoint; A29 owns
    // administrator bootstrap. The same session must observe authoritative role.
    await testEnv.DB.prepare("UPDATE users SET role='admin' WHERE id=?").bind(registered.user.id).run();
    const users = await data<{ items: { balance_units: string }[] }>(await call('/api/v1/admin/users', { client }));
    expect(users.items.every((item) => typeof item.balance_units === 'string')).toBe(true);
    const created = await data<{ id: string; role: string; balance_units: string }>(await call('/api/v1/admin/users',
      { method: 'POST', client, body: { email: 'a31-created@example.invalid', password: 'a31-created-password-1234' } }), 201);
    expect(created).toMatchObject({ role: 'user', balance_units: '0' });
    await data(await call(`/api/v1/admin/users/${created.id}`, { method: 'PATCH', client, body: { version: 1, rpmLimit: 30 } }));
    expect((await call(`/api/v1/admin/users/${created.id}`, { method: 'PATCH', client, body: { version: 1, rpmLimit: 99 } })).status).toBe(409);
    expect(await testEnv.DB.prepare('SELECT rpm_limit,version FROM users WHERE id=?').bind(created.id).first()).toEqual({ rpm_limit: 30, version: 2 });

    const codesPayload = { quantity: 2, expiresAt: Date.now() + 600_000 };
    const codes = await data<{ batchId: string; codes: { id: string; token: string }[] }>(await call('/api/v1/admin/registration/codes',
      { method: 'POST', client, body: codesPayload, headers: { 'Idempotency-Key': 'a31-codes-create' } }), 201);
    const codesReplay = await data<{ replayed: boolean; codes: Record<string, unknown>[] }>(await call('/api/v1/admin/registration/codes',
      { method: 'POST', client, body: codesPayload, headers: { 'Idempotency-Key': 'a31-codes-create' } }));
    expect(codesReplay.replayed).toBe(true); expect(codesReplay.codes.every((code) => !Object.hasOwn(code, 'token'))).toBe(true);
    const codeList = await data(await call('/api/v1/admin/registration/codes', { client }));
    for (const code of codes.codes) expect(JSON.stringify(codeList)).not.toContain(code.token);
    await data(await call(`/api/v1/admin/registration/codes/${codes.codes[0]!.id}/revoke`, { method: 'POST', client, body: {} }));

    const settings = await data<{ version: number }>(await call('/api/v1/admin/registration/settings', { client }));
    await data(await call('/api/v1/admin/registration/settings', { method: 'PATCH', client,
      body: { version: settings.version, registrationMode: 'invite', emailVerificationEnabled: false } }));
    expect((await call('/api/v1/admin/registration/settings', { method: 'PATCH', client,
      body: { version: settings.version, registrationMode: 'open' } })).status).toBe(409);
    const audits = (await testEnv.DB.prepare('SELECT action,redacted_change_json FROM admin_audit WHERE actor_id=?').bind(registered.user.id).all()).results;
    expect(audits.map((audit) => audit.action)).toEqual(expect.arrayContaining(['user.create', 'user.update', 'registration_codes.generate', 'registration_codes.revoke', 'registration.settings.update']));
    expect(JSON.stringify(audits)).not.toContain(password); expect(JSON.stringify(audits)).not.toContain(key.token);
  }, 30_000);

  it('mounts administrator revocation of another user key and keeps personal ownership checks', async () => {
    const admin = await fixture('a31-admin', 'admin');
    const owner = await fixture('a31-owner', 'user');
    const other = await fixture('a31-other', 'user');
    const created = await data<{ key: { id: string } }>(await call('/api/v1/keys', { method: 'POST', client: owner,
      body: { name: 'Owner key' }, headers: { 'Idempotency-Key': 'a31-owner-key' } }), 201);
    expect((await call(`/api/v1/keys/${created.key.id}`, { client: other })).status).toBe(404);
    expect((await call(`/api/v1/admin/keys/${created.key.id}/revoke`, { method: 'POST', client: other, body: { version: 1 } })).status).toBe(403);
    expect(await data(await call(`/api/v1/admin/keys/${created.key.id}/revoke`, { method: 'POST', client: admin, body: { version: 1 } })))
      .toMatchObject({ kind: 'revoked', key: { id: created.key.id, status: 'revoked' } });
    expect(await data(await call(`/api/v1/keys/${created.key.id}`, { client: owner }))).toMatchObject({ status: 'revoked' });
    expect(await testEnv.DB.prepare("SELECT actor_id FROM admin_audit WHERE action='api_keys.revoke' AND target_id=?").bind(created.key.id).first())
      .toEqual({ actor_id: 'a31-admin' });
  });

  it('keeps reads available with missing Origin and broken mail configuration, with useful settings diagnostics', async () => {
    const client = await fixture('a31-read-admin', 'admin');
    const env = bindings(); delete env.PUBLIC_BASE_URL;
    env.EMAIL_VERIFICATION_READY = true; env.EMAIL_HMAC_KEY = 'bad'; env.EMAIL_FROM = 'bad';
    await testEnv.DB.prepare("UPDATE settings SET value_json=? WHERE key='registration'").bind('{"registrationMode":"open","emailVerificationEnabled":true}').run();
    for (const path of ['/api/v1/admin/users', '/api/v1/admin/registration/codes', '/api/v1/keys', '/api/v1/auth/me']) {
      await data(await call(path, { client, env }));
    }
    expect(await data(await call('/api/v1/admin/registration/settings', { client, env })))
      .toMatchObject({ registrationMode: 'open', emailVerificationEnabled: true, valid: true, ready: false, emailAvailable: false, issues: ['email_unavailable'] });
  });

  it('authenticates before write configuration, preserves 401/403 and enforces Origin/CSRF after authentication', async () => {
    const admin = await fixture('a31-write-admin', 'admin');
    const ordinary = await fixture('a31-write-user', 'user');
    const env = bindings(); delete env.PUBLIC_BASE_URL;
    const writes = [
      ['POST', '/api/v1/admin/users'], ['PATCH', '/api/v1/admin/users/missing'],
      ['PATCH', '/api/v1/admin/registration/settings'], ['POST', '/api/v1/admin/registration/codes'],
      ['POST', '/api/v1/admin/registration/codes/missing/revoke'], ['POST', '/api/v1/admin/keys/missing/revoke'],
      ['POST', '/api/v1/keys'], ['PATCH', '/api/v1/keys/missing'], ['POST', '/api/v1/keys/missing/revoke'],
    ] as const;
    for (const [method, path] of writes) {
      const anonymous = await call(path, { method, body: {}, env });
      expect(anonymous.status, path).toBe(401); expect(anonymous.headers.get('Cache-Control')).toBe('no-store');
      expect((await call(path, { method, body: {}, client: admin, env })).status, path).toBe(503);
      if (path.startsWith('/api/v1/admin/')) expect((await call(path, { method, body: {}, client: ordinary, env })).status, path).toBe(403);
      expect((await call(path, { method, body: {}, client: admin, headers: { Origin: 'https://evil.example' } })).status, path).toBe(403);
      expect((await call(path, { method, body: {}, client: admin, headers: { 'X-CSRF-Token': '' } })).status, path).toBe(403);
    }
  });

  it('propagates service errors and rolls back a mounted administrator mutation when its audit fails', async () => {
    const client = await fixture('a31-rollback-admin', 'admin');
    await fixture('a31-rollback-user', 'user');
    await testEnv.DB.exec("CREATE TRIGGER a31_fail_audit BEFORE INSERT ON admin_audit WHEN NEW.action='user.update' BEGIN SELECT RAISE(ABORT,'PRIVATE AUDIT DETAIL'); END");
    const response = await call('/api/v1/admin/users/a31-rollback-user', { method: 'PATCH', client, body: { version: 1, rpmLimit: 9 } });
    expect(response.status).toBe(503); expect(response.headers.get('Cache-Control')).toBe('no-store'); expect(await response.text()).not.toContain('PRIVATE');
    expect(await testEnv.DB.prepare('SELECT rpm_limit,version FROM users WHERE id=?').bind('a31-rollback-user').first()).toEqual({ rpm_limit: 60, version: 1 });
    expect((await testEnv.DB.prepare("SELECT id FROM admin_audit WHERE action='user.update'").all()).results).toEqual([]);
  });

  it('retains health and JSON 404 for unknown paths and unsupported methods', async () => {
    expect((await call('/healthz')).status).toBe(200);
    for (const path of ['/api/v1/admin/unknown', '/api/v1/keys/missing/extra', '/v1/unknown']) {
      const response = await call(path);
      expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
    }
    expect((await call('/api/v1/admin/users', { method: 'DELETE' })).status).toBe(404);
  });
});
