import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../apps/worker/config';
import { issueCsrfToken } from '../../apps/worker/auth/csrf';
import { createLoginRoutes, LOGIN_BODY_MAX_BYTES, LOGIN_PATH } from '../../apps/worker/auth/login-routes';
import type { LoginRouteDependencies } from '../../apps/worker/auth/login-routes';
import * as passwords from '../../apps/worker/auth/password';
import { readCookieSession } from '../../apps/worker/auth/sessions';
import { testEnv } from '../helpers/database';

const origin = 'https://console.example.com';
const input = { email: 'a08@example.invalid', password: 'correct horse battery staple' };
const hash = '$argon2id$v=19$m=19456,t=2,p=1$ABEiM0RVZneImaq7zN3u/w$zNlY8+rVrxPryRQjL30GJ7r4tOgZLsK6gVRDMWy/cD0';
let deps: LoginRouteDependencies;
let headers: Record<string, string>;
let verify: ReturnType<typeof vi.spyOn<typeof passwords, 'verifyPassword'>>;
const encode = (value: string) => new TextEncoder().encode(value);

function streamRequest(chunks: Uint8Array[], overrides: Record<string, string> = {}) {
  let index = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk); else controller.close();
    },
    cancel,
  }, { highWaterMark: 0 });
  return { request: new Request(origin + LOGIN_PATH, { method: 'POST', headers: { ...headers, ...overrides }, body }), cancel };
}

