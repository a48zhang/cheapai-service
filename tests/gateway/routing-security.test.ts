import { describe, expect, it, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { app } from '../../apps/worker/app';
import type { Env } from '../../apps/worker/env';
import { testEnv } from '../helpers/database';

const origin = 'https://console.example';
function environment(assets: Fetcher): Env {
  return { ...testEnv, ENVIRONMENT: 'local', PUBLIC_BASE_URL: origin, ASSETS: assets } as Env;
}
async function call(path: string, init: RequestInit = {}, assets = vi.fn(async () => new Response('<!doctype html><html></html>', { headers: { 'Content-Type': 'text/html' } }))) {
  const assetBinding = { fetch: assets } as unknown as Fetcher;
  const context = createExecutionContext();
  const response = await app.fetch(new Request(origin + path, init), environment(assetBinding), context);
  const text = await response.text(); await waitOnExecutionContext(context);
  return { response, text, assets };
}

describe('G23 Worker/static routing and response security', () => {
  it('keeps reserved API paths as structured JSON and serves front-end paths from ASSETS', async () => {
    const assets = vi.fn(async () => new Response('<!doctype html><html><body>app</body></html>', { headers: { 'Content-Type': 'text/html' } }));
    const page = await call('/settings', {}, assets);
    expect(page.response.status).toBe(200); expect(page.text).toContain('<!doctype html>'); expect(assets).toHaveBeenCalledOnce();
    expect(page.response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(page.response.headers.get('X-Content-Type-Options')).toBe('nosniff');

    for (const path of ['/api/unknown', '/v1/unknown', '/healthz']) {
      const result = await call(path, {}, assets);
      expect(result.response.status, path).toBe(path === '/healthz' ? 200 : 404);
      expect(result.text, path).not.toContain('<!doctype html>');
    }
    expect(assets).toHaveBeenCalledOnce();
  });

  it('allows only the configured origin to preflight/use gateway CORS without credentials', async () => {
    const allowed = await call('/v1/models', { method: 'OPTIONS', headers: {
      Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Authorization',
    } });
    expect(allowed.response.status).toBe(204);
    expect(allowed.response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(allowed.response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect(allowed.response.headers.get('Access-Control-Allow-Headers')).toMatch(/Authorization/);

    const actual = await call('/v1/models', { headers: { Origin: origin } });
    expect(actual.response.status).toBe(401); expect(actual.response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(actual.response.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect(actual.response.headers.get('Vary')).toMatch(/Origin/);

    const evil = await call('/v1/models', { headers: { Origin: 'https://evil.example' } });
    expect(evil.response.status).toBe(401); expect(evil.response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const deniedPreflight = await call('/v1/models', { method: 'OPTIONS', headers: {
      Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET',
    } });
    expect(deniedPreflight.response.status).toBe(403); expect(deniedPreflight.response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('adds security headers to native errors while authentication remains required', async () => {
    const result = await call('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(result.response.status).toBe(401); expect(JSON.parse(result.text)).toHaveProperty('error');
    expect(result.response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(result.response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(result.response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(result.response.headers.get('Permissions-Policy')).toContain('camera=()');
  });
});
