import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../../apps/worker/app';
import type { Env } from '../../apps/worker/env';
import * as passwords from '../../apps/worker/auth/password';
import { DESKTOP_ACCOUNT_PATH, DESKTOP_LOGIN_PATH } from '../../apps/worker/auth/desktop/routes';
import { testEnv } from '../helpers/database';

const origin = 'https://console.example';
const email = 'a42-desktop@example.invalid';
const password = 'fixture-only-password';
const env = { ...testEnv, ENVIRONMENT: 'local', PUBLIC_BASE_URL: origin } as Env;

interface Envelope<T> { data: T; request_id: string }
interface ErrorEnvelope { error: { code: string; reason?: string; message: string }; request_id: string }

async function call(path: string, init: RequestInit = {}) {
  const response = await app.fetch(new Request(origin + path, init), env);
  const text = await response.text();
  return { response, text };
}

describe('desktop bearer HTTP routes', () => {
  afterEach(() => vi.restoreAllMocks());

  it('accepts login without browser CSRF, then rejects a user whose default group is no longer authorized', async () => {
    const now = Date.now();
    await testEnv.DB.prepare(`INSERT INTO groups (id,name,status,version,created_at,updated_at)
      VALUES ('a42-group','A42 group','active',1,?,?)`).bind(now, now).run();
    await testEnv.DB.prepare(`INSERT INTO users
      (id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES ('a42-user',?,'fixture-hash','user','active','a42-group',1000000,2,60,'admin',?,?)`)
      .bind(email, now, now).run();
    vi.spyOn(passwords, 'verifyPassword').mockResolvedValue(true);

    const loginResult = await call(DESKTOP_LOGIN_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(loginResult.response.status).toBe(200);
    expect(loginResult.response.headers.get('Cache-Control')).toBe('no-store');
    expect(loginResult.response.headers.get('Set-Cookie')).toBeNull();
    const login = JSON.parse(loginResult.text) as Envelope<{
      token: string; expiresAt: number; user: { id: string; email_normalized: string };
    }>;
    expect(login.request_id).toEqual(expect.any(String));
    expect(login.data).toMatchObject({ user: { id: 'a42-user', email_normalized: email } });
    expect(login.data.token).toMatch(/^s2a_desktop_/);
    expect(login.data.expiresAt).toBeGreaterThan(now);
    expect(JSON.stringify(login)).not.toMatch(/password_hash|token_hash|session_id/);

    await testEnv.DB.prepare('DELETE FROM user_group_access WHERE user_id=? AND group_id=?')
      .bind('a42-user', 'a42-group').run();

    const accountResult = await call(DESKTOP_ACCOUNT_PATH, {
      headers: { Authorization: `Bearer ${login.data.token}` },
    });
    expect(accountResult.response.status).toBe(403);
    const unavailable = JSON.parse(accountResult.text) as ErrorEnvelope;
    expect(unavailable).toMatchObject({ error: { code: 'forbidden', reason: 'group_unavailable' } });
    expect(unavailable.request_id).toEqual(expect.any(String));
    expect(accountResult.text).not.toContain(login.data.token);

    const deniedLogin = await call(DESKTOP_LOGIN_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    expect(deniedLogin.response.status).toBe(401);
    expect(JSON.parse(deniedLogin.text)).toMatchObject({ error: { code: 'unauthorized' } });
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM desktop_sessions WHERE user_id=?')
      .bind('a42-user').first('n')).toBe(1);
  });
});
