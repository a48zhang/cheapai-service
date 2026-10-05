import { describe, expect, it } from 'vitest';
import { app } from '../../apps/worker/app';
import type { Env } from '../../apps/worker/env';
import { DEFAULT_CONFIG } from '../../apps/worker/config';
import { readCookieSession } from '../../apps/worker/auth/sessions';
import { testEnv } from '../helpers/database';

const origin = 'https://console.example';
const settingsPath = '/api/v1/settings/public';
const credentials = { email: 'early-entry@example.invalid', password: 'correct horse battery staple' };
const bindings = (extra: Partial<Env> = {}): Env => ({ ...testEnv, ENVIRONMENT: 'local', PUBLIC_BASE_URL: origin, EMAIL_VERIFICATION_READY: false, ...extra });
function fetchPath(path: string, init: RequestInit = {}, env = bindings()) { return app.fetch(new Request(origin + path, init), env); }
async function nonce(env = bindings()) {
  const response = await fetchPath(settingsPath, {}, env);
  expect(response.status).toBe(200);
  const body = await response.json<{ data: { csrfToken: string } }>();
  return { Origin: origin, 'Content-Type': 'application/json', Cookie: response.headers.get('Set-Cookie')!.split(';')[0]!, 'X-CSRF-Token': body.data.csrfToken };
}
async function openRegistration() {
  await testEnv.DB.prepare('UPDATE settings SET value_json=? WHERE key=?').bind('{"registrationMode":"open","emailVerificationEnabled":false}', 'registration').run();
}

async function seedExistingLoginUser() {
  // Reviewed independent Argon2id fixture for credentials.password. This models
  // an existing account; no registration/email configuration is needed to seed it.
  const hash = '$argon2id$v=19$m=19456,t=2,p=1$ABEiM0RVZneImaq7zN3u/w$zNlY8+rVrxPryRQjL30GJ7r4tOgZLsK6gVRDMWy/cD0';
  await testEnv.DB.prepare(`INSERT INTO users
    (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES ('audit-login-user',?,?,'user','active','default',2,60,'admin',?,?)`)
    .bind(credentials.email, hash, Date.now(), Date.now()).run();
}

