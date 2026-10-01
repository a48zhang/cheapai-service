// Hono is declared by the worker workspace.
import { Hono } from '../../apps/worker/node_modules/hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { requireSession } from '../../apps/worker/auth/middleware';
import type { AuthEnv } from '../../apps/worker/auth/middleware';
import { requireAdmin } from '../../apps/worker/auth/roles';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { apiSuccess } from '../../apps/worker/http';
import { prepare } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const now = 1_788_619_000_000;
let userCookie: string;
let adminCookie: string;

async function seedUser(id: string, role: 'user' | 'admin') {
  await prepare(testEnv.DB,
    `INSERT INTO users (id, email_normalized, password_hash, role, status, group_id,
     concurrency_limit, rpm_limit, created_via, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, `${id}@example.invalid`, 'a05-test-only-hash', role, 'active', 'a05-group', 2, 60, 'admin', now, now]).run();
  return (await createCookieSession(testEnv.DB, id, now)).setCookie.split(';')[0]!;
}

function adminApp(authenticate = true) {
  const app = new Hono<AuthEnv>();
  app.use('*', async (context, next) => { context.set('requestId', 'a05-server-request'); await next(); });
  if (authenticate) app.use('*', requireSession(() => now));
  app.use('*', requireAdmin);
  app.all('*', context => apiSuccess({ id: context.get('user').id, role: context.get('user').role }, context.get('requestId')));
  return app;
}

beforeEach(async () => {
  await prepare(testEnv.DB,
    'INSERT INTO groups (id, name, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['a05-group', 'A05 Test Group', 'active', 1, now, now]).run();
  userCookie = await seedUser('a05-user', 'user');
  adminCookie = await seedUser('a05-admin', 'admin');
});

describe('administrator role guard on native D1', () => {
  it('allows an authenticated administrator', async () => {
    const response = await adminApp().request('/api/v1/admin', { headers: { Cookie: adminCookie } }, testEnv);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { id: 'a05-admin', role: 'admin' }, request_id: 'a05-server-request' });
  });

  it.each([
    ['/api/v1/admin', 'GET', undefined],
    ['/api/v1/admin?role=admin&user_id=a05-admin', 'GET', undefined],
    ['/api/v1/admin/a05-admin', 'POST', JSON.stringify({ role: 'admin', user_id: 'a05-admin' })],
    ['/api/v1/admin', 'POST', 'role=admin&user_id=a05-admin'],
  ] as const)('denies ordinary users despite untrusted claims %#', async (url, method, body) => {
    const response = await adminApp().request(url, {
      method,
      headers: { Cookie: userCookie, 'X-Role': 'admin', 'X-User-ID': 'a05-admin', Authorization: 'Bearer admin' },
      ...(body === undefined ? {} : { body }),
    }, testEnv);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: 'forbidden', message: 'Permission denied.' }, request_id: 'a05-server-request',
    });
  });

  it('returns 401 when there is no authenticated session', async () => {
    const response = await adminApp().request('/admin?role=admin', { headers: { 'X-Role': 'admin' } }, testEnv);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: 'unauthorized', message: 'Authentication required.' }, request_id: 'a05-server-request',
    });
  });

  it('fails closed if the role guard is mounted without requireSession', async () => {
    const response = await adminApp(false).request('/admin', { headers: { Cookie: adminCookie, 'X-Role': 'admin' } }, testEnv);
    expect(response.status).toBe(401);
  });

  it('observes an administrator demotion on the very next request', async () => {
    const app = adminApp();
    expect((await app.request('/admin', { headers: { Cookie: adminCookie } }, testEnv)).status).toBe(200);
    await prepare(testEnv.DB, 'UPDATE users SET role = ? WHERE id = ?', ['user', 'a05-admin']).run();
    expect((await app.request('/admin', { headers: { Cookie: adminCookie } }, testEnv)).status).toBe(403);
  });

  it('rejects a disabled administrator through authoritative authentication', async () => {
    const app = adminApp();
    await prepare(testEnv.DB, 'UPDATE users SET status = ? WHERE id = ?', ['disabled', 'a05-admin']).run();
    expect((await app.request('/admin', { headers: { Cookie: adminCookie } }, testEnv)).status).toBe(401);
  });

  it('generates a request ID when role guard context is absent', async () => {
    const app = new Hono<AuthEnv>();
    app.use('*', requireAdmin);
    app.get('/admin', context => context.text('must not run'));
    const response = await app.request('/admin', { headers: { 'X-Request-ID': 'attacker' } }, testEnv);
    expect(response.status).toBe(401);
    const body = await response.json() as { request_id: string };
    expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.request_id).not.toBe('attacker');
  });
});