describe('standalone login HTTP routes using native D1/DO', () => {
  beforeEach(async () => {
    deps = { database: testEnv.DB, gates: testEnv.GATE, now: () => 2000, trustedOrigin: origin, trustedIp: () => '198.51.100.8',
      rateConfig: { ...DEFAULT_CONFIG, loginAccountFailureLimit: 5, loginIpAttemptLimit: 30 } };
    const nonce = issueCsrfToken();
    headers = { 'Content-Type': 'application/json', Origin: origin, Cookie: nonce.setCookie.split(';')[0]!, 'X-CSRF-Token': nonce.token };
    await testEnv.DB.prepare("INSERT INTO groups (id,name,status,version,created_at,updated_at) VALUES ('a08-group','A08 group','active',1,0,0)").run();
    await testEnv.DB.prepare(`INSERT INTO users (id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES ('a08-user','a08@example.invalid',?,'user','active','a08-group',2,60,'admin',0,0)`).bind(hash).run();
    verify = vi.spyOn(passwords, 'verifyPassword').mockResolvedValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('logs in with a real Argon2id hash and returns only public user data plus request ID', async () => {
    verify.mockRestore();
    const app = createLoginRoutes(deps);
    const response = await app.request(origin + LOGIN_PATH, { method: 'POST', headers, body: JSON.stringify(input) });
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Record<string, unknown>; request_id: string };
    expect(Object.keys(body)).toEqual(['data', 'request_id']);
    expect(body.data).toMatchObject({ id: 'a08-user', email_normalized: input.email, role: 'user' });
    expect(body.request_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.stringify(body)).not.toMatch(/password_hash|setCookie|s2a_session_|token_hash/);
    const setCookie = response.headers.get('Set-Cookie');
    expect(setCookie).toContain('Secure; HttpOnly; SameSite=Lax');
    expect(await readCookieSession(testEnv.DB, setCookie!.split(';')[0]!, 2000)).toMatchObject({ user_id: 'a08-user' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  }, 30_000);

  it('checks CSRF before reading the body or resolving IP and blocks anonymous cross-origin login', async () => {
    const pull = vi.fn(() => { throw new Error('Body must not be read'); });
    const trustedIp = vi.fn(deps.trustedIp);
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const response = await createLoginRoutes({ ...deps, trustedIp }).request(new Request(origin + LOGIN_PATH, {
      method: 'POST', headers: { ...headers, Origin: 'https://attacker.example' }, body,
    }));
    expect(response.status).toBe(403);
    expect(pull).not.toHaveBeenCalled();
    expect(trustedIp).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('rejects invalid JSON, non-JSON types and extra identity/IP fields with 400', async () => {
    const app = createLoginRoutes(deps);
    for (const body of ['{broken', '', 'null', '[]', JSON.stringify({ ...input, role: 'admin' }), JSON.stringify({ ...input, trustedIp: '1.2.3.4' }), JSON.stringify({ email: input.email })]) {
      const response = await app.request(origin + LOGIN_PATH, { method: 'POST', headers, body });
      expect(response.status).toBe(400);
      expect(response.headers.get('Set-Cookie')).toBeNull();
    }
    const response = await app.request(origin + LOGIN_PATH, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: JSON.stringify(input) });
    expect(response.status).toBe(400);
    expect(verify).not.toHaveBeenCalled();
  });

  it('accepts exactly 8 KiB and rejects streamed excess despite a false Content-Length', async () => {
    const app = createLoginRoutes(deps);
    const json = JSON.stringify(input);
    const exact = json + ' '.repeat(LOGIN_BODY_MAX_BYTES - encode(json).length);
    const accepted = streamRequest([encode(exact.slice(0, 200)), encode(exact.slice(200))]);
    expect((await app.request(accepted.request)).status).toBe(200);
    const before = verify.mock.calls.length;
    for (const contentLength of ['1', '8192']) {
      const oversized = streamRequest([encode(exact), encode(' '), encode('never-needed')], { 'Content-Length': contentLength });
      const denied = await app.request(oversized.request);
      expect(denied.status).toBe(413);
      expect(denied.headers.get('Set-Cookie')).toBeNull();
      expect(oversized.cancel).toHaveBeenCalled();
    }
    expect(verify).toHaveBeenCalledTimes(before);
  });

  it('counts UTF-8 bytes rather than characters and rejects malformed UTF-8', async () => {
    const app = createLoginRoutes(deps);
    const multibyte = JSON.stringify({ ...input, password: '界'.repeat(3000) });
    expect(multibyte.length).toBeLessThan(LOGIN_BODY_MAX_BYTES);
    expect(encode(multibyte).length).toBeGreaterThan(LOGIN_BODY_MAX_BYTES);
    expect((await app.request(streamRequest([encode(multibyte)]).request)).status).toBe(413);
    expect((await app.request(streamRequest([new Uint8Array([0xc3, 0x28])]).request)).status).toBe(400);
    expect(verify).not.toHaveBeenCalled();
  });

  it('returns 401 for wrong/unknown credentials without cookies or private error details', async () => {
    verify.mockResolvedValue(false);
    const app = createLoginRoutes(deps);
    for (const email of [input.email, 'unknown@example.invalid']) {
      const response = await app.request(origin + LOGIN_PATH, { method: 'POST', headers, body: JSON.stringify({ ...input, email }) });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: 'unauthorized', message: 'Authentication required.' }, request_id: expect.any(String) });
      expect(response.headers.get('Set-Cookie')).toBeNull();
    }
  });

  it('uses the trusted IP resolver even when clients forge connection headers and returns Retry-After', async () => {
    const app = createLoginRoutes({ ...deps, rateConfig: { ...DEFAULT_CONFIG, loginIpAttemptLimit: 1 } });
    expect((await app.request(origin + LOGIN_PATH, { method: 'POST', headers, body: JSON.stringify(input) })).status).toBe(200);
    const response = await app.request(origin + LOGIN_PATH, { method: 'POST', headers: { ...headers, 'CF-Connecting-IP': '203.0.113.1', 'X-Forwarded-For': '203.0.113.2' }, body: JSON.stringify(input) });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(verify).toHaveBeenCalledOnce();
  });

  it('resolves per-request bindings lazily and maps resolver/KDF/database failures to sanitized 503', async () => {
    const resolve = vi.fn((env: { database: D1Database }, request: Request) => {
      expect(request.url).toBe(origin + LOGIN_PATH);
      return { ...deps, database: env.database };
    });
    const app = createLoginRoutes(resolve);
    expect(resolve).not.toHaveBeenCalled();
    expect((await app.request(origin + LOGIN_PATH, { method: 'POST', headers, body: JSON.stringify(input) }, { database: testEnv.DB })).status).toBe(200);
    verify.mockRejectedValueOnce(new passwords.PasswordBusyError());
    const busy = await app.request(origin + LOGIN_PATH, { method: 'POST', headers, body: JSON.stringify(input) }, { database: testEnv.DB });
    expect(busy.status).toBe(503);
    const failed = createLoginRoutes(() => { throw new Error('private configuration details'); });
    const response = await failed.request(origin + LOGIN_PATH, { method: 'POST', headers, body: JSON.stringify(input) });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private configuration');
    const unavailable = createLoginRoutes({ ...deps, database: { prepare() { throw new Error('private database details'); } } as unknown as D1Database });
    const dbFailure = await unavailable.request(origin + LOGIN_PATH, { method: 'POST', headers, body: JSON.stringify(input) });
    expect(dbFailure.status).toBe(503);
    expect(dbFailure.headers.get('Set-Cookie')).toBeNull();
    expect(await dbFailure.text()).not.toContain('private database');
  });

  it('does not expose an alternate unguarded login route or implement other HTTP methods', async () => {
    const app = createLoginRoutes(deps);
    expect((await app.request(origin + '/login', { method: 'POST', headers, body: JSON.stringify(input) })).status).toBe(404);
    expect((await app.request(origin + LOGIN_PATH)).status).toBe(404);
    expect(verify).not.toHaveBeenCalled();
  });
});
