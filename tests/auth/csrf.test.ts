import { Hono } from '../../apps/worker/node_modules/hono';
import { describe, expect, it } from 'vitest';
import { CSRF_COOKIE_NAME, issueCsrfToken, requireCsrf, validateCsrfRequest } from '../../apps/worker/auth/csrf';

const origin = 'https://console.example.com';
function cookie(token: string): string { return `${CSRF_COOKIE_NAME}=${token}`; }
function request(token: string, changes: Record<string, string> = {}, path = '/api/v1/login', method = 'POST'): Request {
  return new Request(`${origin}${path}`, { method, headers: { Origin: origin, Cookie: cookie(token), 'X-CSRF-Token': token, ...changes } });
}

describe('management double-submit CSRF protection in Workers', () => {
  it('issues 256-bit canonical nonces anonymously with exact host cookie attributes', () => {
    const issued = Array.from({ length: 32 }, () => issueCsrfToken());
    expect(new Set(issued.map((item) => item.token)).size).toBe(32);
    for (const item of issued) {
      expect(item.token).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
      expect(atob(item.token.replace(/-/g, '+').replace(/_/g, '/'))).toHaveLength(32);
      expect(item.setCookie).toBe(`${cookie(item.token)}; Secure; Path=/; SameSite=Strict`);
      expect(item.setCookie).not.toMatch(/HttpOnly|Domain=/i);
      expect(item.cacheControl).toBe('no-store');
    }
  });

  it('reuses a valid anonymous nonce without rotating another tab out', () => {
    const original = issueCsrfToken();
    expect(issueCsrfToken(`unrelated=abc; ${cookie(original.token)}`)).toEqual(original);
    expect(() => validateCsrfRequest(request(original.token), origin)).not.toThrow();
  });

  it('allows anonymous settings bootstrap followed by a guarded login using real Hono requests', async () => {
    const app = new Hono();
    app.use('*', requireCsrf(origin));
    app.get('/api/v1/settings', (context) => {
      const nonce = issueCsrfToken(context.req.header('Cookie') ?? null);
      context.header('Set-Cookie', nonce.setCookie);
      context.header('Cache-Control', nonce.cacheControl);
      return context.json({ csrfToken: nonce.token });
    });
    app.post('/api/v1/login', (context) => context.json({ reachedLogin: true }));
    const settings = await app.request(`${origin}/api/v1/settings`);
    expect(settings.status).toBe(200);
    expect(settings.headers.get('Cache-Control')).toBe('no-store');
    const payload = await settings.json() as { csrfToken: string };
    const setCookie = settings.headers.get('Set-Cookie');
    expect(setCookie).toContain(cookie(payload.csrfToken));
    const response = await app.request(request(payload.csrfToken));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reachedLogin: true });
  });

  it('rejects missing, cross-origin, null, duplicate and deceptively similar Origin values', () => {
    const token = issueCsrfToken().token;
    for (const attackerOrigin of ['', 'null', 'https://attacker.example', `${origin}.attacker.example`, `${origin}/`, `${origin}, ${origin}`, 'http://console.example.com', 'https://console.example.com:444']) {
      expect(() => validateCsrfRequest(request(token, { Origin: attackerOrigin }), origin)).toThrow();
    }
    const missing = request(token);
    missing.headers.delete('Origin');
    missing.headers.set('Referer', `${origin}/login`);
    missing.headers.set('X-Forwarded-Host', 'console.example.com');
    expect(() => validateCsrfRequest(missing, origin)).toThrow();
  });

  it('rejects duplicate, missing or malformed CSRF cookies and noncanonical tokens', () => {
    const token = issueCsrfToken().token;
    const invalid = ['', `${cookie(token)}; ${cookie(token)}`, `${CSRF_COOKIE_NAME}=`, CSRF_COOKIE_NAME,
      `${CSRF_COOKIE_NAME} =${token}`, `${CSRF_COOKIE_NAME}="${token}"`, `${CSRF_COOKIE_NAME}=${token}=`,
      `${CSRF_COOKIE_NAME}=%41${token.slice(1)}`, `${CSRF_COOKIE_NAME}=${'A'.repeat(42)}B`, `${CSRF_COOKIE_NAME}=short`];
    for (const value of invalid) {
      expect(() => validateCsrfRequest(request(token, { Cookie: value }), origin)).toThrow();
      if (value !== '') expect(() => issueCsrfToken(value)).toThrow();
    }
    for (const value of [`${cookie(token)}\n`, `${cookie(token)}\r\n`, `${cookie(token)} `, `${cookie(token)}\t`, 'x'.repeat(8193)]) expect(() => issueCsrfToken(value)).toThrow();
  });

  it('requires the same canonical token in both places and never reads it from the body', () => {
    const token = issueCsrfToken().token;
    for (const header of ['', 'short', `${token}=`, `${token}, ${token}`, issueCsrfToken().token]) {
      expect(() => validateCsrfRequest(request(token, { 'X-CSRF-Token': header }), origin)).toThrow();
    }
    const bodyOnly = new Request(`${origin}/api/v1/login`, { method: 'POST', headers: { Origin: origin, Cookie: cookie(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ csrfToken: token, trustedOrigin: origin }) });
    expect(() => validateCsrfRequest(bodyOnly, origin)).toThrow();
  });

  it('covers every management write verb but skips read/bootstrap and platform-key routes', () => {
    const token = issueCsrfToken().token;
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const path of ['/api', '/api/', '/api/v1/login', '/api/v1/register', '/api/v1/admin/channels']) {
        expect(() => validateCsrfRequest(request(token, {}, path, method), origin)).not.toThrow();
        expect(() => validateCsrfRequest(new Request(`${origin}${path}`, { method }), origin)).toThrow();
      }
    }
    for (const method of ['GET', 'HEAD', 'OPTIONS']) expect(() => validateCsrfRequest(new Request(`${origin}/api/v1/settings`, { method }), origin)).not.toThrow();
    for (const path of ['/v1/chat/completions', '/v1/messages', '/healthz', '/api-other']) {
      expect(() => validateCsrfRequest(new Request(`${origin}${path}`, { method: 'POST' }), origin)).not.toThrow();
    }
  });

  it('returns sanitized 403 without running a protected Hono handler, while preserving request IDs', async () => {
    const app = new Hono<{ Variables: { requestId: string } }>();
    app.use('*', async (context, next) => { context.set('requestId', 'trusted-request-id'); await next(); });
    app.use('*', requireCsrf(origin));
    app.post('/api/v1/admin/channels', (context) => context.json({ shouldNotRun: true }));
    app.post('/v1/messages', (context) => context.json({ gatewayReached: true }));
    const denied = await app.request(`${origin}/api/v1/admin/channels`, { method: 'POST', headers: { Origin: 'https://attacker.example' } });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: { code: 'forbidden', message: 'Permission denied.' }, request_id: 'trusted-request-id' });
    const gateway = await app.request(`${origin}/v1/messages`, { method: 'POST' });
    expect(gateway.status).toBe(200);
    expect(await gateway.json()).toEqual({ gatewayReached: true });
  });

  it('requires explicitly configured canonical HTTPS origin instead of deriving trust from requests', () => {
    for (const invalid of ['*', 'null', 'http://console.example.com', `${origin}/`, `${origin}/path`, 'https://user:password@console.example.com', `${origin}?x=1`, 'HTTPS://console.example.com']) {
      expect(() => requireCsrf(invalid)).toThrow(TypeError);
    }
    const token = issueCsrfToken().token;
    const attacker = new Request('https://attacker.example/api/login', { method: 'POST', headers: { Origin: 'https://attacker.example', Cookie: cookie(token), 'X-CSRF-Token': token } });
    expect(() => validateCsrfRequest(attacker, origin)).toThrow();
  });
});