describe('real production app entry with native D1/GATE (not a socket/mail acceptance test)', () => {
  it.each([
    ['missing key', { EMAIL_VERIFICATION_READY: true, EMAIL_FROM: 'sender@example.invalid' }],
    ['invalid key', { EMAIL_VERIFICATION_READY: true, EMAIL_HMAC_KEY: btoa('weak'), EMAIL_FROM: 'sender@example.invalid' }],
    ['invalid sender', { EMAIL_VERIFICATION_READY: true, EMAIL_HMAC_KEY: btoa('a'.repeat(32)), EMAIL_FROM: 'not-an-email' }],
    ['missing binding', { EMAIL_VERIFICATION_READY: true, EMAIL_HMAC_KEY: btoa('a'.repeat(32)), EMAIL_FROM: 'sender@example.invalid', EMAIL: {} }],
    ['invalid readiness', { EMAIL_VERIFICATION_READY: 'misconfigured' }],
  ])('bootstraps from no cookie and logs in despite broken email configuration: %s', async (_label, overrides) => {
    await seedExistingLoginUser();
    await openRegistration();
    const env = bindings(overrides as Partial<Env>);
    // This browser has no existing cookie; its first request uses broken mail
    // configuration too. Registration is publicly closed while nonce/login work.
    const bootstrap = await fetchPath(settingsPath, {}, env);
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.headers.get('Cache-Control')).toBe('no-store');
    const settings = await bootstrap.json<{ data: { registrationMode: string; emailVerificationEnabled: boolean; csrfToken: string } }>();
    expect(settings.data).toMatchObject({ registrationMode: 'closed', emailVerificationEnabled: true });
    expect(settings.data.csrfToken).toBeTruthy();
    const headers = { Origin: origin, 'Content-Type': 'application/json',
      Cookie: bootstrap.headers.get('Set-Cookie')!.split(';')[0]!, 'X-CSRF-Token': settings.data.csrfToken };
    const login = await fetchPath('/api/v1/auth/login', { method: 'POST', headers, body: JSON.stringify(credentials) }, env);
    expect(login.status).toBe(200);
    expect(login.headers.get('Cache-Control')).toBe('no-store');
    const cookie = login.headers.get('Set-Cookie');
    expect(cookie).toContain('HttpOnly');
    const me = await fetchPath('/api/v1/auth/me', { headers: { Cookie: cookie!.split(';')[0]! } }, env);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ data: { id: 'audit-login-user', email_normalized: credentials.email } });
    expect((await fetchPath(settingsPath, {}, env)).status).toBe(200);
    for (const path of ['/api/v1/auth/register', '/api/v1/auth/send-verify-code']) {
      expect((await fetchPath(path, { method: 'POST', headers, body: JSON.stringify(credentials) }, env)).status).toBe(503);
    }
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM email_challenges').first<{ n: number }>())?.n).toBe(0);
  }, 30_000);

  it.each([['open', true], ['open', false], ['invite', true], ['invite', false]] as const)(
    'broken mail exposes closed projection for %s/verification=%s without rewriting stored policy', async (registrationMode, emailVerificationEnabled) => {
      const stored = JSON.stringify({ registrationMode, emailVerificationEnabled });
      await testEnv.DB.prepare("UPDATE settings SET value_json=? WHERE key='registration'").bind(stored).run();
      const env = bindings({ EMAIL_VERIFICATION_READY: true });
      const response = await fetchPath(settingsPath, {}, env);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ data: { registrationMode: 'closed', emailVerificationEnabled: true, csrfToken: expect.any(String) } });
      expect(response.headers.get('Set-Cookie')).toContain('__Host-sub2api_csrf=');
      expect((await testEnv.DB.prepare("SELECT value_json FROM settings WHERE key='registration'").first<{ value_json: string }>())?.value_json).toBe(stored);
    },
  );

  it('bootstrap fallback preserves malformed-cookie rejection and trusted environment/origin requirements', async () => {
    const badMail = bindings({ EMAIL_VERIFICATION_READY: true });
    const malformed = await fetchPath(settingsPath, { headers: { Cookie: '__Host-sub2api_csrf=not-a-valid-nonce' } }, badMail);
    expect(malformed.status).toBe(403);
    expect(malformed.headers.get('Set-Cookie')).toBeNull();
    expect((await fetchPath(settingsPath, {}, { ...badMail, ENVIRONMENT: 'untrusted' } as Env)).status).toBe(503);
    expect((await fetchPath(settingsPath, {}, { ...badMail, PUBLIC_BASE_URL: 'http://console.example' })).status).toBe(503);
    const unavailableDatabase = { prepare() { throw new Error('private database failure'); } } as unknown as D1Database;
    const unavailableSettings = await fetchPath(settingsPath, {}, { ...badMail, DB: unavailableDatabase });
    expect(unavailableSettings.status).toBe(503);
    expect(await unavailableSettings.text()).not.toContain('private database failure');
  });

  it('mail-independent login still rejects bad trusted origin, request origin and untrusted IP context', async () => {
    await seedExistingLoginUser();
    const headers = await nonce();
    const brokenMail = { EMAIL_VERIFICATION_READY: true, EMAIL_HMAC_KEY: 'invalid' } as const;
    for (const PUBLIC_BASE_URL of ['', 'http://console.example', 'https://console.example/path']) {
      const response = await fetchPath('/api/v1/auth/login', { method: 'POST', headers, body: JSON.stringify(credentials) }, bindings({ ...brokenMail, PUBLIC_BASE_URL }));
      expect(response.status).toBe(503);
      expect(response.headers.get('Set-Cookie')).toBeNull();
    }
    const wrongOrigin = await fetchPath('/api/v1/auth/login', { method: 'POST', headers: { ...headers, Origin: 'https://attacker.example' }, body: JSON.stringify(credentials) }, bindings(brokenMail));
    expect(wrongOrigin.status).toBe(403);
    for (const ENVIRONMENT of ['production', 'staging'] as const) {
      const response = await fetchPath('/api/v1/auth/login', { method: 'POST', headers: {
        ...headers, 'CF-Connecting-IP': '198.51.100.5', 'X-Forwarded-For': '198.51.100.6',
      }, body: JSON.stringify(credentials) }, bindings({ ...brokenMail, ENVIRONMENT }));
      expect(response.status).toBe(503);
      expect(response.headers.get('Set-Cookie')).toBeNull();
    }
    expect((await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>())?.n).toBe(0);
  });

  it('runs nonce -> real registration -> me -> logout -> revoked me -> real login -> restored me', async () => {
    await openRegistration();
    const env = bindings(); const headers = await nonce(env);
    // Local deployment ignores both spoofable forwarding headers entirely.
    const registration = await fetchPath('/api/v1/auth/register', { method: 'POST', headers: {
      ...headers, 'X-Forwarded-For': 'attacker-value', 'CF-Connecting-IP': 'also-not-an-ip',
    }, body: JSON.stringify(credentials) }, env);
    expect(registration.status).toBe(201);
    const registered = await registration.json<{ data: { status: string; session: string; user: { id: string } } }>();
    expect(registered.data).toMatchObject({ status: 'created', session: 'created' });
    const cookie = registration.headers.get('Set-Cookie'); expect(cookie).toContain('HttpOnly');
    expect(await readCookieSession(testEnv.DB, cookie!.split(';')[0]!, Date.now())).not.toBeNull();
    const sessionCookie = cookie!.split(';')[0]!;
    const noOriginConfig = bindings(); delete noOriginConfig.PUBLIC_BASE_URL;
    const me = await fetchPath('/api/v1/auth/me', { headers: { Cookie: sessionCookie } }, noOriginConfig);
    expect(me.status).toBe(200); expect(me.headers.get('Cache-Control')).toBe('no-store');
    expect(await me.json()).toMatchObject({ data: { id: registered.data.user.id, balance_units: '0' } });
    const logoutHeaders = { ...headers, Cookie: `${headers.Cookie}; ${sessionCookie}` };
    const missingConfigLogout = await fetchPath('/api/v1/auth/logout', { method: 'POST', headers: logoutHeaders }, noOriginConfig);
    expect(missingConfigLogout.status).toBe(503); expect(missingConfigLogout.headers.get('Set-Cookie')).toBeNull();
    expect((await fetchPath('/api/v1/auth/me', { headers: { Cookie: sessionCookie } }, noOriginConfig)).status).toBe(200);
    const wrongOriginLogout = await fetchPath('/api/v1/auth/logout', { method: 'POST', headers: { ...logoutHeaders, Origin: 'https://attacker.example' } }, env);
    expect(wrongOriginLogout.status).toBe(403);
    const logout = await fetchPath('/api/v1/auth/logout', { method: 'POST', headers: logoutHeaders }, env);
    expect(logout.status).toBe(200); expect(logout.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(logout.headers.get('Cache-Control')).toBe('no-store');
    expect(await logout.json()).toMatchObject({ data: { loggedOut: true } });
    const revoked = await fetchPath('/api/v1/auth/me', { headers: { Cookie: sessionCookie } }, env);
    expect(revoked.status).toBe(401); expect(await revoked.json()).toMatchObject({ error: { code: 'unauthorized' } });
    const stored = await testEnv.DB.prepare('SELECT password_hash FROM users WHERE id=?').bind(registered.data.user.id).first<{ password_hash: string }>();
    expect(stored?.password_hash).toMatch(/^\$argon2id\$/);
    const login = await fetchPath('/api/v1/auth/login', { method: 'POST', headers, body: JSON.stringify(credentials) }, env);
    expect(login.status).toBe(200); expect(login.headers.get('Set-Cookie')).toContain('HttpOnly');
    expect(await login.json()).toMatchObject({ data: { id: registered.data.user.id, balance_units: '0' }, request_id: expect.any(String) });
    const newCookie = login.headers.get('Set-Cookie')!.split(';')[0]!;
    expect(newCookie).not.toBe(sessionCookie);
    const restored = await fetchPath('/api/v1/auth/me', { headers: { Cookie: newCookie } }, noOriginConfig);
    expect(restored.status).toBe(200); expect(await restored.json()).toMatchObject({ data: { id: registered.data.user.id } });
  }, 30_000);

  it('preserves health and JSON404 for unknown management and model APIs without binding config', async () => {
    expect(await (await app.fetch(new Request(origin + '/healthz'), {})).json()).toEqual({ status: 'ok' });
    for (const path of ['/api/v1/not-implemented', '/v1/not-implemented']) {
      const response = await app.fetch(new Request(origin + path), {});
      expect(response.status).toBe(404); expect(response.headers.get('Content-Type')).toContain('application/json');
      expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
    }
  });

  it('mounts anonymous me as 401 without requiring origin configuration', async () => {
    const env = bindings(); delete env.PUBLIC_BASE_URL;
    const response = await fetchPath('/api/v1/auth/me', {}, env);
    expect(response.status).toBe(401); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it.each(['', 'http://console.example', 'https://console.example/path', 'https://u:p@console.example', 'not a URL', ' https://console.example'])('fails closed for invalid trusted URL %#', PUBLIC_BASE_URL => {
    return fetchPath(settingsPath, { headers: { Host: 'console.example', Origin: origin } }, bindings({ PUBLIC_BASE_URL })).then(async response => {
      expect(response.status).toBe(503); expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toMatchObject({ error: { code: 'service_unavailable' } });
    });
  });

  it('rejects missing URL rather than inferring it from Host or Origin', async () => {
    const env = bindings(); delete env.PUBLIC_BASE_URL;
    expect((await fetchPath(settingsPath, { headers: { Host: 'console.example', Origin: origin } }, env)).status).toBe(503);
  });

  it('requires CSRF for anonymous registration/login despite the real route being mounted', async () => {
    await openRegistration();
    for (const path of ['/api/v1/auth/register', '/api/v1/auth/login']) {
      const response = await fetchPath(path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
      expect(response.status).toBe(403);
    }
  });

  it.each(['production', 'staging'] as const)('rejects forged connecting-IP headers without native edge context in %s', async ENVIRONMENT => {
    const env = bindings({ ENVIRONMENT }); const headers = await nonce(env);
    const response = await fetchPath('/api/v1/auth/login', { method: 'POST', headers: { ...headers,
      'CF-Connecting-IP': '198.51.100.1', 'X-Forwarded-For': '198.51.100.2', 'CF-Ray': 'fake',
    }, body: JSON.stringify(credentials) }, env);
    expect(response.status).toBe(503);
  });

  it('ignores JSON trustedIp and charges the server-selected IP quota', async () => {
    const headers = await nonce();
    const response = await fetchPath('/api/v1/auth/login', { method: 'POST', headers,
      body: JSON.stringify({ ...credentials, trustedIp: '198.51.100.3' }) });
    // Unknown fields are accepted; this unseeded account still fails authentication.
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'unauthorized' } });
    const remaining = async (ip: string) => {
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip)));
      const name = `auth:login-ip:v1:${Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')}`;
      return (await testEnv.GATE.get(testEnv.GATE.idFromName(name)).ratePeek({
        limit: DEFAULT_CONFIG.loginIpAttemptLimit, windowMs: DEFAULT_CONFIG.loginWindowMs,
      })).remaining;
    };
    expect(await remaining('127.0.0.1')).toBe(DEFAULT_CONFIG.loginIpAttemptLimit - 1);
    expect(await remaining('198.51.100.3')).toBe(DEFAULT_CONFIG.loginIpAttemptLimit);
  });

  it('mounts send-code but refuses missing readiness/HMAC without sending mail', async () => {
    const headers = await nonce();
    const response = await fetchPath('/api/v1/auth/send-verify-code', { method: 'POST', headers, body: JSON.stringify({ email: credentials.email }) });
    expect(response.status).toBe(503);
    for (const env of [bindings({ EMAIL_VERIFICATION_READY: true }), bindings({ EMAIL_VERIFICATION_READY: true, EMAIL_HMAC_KEY: btoa('weak'), EMAIL_FROM: 'sender@example.invalid' })]) {
      const publicSettings = await fetchPath(settingsPath, {}, env);
      expect(publicSettings.status).toBe(200);
      expect(await publicSettings.json()).toMatchObject({ data: { registrationMode: 'closed', csrfToken: expect.any(String) } });
    }
    const rows = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM email_challenges').first<{ n: number }>(); expect(rows?.n).toBe(0);
  });

  it('reaches the real send-code policy with valid explicit mail configuration but never sends while closed', async () => {
    const env = bindings({ EMAIL_VERIFICATION_READY: true, EMAIL_HMAC_KEY: btoa('a'.repeat(32)), EMAIL_FROM: 'sender@example.invalid' });
    const headers = await nonce(env);
    const response = await fetchPath('/api/v1/auth/send-verify-code', { method: 'POST', headers, body: JSON.stringify({ email: credentials.email }) }, env);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'forbidden' } });
    const rows = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM email_challenges').first<{ n: number }>(); expect(rows?.n).toBe(0);
  });
});
