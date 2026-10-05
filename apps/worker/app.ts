import { Hono } from 'hono';
import { routes } from './routes';
import type { Env } from './env';
import { apiError, createRequestId } from './http';

export const app = new Hono<{ Bindings: Env }>();

app.onError((error) => apiError(error, createRequestId()));

const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";
const apiPrefixes = ['/api', '/v1', '/healthz'] as const;
function workerPath(path: string): boolean {
  return apiPrefixes.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}
function trustedOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return undefined;
    if (value !== url.origin && value !== `${url.origin}/`) return undefined;
    return url.origin;
  } catch { return undefined; }
}
function configuredOrigin(env: Env): string | undefined {
  try { return trustedOrigin(env.PUBLIC_BASE_URL); } catch { return undefined; }
}
function appendVary(headers: Headers, value: string): void {
  const values = new Set((headers.get('Vary') ?? '').split(',').map(item => item.trim()).filter(Boolean));
  values.add(value); headers.set('Vary', [...values].join(', '));
}
function applySecurityHeaders(response: Response, origin?: string, requestOrigin?: string, path?: string): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Content-Security-Policy', csp);
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (path !== undefined && workerPath(path)) headers.set('Cache-Control', 'no-store');
  if (requestOrigin !== undefined && path !== undefined && workerPath(path)) {
    appendVary(headers, 'Origin');
    if (origin !== undefined && requestOrigin === origin) headers.set('Access-Control-Allow-Origin', origin);
    else headers.delete('Access-Control-Allow-Origin');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// Keep API responses in the Worker path while permitting only the configured
// console origin to use browser CORS. No credentialed CORS is enabled.
app.use('*', async (context, next) => {
  const startedAt = Date.now();
  const details = { method: context.req.method, path: context.req.path };
  if (workerPath(context.req.path)) console.debug('HTTP request started', details);
  await next();
  context.res = applySecurityHeaders(context.res, configuredOrigin(context.env), context.req.header('Origin'), context.req.path);
  if (workerPath(context.req.path)) console.debug('HTTP request completed', {
    ...details, status: context.res.status, elapsed_ms: Date.now() - startedAt,
  });
});

// Production's www alias is only an entry point: keep cookies, CSRF and API
// requests on the configured canonical HTTPS origin, preserving path and query.
app.use('*', async (context, next) => {
  const origin = configuredOrigin(context.env);
  if (context.env.ENVIRONMENT === 'production' && origin !== undefined) {
    const canonical = new URL(origin);
    const target = new URL(context.req.url);
    if (target.hostname === `www.${canonical.hostname}`) {
      target.protocol = canonical.protocol;
      target.host = canonical.host;
      return context.redirect(target.toString(), 308);
    }
  }
  await next();
});

app.options('/v1/*', context => {
  const origin = configuredOrigin(context.env);
  const requestOrigin = context.req.header('Origin');
  if (origin === undefined || requestOrigin !== origin) return context.json({ error: { code: 'forbidden', message: 'Permission denied.' } }, 403);
  const requestedMethod = context.req.header('Access-Control-Request-Method');
  if (requestedMethod !== undefined && !['GET', 'POST'].includes(requestedMethod.toUpperCase())) {
    return context.json({ error: { code: 'invalid_request', message: 'Invalid request.' } }, 400);
  }
  const requestedHeaders = context.req.header('Access-Control-Request-Headers');
  if (requestedHeaders !== undefined) {
    const allowed = new Set(['authorization', 'content-type', 'x-api-key', 'anthropic-beta', 'anthropic-version']);
    const names = requestedHeaders.split(',').map(value => value.trim().toLowerCase());
    if (names.some(value => !value || !allowed.has(value))) return context.json({ error: { code: 'invalid_request', message: 'Invalid request.' } }, 400);
  }
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Api-Key, Anthropic-Beta, Anthropic-Version',
    'Access-Control-Max-Age': '600', Vary: 'Origin',
  } });
});

app.route('/', routes);

// Static Assets owns the SPA fallback for front-end routes. Reserved Worker
// prefixes stay JSON so an unknown API path can never become HTML.
app.notFound(async context => {
  if (!workerPath(context.req.path)) {
    try {
      const assets = context.env.ASSETS;
      if (assets && typeof assets.fetch === 'function') {
        const response = await assets.fetch(context.req.raw);
        if (response.status !== 404) return response;
      }
    } catch (error) { console.error('Static asset fetch failed', { path: context.req.path }, error); }
  }
  return context.json({ error: { code: 'not_found', message: 'Resource not found.' }, request_id: crypto.randomUUID() }, 404);
});
