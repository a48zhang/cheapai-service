import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../../apps/worker/app';
import type { Env } from '../../apps/worker/env';
import { findEmailChallenge } from '../../apps/worker/auth/challenge-repository';
import { verifyEmailCode } from '../../apps/worker/auth/email-proof';
import { resolveEmailSender } from '../../apps/worker/auth/email-provider';
import { testEnv } from '../helpers/database';

// Native Request/fetch, crypto, D1, Gate RPC, registration KDF/triggers and sessions.
// Only the remote HTTP service is substituted by the host-side outbound fixture.
const origin = 'https://resend-integration.example';
const email = 'proof@example.invalid';
const key = 'fixture-hmac-key-32-bytes-minimum-length';
function bindings(mode = 'accepted'): Env {
  return { ...testEnv, ENVIRONMENT: 'production', PUBLIC_BASE_URL: origin,
    EMAIL_PROVIDER: 'resend', RESEND_API_KEY: `fixture-resend-${mode}`, EMAIL_VERIFICATION_READY: true,
    EMAIL_FROM: 'sender@example.invalid', EMAIL_HMAC_KEY: btoa(key) };
}
function entry(path: string, init: RequestInit = {}, env = bindings()) {
  // Synthetic trusted edge metadata; exercise the production IP-validation branch.
  return app.fetch(new Request(origin + path, { ...init, cf: { colo: 'HKG', httpProtocol: 'HTTP/3' } }), env);
}
async function bootstrap(env = bindings()) {
  const response = await entry('/api/v1/settings/public', {}, env);
  expect(response.status).toBe(200);
  const body = await response.json<{ data: { csrfToken: string; registrationMode: string } }>();
  expect(body.data.registrationMode).toBe('open');
  return { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.1',
    Cookie: response.headers.get('Set-Cookie')!.split(';')[0]!, 'X-CSRF-Token': body.data.csrfToken };
}
async function sentRequests() {
  const response = await fetch('https://resend-fixture.invalid/requests');
  return response.json<{ url: string; method: string; authorization: string; body: { from: string; to: string[]; subject: string; text: string } }[]>();
}
const send = (headers: Record<string, string>, env = bindings()) => entry('/api/v1/auth/send-verify-code', {
  method: 'POST', headers, body: JSON.stringify({ email }),
}, env);

beforeEach(async () => {
  await fetch('https://resend-fixture.invalid/reset', { method: 'POST' });
  await testEnv.DB.prepare('UPDATE settings SET value_json=?,version=version+1 WHERE key=?')
    .bind(JSON.stringify({ registrationMode: 'open', emailVerificationEnabled: true }), 'registration').run();
});

describe('Resend registration through native Workers HTTP', () => {
  it('sends once, verifies the persisted proof, and registers with the code captured at the HTTP boundary', async () => {
    const headers = await bootstrap();
    const response = await send(headers);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ data: { status: 'accepted', retry_after_ms: 60_000 } });
    const requests = await sentRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: 'https://api.resend.com/emails', method: 'POST',
      authorization: 'Bearer fixture-resend-accepted', body: { from: 'sender@example.invalid', to: [email], subject: '注册邮箱验证码' } });
    const code = /验证码是：([0-9]{6})/.exec(requests[0]!.body.text)![1]!;
    const challenge = (await findEmailChallenge(testEnv.DB, email, 'registration'))!;
    expect(challenge).toMatchObject({ generation: 1, send_status: 'accepted', consumed_at: null });
    expect(await verifyEmailCode(new TextEncoder().encode(key), { email, purpose: 'registration', generation: 1, code }, challenge.code_mac)).toBe(true);
    const registered = await entry('/api/v1/auth/register', { method: 'POST', headers,
      body: JSON.stringify({ email, password: 'native-runtime-fixture-password', emailCode: code }) });
    expect(registered.status).toBe(201);
    const consumed = (await findEmailChallenge(testEnv.DB, email, 'registration'))!;
    expect(consumed.consumed_at).not.toBeNull();
    const session = registered.headers.get('Set-Cookie')!.split(';')[0]!;
    const me = await entry('/api/v1/auth/me', { headers: { Cookie: session } });
    expect(me.status).toBe(200);
    expect(await sentRequests()).toHaveLength(1);
  });

  it.each([401, 403, 429, 500, 503])('reaches the provider and persists HTTP %i failures without exposing details', async status => {
    const env = bindings(String(status));
    const response = await send(await bootstrap(env), env);
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(await response.text()).not.toContain('Fixture provider rejection');
    expect(await sentRequests()).toHaveLength(1);
    expect(await findEmailChallenge(testEnv.DB, email, 'registration')).toMatchObject({ send_status: status < 500 ? 'failed' : 'unknown' });
  });

  it.each([301, 302, 303, 307, 308])('does not follow HTTP %i or forward email/key to a redirect target', async status => {
    for (const target of ['same', 'cross']) {
      // Native fetch directly exercises each redirect independently of cooldown.
      const sender = resolveEmailSender(bindings(`redirect-${status}-${target}`))!;
      await expect(sender.send({ from: 'sender@example.invalid', to: email, subject: 'Fixture', text: 'Fixture code' }))
        .rejects.toThrow(`Resend redirect rejected (HTTP ${status})`);
    }
    const requests = await sentRequests();
    expect(requests).toHaveLength(2);
    expect(requests.every(request => request.url === 'https://api.resend.com/emails')).toBe(true);
  });

  it('admits only one concurrent send through native D1 and Gate', async () => {
    const headers = await bootstrap();
    const responses = await Promise.all(Array.from({ length: 4 }, () => send(headers)));
    expect(responses.map(response => response.status).sort()).toEqual([202, 429, 429, 429]);
    expect(await sentRequests()).toHaveLength(1);
    expect(await findEmailChallenge(testEnv.DB, email, 'registration')).toMatchObject({ generation: 1, send_status: 'accepted' });
  });
});
