// Hono belongs to the worker workspace, not the root test package.
import { Hono } from '../../apps/worker/node_modules/hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requireSession } from '../../apps/worker/auth/middleware';
import type { AuthEnv } from '../../apps/worker/auth/middleware';
import { createCookieSession, revokeCookieSession, SESSION_COOKIE_NAME } from '../../apps/worker/auth/sessions';
import { generateToken } from '../../apps/worker/auth/tokens';
import { apiSuccess } from '../../apps/worker/http';
import { prepare } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const now = 1_788_619_000_000;
const userId = 'a04-user';
const passwordHash = 'a04-test-only-password-hash';
let cookie: string;

function appAt(time = now, requestId?: string) {
  const app = new Hono<AuthEnv>();
  if (requestId) app.use('*', async (context, next) => { context.set('requestId', requestId); await next(); });
  app.use('*', requireSession(() => time));
  app.get('/private', context => apiSuccess({ user: context.get('user'), session: context.get('session') }, context.get('requestId')));
  return app;
}

function request(app: Hono<AuthEnv>, credential?: string, database = testEnv.DB) {
  const headers = new Headers({ 'X-Request-ID': 'untrusted-client-id', 'X-User-ID': 'another-user', 'X-Role': 'admin' });
  if (credential !== undefined) headers.set('Cookie', credential);
  return app.request('/private', { headers }, { DB: database });
}

beforeEach(async () => {
  await prepare(testEnv.DB,
    'INSERT INTO groups (id, name, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['a04-group', 'A04 Test Group', 'active', 1, now, now]).run();
  await prepare(testEnv.DB,
    `INSERT INTO users (id, email_normalized, password_hash, role, status, group_id,
     concurrency_limit, rpm_limit, created_via, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, 'a04@example.invalid', passwordHash, 'user', 'active', 'a04-group', 2, 60, 'admin', now, now]).run();
  const issued = await createCookieSession(testEnv.DB, userId, now, { sessionTtlMs: 60_000 });
  cookie = issued.setCookie.split(';')[0]!;
});

async function expectUnauthorized(response: Response) {
  expect(response.status).toBe(401);
  const body = await response.json() as { error: unknown; request_id: string };
  expect(body).toEqual({ error: { code: 'unauthorized', message: 'Authentication required.' }, request_id: expect.any(String) });
  expect(body.request_id).not.toBe('untrusted-client-id');
}

describe('Hono session authentication on native D1', () => {
  it('populates context from D1 with public user and credential-free internal session', async () => {
    const response = await request(appAt(), cookie);
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { user: Record<string, unknown>; session: Record<string, unknown> }; request_id: string };
    expect(body.data.user).toEqual({
      id: userId, email_normalized: 'a04@example.invalid', role: 'user', status: 'active',
      group_id: 'a04-group', group_status: 'active', balance_units: '0', email_verified_at: null,
    });
    expect(body.data.session).toEqual({ id: expect.any(String), user_id: userId, created_at: now, expires_at: now + 60_000 });
    expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(body)).not.toContain(passwordHash);
    expect(JSON.stringify(body)).not.toContain('token_hash');
    expect(JSON.stringify(body)).not.toContain('password_hash');
    expect(JSON.stringify(body)).not.toContain('s2a_session_');
    expect(response.headers.has('set-cookie')).toBe(false);
  });

  it('preserves a trusted middleware request ID for both success and failure', async () => {
    const app = appAt(now, 'server-request-42');
    expect((await (await request(app, cookie)).json() as { request_id: string }).request_id).toBe('server-request-42');
    expect((await (await request(app)).json() as { request_id: string }).request_id).toBe('server-request-42');
  });

  it('rejects missing and malformed cookies before database access', async () => {
    const database = { prepare: vi.fn(() => { throw new Error('Database must not be touched'); }) } as unknown as D1Database;
    await expectUnauthorized(await request(appAt(), undefined, database));
    await expectUnauthorized(await request(appAt(), `${SESSION_COOKIE_NAME}=bad`, database));
    expect(database.prepare).not.toHaveBeenCalled();
  });

  it('rejects duplicate cookie names and unknown valid-format credentials', async () => {
    await expectUnauthorized(await request(appAt(), `${cookie}; ${cookie}`));
    await expectUnauthorized(await request(appAt(), `${SESSION_COOKIE_NAME}=${generateToken('session')}`));
  });

  it('rejects expiry at exactly expires_at and revocation', async () => {
    await expectUnauthorized(await request(appAt(now + 60_000), cookie));
    await revokeCookieSession(testEnv.DB, cookie, now + 1);
    await expectUnauthorized(await request(appAt(now + 2), cookie));
  });

  it('refreshes user and group status for every request using the same middleware', async () => {
    const app = appAt();
    expect((await request(app, cookie)).status).toBe(200);
    await prepare(testEnv.DB, 'UPDATE users SET status = ? WHERE id = ?', ['disabled', userId]).run();
    await expectUnauthorized(await request(app, cookie));
    await prepare(testEnv.DB, 'UPDATE users SET status = ? WHERE id = ?', ['active', userId]).run();
    await prepare(testEnv.DB, 'UPDATE groups SET status = ? WHERE id = ?', ['disabled', 'a04-group']).run();
    await expectUnauthorized(await request(app, cookie));
  });

  it('refreshes role and balance from authoritative data without enforcing admin policy', async () => {
    const app = appAt();
    expect((await request(app, cookie)).status).toBe(200);
    await prepare(testEnv.DB, 'UPDATE users SET role = ?, balance_units = ? WHERE id = ?', ['admin', -123, userId]).run();
    const body = await (await request(app, cookie)).json() as { data: { user: { role: string; balance_units: string } } };
    expect(body.data.user.role).toBe('admin');
    expect(body.data.user.balance_units).toBe('-123');
  });

  it('maps a D1 failure to a sanitized 503 rather than 401', async () => {
    const database = { prepare: () => { throw new Error('D1 private connection details and secret'); } } as unknown as D1Database;
    const response = await request(appAt(), cookie, database);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: 'service_unavailable', message: 'Service temporarily unavailable.' }, request_id: expect.any(String),
    });
  });

  it('does not misclassify downstream route failures as authentication failures', async () => {
    const app = new Hono<AuthEnv>();
    app.use('*', requireSession(() => now));
    app.get('/private', () => { throw new Error('route failed'); });
    app.onError((_error, context) => context.text('route error handler', 500));
    const response = await request(app, cookie);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('route error handler');
  });
});
