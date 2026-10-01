import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionRoutes } from '../../apps/worker/auth/session-routes';
import { clearSessionCookie, createCookieSession, readCookieSession, revokeCookieSession, SESSION_COOKIE_NAME } from '../../apps/worker/auth/sessions';
import { issueCsrfToken, CSRF_HEADER_NAME } from '../../apps/worker/auth/csrf';
import { prepare } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const now = 1_788_619_000_000;
let cookie: string;
const userId = 'a20-user';

beforeEach(async () => {
  await prepare(testEnv.DB,
    'INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    ['a20-group', 'A20 Group', 'active', 1, now, now]).run();
  await prepare(testEnv.DB, `INSERT INTO users
    (id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES (?,?,?,'user','active',?,-123,2,60,'admin',?,?)`,
    [userId, 'a20@example.invalid', 'a20-test-only-hash', 'a20-group', now, now]).run();
  cookie = (await createCookieSession(testEnv.DB, userId, now, { sessionTtlMs: 60_000 })).setCookie.split(';')[0]!;
});

describe('POST /api/v1/auth/logout on native D1', () => {
  const trustedOrigin = 'https://console.example.invalid';
  function logoutHeaders(sessionCookie?: string): Headers {
    const csrf = issueCsrfToken();
    const headers = new Headers({ Origin: trustedOrigin, [CSRF_HEADER_NAME]: csrf.token });
    headers.set('Cookie', [csrf.setCookie.split(';')[0], sessionCookie].filter(Boolean).join('; '));
    return headers;
  }
  const routes = () => createSessionRoutes({ now: () => now, trustedOrigin: async () => trustedOrigin });

  it('validates CSRF, revokes the session and clears the secure cookie', async () => {
    const response = await routes().request('/api/v1/auth/logout', { method: 'POST', headers: logoutHeaders(cookie) }, testEnv);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toBe(clearSessionCookie());
    const body = await response.json();
    expect(body).toEqual({ data: { loggedOut: true }, request_id: expect.any(String) });
    expect(JSON.stringify(body)).not.toMatch(/token|hash|s2a_session_/);
    expect(await readCookieSession(testEnv.DB, cookie, now)).toBeNull();
  });

  it.each([undefined, `${SESSION_COOKIE_NAME}=bad`])('safely clears missing or malformed session %# with valid CSRF', async sessionCookie => {
    const database = { prepare: vi.fn(() => { throw new Error('Must not query D1'); }) } as unknown as D1Database;
    const response = await routes().request('/api/v1/auth/logout', { method: 'POST', headers: logoutHeaders(sessionCookie) }, { DB: database });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBe(clearSessionCookie());
    expect(database.prepare).not.toHaveBeenCalled();
  });

  it.each(['origin', 'csrf'])('rejects invalid %s without revoking the session', async invalid => {
    const headers = logoutHeaders(cookie);
    if (invalid === 'origin') headers.set('Origin', 'https://attacker.invalid');
    else headers.delete(CSRF_HEADER_NAME);
    const response = await routes().request('/api/v1/auth/logout', { method: 'POST', headers }, testEnv);
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(await readCookieSession(testEnv.DB, cookie, now)).not.toBeNull();
  });

  it('returns 503 without a successful logout body or clearing cookie on database failure', async () => {
    const database = { prepare: () => { throw new Error('Private database failure'); } } as unknown as D1Database;
    const response = await routes().request('/api/v1/auth/logout', { method: 'POST', headers: logoutHeaders(cookie) }, { DB: database });
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.has('set-cookie')).toBe(false);
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable', message: 'Service temporarily unavailable.' }, request_id: expect.any(String) });
  });

  it('resolves trusted Origin per request and fails closed without configuration', async () => {
    const resolver = vi.fn(async () => trustedOrigin);
    const configured = createSessionRoutes({ now: () => now, trustedOrigin: resolver });
    expect(resolver).not.toHaveBeenCalled();
    await configured.request('/api/v1/auth/logout', { method: 'POST', headers: logoutHeaders() }, testEnv);
    await configured.request('/api/v1/auth/logout', { method: 'POST', headers: logoutHeaders() }, testEnv);
    expect(resolver).toHaveBeenCalledTimes(2);
    const response = await createSessionRoutes({ now: () => now }).request('/api/v1/auth/logout', { method: 'POST', headers: logoutHeaders(cookie) }, testEnv);
    expect(response.status).toBe(503);
    expect(await readCookieSession(testEnv.DB, cookie, now)).not.toBeNull();
  });
});

describe('GET /api/v1/auth/me on native D1', () => {
  it('returns data directly as PublicUser, without credentials or a session wrapper', async () => {
    const origin = vi.fn(() => { throw new Error('GET must not resolve Origin'); });
    const response = await createSessionRoutes({ now: () => now, trustedOrigin: origin })
      .request('/api/v1/auth/me', { headers: { Cookie: cookie } }, testEnv);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.has('set-cookie')).toBe(false);
    const body = await response.json();
    expect(body).toEqual({ data: {
      id: userId, email_normalized: 'a20@example.invalid', role: 'user', status: 'active',
      group_id: 'a20-group', group_status: 'active', balance_units: '-123', email_verified_at: null,
    }, request_id: expect.any(String) });
    expect(JSON.stringify(body)).not.toMatch(/password|hash|s2a_session_|expires_at/);
    expect(origin).not.toHaveBeenCalled();
  });

  it('returns no-store 401 for missing or expired sessions', async () => {
    for (const response of [
      await createSessionRoutes({ now: () => now }).request('/api/v1/auth/me', {}, testEnv),
      await createSessionRoutes({ now: () => now + 60_000 }).request('/api/v1/auth/me', { headers: { Cookie: cookie } }, testEnv),
    ]) {
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: { code: 'unauthorized', message: 'Authentication required.' }, request_id: expect.any(String) });
    }
  });

  it('rejects revoked and disabled identities', async () => {
    const routes = createSessionRoutes({ now: () => now });
    await revokeCookieSession(testEnv.DB, cookie, now);
    expect((await routes.request('/api/v1/auth/me', { headers: { Cookie: cookie } }, testEnv)).status).toBe(401);
    cookie = (await createCookieSession(testEnv.DB, userId, now)).setCookie.split(';')[0]!;
    await prepare(testEnv.DB, "UPDATE users SET status='disabled' WHERE id=?", [userId]).run();
    expect((await routes.request('/api/v1/auth/me', { headers: { Cookie: cookie } }, testEnv)).status).toBe(401);
  });

  it('returns sanitized no-store 503 when D1 fails', async () => {
    const database = { prepare: () => { throw new Error('private D1 details'); } } as unknown as D1Database;
    const response = await createSessionRoutes({ now: () => now }).request('/api/v1/auth/me', { headers: { Cookie: cookie } }, { DB: database });
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable', message: 'Service temporarily unavailable.' }, request_id: expect.any(String) });
  });
});
