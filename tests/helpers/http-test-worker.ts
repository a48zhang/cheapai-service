/** Local browser-test entry only. Never used by the production Wrangler config. */
import worker from '../../apps/worker/index';
import type { Env } from '../../apps/worker/env';
export { Gate } from '../../apps/worker/limits/gate';
export { ImageGenerationJob } from '../../apps/worker/images/job';

interface TestEnv extends Env { E2E_CONTROL_TOKEN: string; E2E_UPSTREAM_URL?: string }
const calls: { protocol: string; model: string; stream: boolean; platformCredentialLeaked: boolean }[] = [];
import { body, stream } from './provider-fixture';
// Test-only boundary: use real HTTP for the independent loopback supplier; all other external traffic stays blocked.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init); const url = new URL(request.url);
  if (url.hostname === '127.0.0.1' && url.pathname.startsWith('/v1/')) return nativeFetch(request);
  if (url.origin !== 'https://e2e-upstream.example.invalid' || request.method !== 'POST') throw new Error('External fetch is disabled in the local test Worker.');
  const protocol = url.pathname.endsWith('/chat/completions') ? 'chat' : url.pathname.endsWith('/responses') ? 'responses' : url.pathname.endsWith('/messages') ? 'messages' : url.pathname.endsWith('/images/generations') ? 'images' : '';
  if (!protocol) throw new Error('Unknown fixture endpoint.');
  const payload = await request.json<{ model: string; stream?: boolean }>();
  if (calls.length >= 200) throw new Error('Local fixture call budget exceeded.');
  calls.push({ protocol, model: payload.model, stream: payload.stream === true,
    platformCredentialLeaked: [...request.headers.values()].some(value => value.includes('s2a_key_')) });
  if (protocol === 'images') return Response.json({ data: [{ b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK5kAAAAASUVORK5CYII=' }] });
  const id = `fixture_${crypto.randomUUID().replaceAll('-', '')}`;
  return payload.stream === true ? stream(protocol, payload.model, id) : Response.json(body(protocol, payload.model, id));
}) as typeof fetch;

export default { async fetch(request: Request, env: TestEnv, context: ExecutionContext) {
  const url = new URL(request.url);
  if (env.ENVIRONMENT !== 'local' || url.hostname !== '127.0.0.1') return new Response('Local test entry only', { status: 403 });
  if (url.pathname.startsWith('/__test__/')) {
    if (!env.E2E_CONTROL_TOKEN || request.headers.get('X-E2E-Control') !== env.E2E_CONTROL_TOKEN) return new Response('Not found', { status: 404 });
    if (url.pathname === '/__test__/policy' && request.method === 'POST') {
      const value = await request.json<{ registrationMode: string; emailVerificationEnabled: boolean }>();
      if (!['closed', 'open', 'invite'].includes(value.registrationMode) || typeof value.emailVerificationEnabled !== 'boolean') return new Response('Invalid fixture policy', { status: 400 });
      await env.DB.prepare("UPDATE settings SET value_json=?,version=version+1,updated_at=? WHERE key='registration'").bind(JSON.stringify(value), Date.now()).run();
      return Response.json({ ok: true });
    }
    if (url.pathname === '/__test__/mail' && request.method === 'GET') {
      const mail = await env.CACHE.get(`e2e:mail:${url.searchParams.get('email') ?? ''}`);
      return new Response(mail ?? '{}', { status: mail ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/__test__/age-challenge' && request.method === 'POST') {
      const { email } = await request.json<{ email: string }>();
      await env.DB.prepare("UPDATE email_challenges SET created_at=created_at-61000,updated_at=updated_at-61000,send_requested_at=send_requested_at-61000 WHERE email_normalized=? AND consumed_at IS NULL").bind(email).run();
      return Response.json({ ok: true });
    }
    if (url.pathname === '/__test__/calls' && request.method === 'GET') {
      if (env.E2E_UPSTREAM_URL) return nativeFetch(`${env.E2E_UPSTREAM_URL}/__calls`, { headers: { 'X-E2E-Control': env.E2E_CONTROL_TOKEN } });
      return Response.json({ calls });
    }
    return new Response('Not found', { status: 404 });
  }
  const email = { async send(message: { to?: unknown; text?: unknown }) {
    if (typeof message.to !== 'string' || typeof message.text !== 'string') throw new Error('Unexpected local email shape');
    const code = message.text.match(/\b[0-9]{6}\b/)?.[0];
    if (!code) throw new Error('Missing local email code');
    const key = `e2e:mail:${message.to}`;
    const previous = await env.CACHE.get<{ count: number }>(key, 'json');
    await env.CACHE.put(key, JSON.stringify({ code, count: (previous?.count ?? 0) + 1 }), { expirationTtl: 600 });
    return { messageId: `local-${crypto.randomUUID()}` };
  } };
  return worker.fetch(request, { ...env, EMAIL: email as unknown as SendEmail }, context);
} };
