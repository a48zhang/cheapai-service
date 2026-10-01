import { Hono } from '../../apps/worker/node_modules/hono';
import { describe, expect, it } from 'vitest';
import { createPublicSettingsRoutes } from '../../apps/worker/auth/public-settings-routes';
import { CSRF_COOKIE_NAME, validateCsrfRequest } from '../../apps/worker/auth/csrf';
import { testEnv } from '../helpers/database';

const path = 'https://console.example/api/v1/settings/public';
function app(emailAvailable = false) { return createPublicSettingsRoutes({ database: testEnv.DB, emailAvailable }); }
async function settings(value: string) { await testEnv.DB.prepare('UPDATE settings SET value_json=? WHERE key=?').bind(value, 'registration').run(); }

describe('public settings authoritative anonymous bootstrap', () => {
  it('returns closed defaults and only public policy plus a usable CSRF nonce', async () => {
    const response = await app().request(path);
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json<{ data: { registrationMode: string; emailVerificationEnabled: boolean; csrfToken: string }; request_id: string }>();
    expect(Object.keys(body).sort()).toEqual(['data', 'request_id']);
    expect(Object.keys(body.data).sort()).toEqual(['csrfToken', 'emailVerificationEnabled', 'registrationMode']);
    expect(body.data).toMatchObject({ registrationMode: 'closed', emailVerificationEnabled: true });
    expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/);
    const cookie = response.headers.get('Set-Cookie');
    expect(cookie).toBe(`${CSRF_COOKIE_NAME}=${body.data.csrfToken}; Secure; Path=/; SameSite=Strict`);
    expect(cookie).not.toContain('HttpOnly'); expect(cookie).not.toContain('Domain');
    expect(() => validateCsrfRequest(new Request('https://console.example/api/v1/login', { method: 'POST', headers: {
      Origin: 'https://console.example', Cookie: `${CSRF_COOKIE_NAME}=${body.data.csrfToken}`, 'X-CSRF-Token': body.data.csrfToken,
    } }), 'https://console.example')).not.toThrow();
  });

  it('reads fresh D1 policy each time and respects trusted email readiness', async () => {
    await settings('{"registrationMode":"open","emailVerificationEnabled":true}');
    expect(await (await app(true).request(path)).json()).toMatchObject({ data: { registrationMode: 'open', emailVerificationEnabled: true } });
    expect(await (await app(false).request(`${path}?emailAvailable=true`)).json()).toMatchObject({ data: { registrationMode: 'closed', emailVerificationEnabled: true } });
    await settings('{"registrationMode":"invite","emailVerificationEnabled":false}');
    expect(await (await app().request(path)).json()).toMatchObject({ data: { registrationMode: 'invite', emailVerificationEnabled: false } });
  });

  it('supports trusted env/request dependency factory and mounting the full path', async () => {
    await settings('{"registrationMode":"open","emailVerificationEnabled":false}');
    let seenPath = '';
    const routes = createPublicSettingsRoutes((env, request) => { seenPath = new URL(request.url).pathname; return { database: env.DB, emailAvailable: false }; });
    const mounted = new Hono().route('/', routes);
    const response = await mounted.request(path, undefined, testEnv);
    expect(response.status).toBe(200); expect(seenPath).toBe('/api/v1/settings/public');
    expect(await response.json()).toMatchObject({ data: { registrationMode: 'open' } });
  });

  it('reuses a valid nonce across tabs instead of rotating it on each read', async () => {
    const first = await app().request(path); const cookie = first.headers.get('Set-Cookie')!.split(';')[0]!;
    const second = await app().request(path, { headers: { Cookie: `unrelated=1; ${cookie}` } });
    expect(second.headers.get('Set-Cookie')).toBe(first.headers.get('Set-Cookie'));
    expect(await second.json()).toMatchObject({ data: { csrfToken: cookie.slice(cookie.indexOf('=') + 1) } });
  });

  it('issues distinct noncached tokens for independent anonymous clients', async () => {
    const first = await app().request(path); const second = await app().request(path);
    expect(first.headers.get('Set-Cookie')).not.toBe(second.headers.get('Set-Cookie'));
    expect(first.headers.get('Cache-Control')).toBe('no-store'); expect(second.headers.get('Cache-Control')).toBe('no-store');
  });

  it.each([`${CSRF_COOKIE_NAME}=bad`, `${CSRF_COOKIE_NAME}=`, `${CSRF_COOKIE_NAME}`, `${CSRF_COOKIE_NAME} =bad`])('rejects malformed CSRF cookie %# without replacing it', async cookie => {
    const response = await app().request(path, { headers: { Cookie: cookie } });
    expect(response.status).toBe(403); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(await response.json()).toMatchObject({ error: { code: 'forbidden' }, request_id: expect.any(String) });
  });

  it('rejects duplicate valid CSRF cookies according to A06', async () => {
    const issued = await app().request(path); const cookie = issued.headers.get('Set-Cookie')!.split(';')[0]!;
    const response = await app().request(path, { headers: { Cookie: `${cookie}; ${cookie}` } });
    expect(response.status).toBe(403); expect(response.headers.get('Set-Cookie')).toBeNull();
  });

  it('fails closed for corrupt/missing policy without exposing storage metadata', async () => {
    await settings('{"registrationMode":"open","default_group_id":"PRIVATE","secret":"PRIVATE"}');
    const response = await app(true).request(path); const body = await response.json();
    expect(body).toMatchObject({ data: { registrationMode: 'closed', emailVerificationEnabled: true } });
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE|version|updatedAt|valid|group|database/);
    await testEnv.DB.prepare('DELETE FROM settings WHERE key=?').bind('registration').run();
    expect(await (await app().request(path)).json()).toMatchObject({ data: { registrationMode: 'closed' } });
  });

  it('returns stable 503 for a real D1 query failure, never successful/open fallback', async () => {
    await testEnv.DB.exec('DROP TABLE settings');
    const response = await app(true).request(path);
    expect(response.status).toBe(503); expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json(); expect(body).toMatchObject({ error: { code: 'service_unavailable' }, request_id: expect.any(String) });
    expect(body).not.toHaveProperty('data'); expect(JSON.stringify(body)).not.toMatch(/SELECT|no such table|D1_ERROR/);
  });
});
