import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../../apps/worker/app';
import type { Env } from '../../apps/worker/env';
import * as passwords from '../../apps/worker/auth/password';
import { generateToken, getTokenDisplayPrefix, hashToken } from '../../apps/worker/auth/tokens';
import { testEnv } from '../helpers/database';

// Complements auth-entry's real KDF test. Here only KDF and external email are
// stubbed; production routing, CSRF, HMAC, D1 triggers, sessions and Gate are real.
const origin = 'https://integration.example';
const email = 'proof-entry@example.invalid';
const password = 'a long integration password';
let deliveredCode: string | undefined;
const send = vi.fn(async (message: EmailMessageBuilder) => {
  deliveredCode = /验证码是：([0-9]{6})/.exec(message.text ?? '')?.[1];
  return { messageId: 'mock-provider-acceptance' };
});
function bindings(): Env {
  return { ...testEnv, ENVIRONMENT: 'local', PUBLIC_BASE_URL: origin, EMAIL_VERIFICATION_READY: true,
    EMAIL_FROM: 'sender@example.invalid', EMAIL_HMAC_KEY: btoa('fixture-key-only-not-a-secret-1234'), EMAIL: { send } as Env['EMAIL'] };
}
function entry(path: string, init: RequestInit = {}) { return app.fetch(new Request(origin + path, init), bindings()); }
async function policy(registrationMode: 'open' | 'closed' | 'invite', emailVerificationEnabled = true) {
  await testEnv.DB.prepare('UPDATE settings SET value_json=?,version=version+1,updated_at=? WHERE key=?')
    .bind(JSON.stringify({ registrationMode, emailVerificationEnabled }), Date.now(), 'registration').run();
}
async function bootstrap() {
  const response = await entry('/api/v1/settings/public'); expect(response.status).toBe(200);
  const body = await response.json<{ data: { csrfToken: string } }>();
  return { Origin: origin, 'Content-Type': 'application/json', Cookie: response.headers.get('Set-Cookie')!.split(';')[0]!, 'X-CSRF-Token': body.data.csrfToken };
}
async function invitation() {
  const now = Date.now();
  await testEnv.DB.prepare(`INSERT INTO users
    (id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES ('entry-admin','entry-admin@example.invalid','test-only-admin-hash','admin','active','default',0,2,60,'admin',?,?)`).bind(now, now).run();
  const token = generateToken('invitation'); const id = crypto.randomUUID();
  await testEnv.DB.prepare(`INSERT INTO registration_codes
    (id,code_hash,display_prefix,expires_at,created_by,created_at,operation_id,ordinal) VALUES (?,?,?,?,?,?,?,0)`)
    .bind(id, await hashToken('invitation', token), getTokenDisplayPrefix('invitation', token), now + 600_000, 'entry-admin', now - 1, crypto.randomUUID()).run();
  return { token, id };
}
async function sendProof(headers: Record<string, string>) {
  const response = await entry('/api/v1/auth/send-verify-code', { method: 'POST', headers, body: JSON.stringify({ email }) });
  expect(response.status).toBe(202); expect(await response.json()).toMatchObject({ data: { status: 'accepted' } });
  expect(deliveredCode).toMatch(/^[0-9]{6}$/); expect(send).toHaveBeenCalledTimes(1);
  return deliveredCode!;
}
async function registeredCount() {
  return (await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE created_via='registration'").first<{ n: number }>())?.n;
}

beforeEach(() => {
  deliveredCode = undefined; send.mockClear();
  vi.spyOn(passwords, 'hashPassword').mockResolvedValue('test-only-cross-module-kdf-hash');
  vi.spyOn(passwords, 'verifyPassword').mockResolvedValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe('additional production auth-entry transaction coverage', () => {
  it('rechecks closed policy after an earlier open bootstrap, before KDF/user/session side effects', async () => {
    await policy('open', false); const headers = await bootstrap(); await policy('closed', false);
    const response = await entry('/api/v1/auth/register', { method: 'POST', headers, body: JSON.stringify({ email, password }) });
    expect(response.status).toBe(403); expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(await response.json()).toMatchObject({ error: { code: 'forbidden' } });
    expect(await registeredCount()).toBe(0); expect(passwords.hashPassword).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

  it('uses mock-delivered proof through the real endpoint, consumes both credentials atomically and restores login', async () => {
    await policy('invite'); const invite = await invitation(); const headers = await bootstrap(); const code = await sendProof(headers);
    const wrongCode = code === '000000' ? '111111' : '000000';
    const wrong = await entry('/api/v1/auth/register', { method: 'POST', headers,
      body: JSON.stringify({ email, password, registrationCode: invite.token, emailCode: wrongCode }) });
    expect(wrong.status).toBe(400); expect(wrong.headers.get('Set-Cookie')).toBeNull();
    expect(await testEnv.DB.prepare('SELECT used_by,used_at FROM registration_codes WHERE id=?').bind(invite.id).first()).toEqual({ used_by: null, used_at: null });
    expect(await testEnv.DB.prepare('SELECT attempts,consumed_at FROM email_challenges WHERE email_normalized=?').bind(email).first()).toEqual({ attempts: 1, consumed_at: null });
    expect(await registeredCount()).toBe(0); expect(passwords.hashPassword).not.toHaveBeenCalled();
    const response = await entry('/api/v1/auth/register', { method: 'POST', headers,
      body: JSON.stringify({ email, password, registrationCode: invite.token, emailCode: code }) });
    expect(response.status).toBe(201);
    const body = await response.json<{ data: { user: { id: string }; session: string } }>();
    expect(body.data.session).toBe('created'); const id = body.data.user.id;
    const user = await testEnv.DB.prepare('SELECT created_at,email_verified_at,registration_code_id FROM users WHERE id=?').bind(id).first<{ created_at: number; email_verified_at: number; registration_code_id: string }>();
    expect(user?.registration_code_id).toBe(invite.id); expect(user?.email_verified_at).toBe(user?.created_at);
    expect(await testEnv.DB.prepare('SELECT used_by,used_at FROM registration_codes WHERE id=?').bind(invite.id).first()).toEqual({ used_by: id, used_at: user!.created_at });
    expect(await testEnv.DB.prepare('SELECT consumed_at FROM email_challenges WHERE email_normalized=?').bind(email).first()).toEqual({ consumed_at: user!.created_at });
    const cookie = response.headers.get('Set-Cookie')!.split(';')[0]!;
    const me = await entry('/api/v1/auth/me', { headers: { Cookie: cookie } }); expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ data: { id, email_verified_at: user!.created_at } });
    const login = await entry('/api/v1/auth/login', { method: 'POST', headers, body: JSON.stringify({ email, password }) });
    expect(login.status).toBe(200); expect(login.headers.get('Set-Cookie')).toContain('HttpOnly');
    const replay = await entry('/api/v1/auth/register', { method: 'POST', headers,
      body: JSON.stringify({ email, password, registrationCode: invite.token, emailCode: code }) });
    expect(replay.status).toBe(400); expect(await registeredCount()).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('admits only one concurrent registration for the same invitation and email proof', async () => {
    await policy('invite'); const invite = await invitation(); const headers = await bootstrap(); const code = await sendProof(headers);
    const body = JSON.stringify({ email, password, registrationCode: invite.token, emailCode: code });
    const responses = await Promise.all([entry('/api/v1/auth/register', { method: 'POST', headers, body }), entry('/api/v1/auth/register', { method: 'POST', headers, body })]);
    const successes = responses.filter(response => response.status === 201);
    expect(successes).toHaveLength(1);
    const rejected = responses.find(response => response.status !== 201)!;
    expect([400, 409]).toContain(rejected.status); expect(rejected.headers.get('Set-Cookie')).toBeNull();
    expect(await registeredCount()).toBe(1);
    const winner = await successes[0]!.json<{ data: { user: { id: string } } }>();
    expect(await testEnv.DB.prepare('SELECT used_by FROM registration_codes WHERE id=?').bind(invite.id).first()).toEqual({ used_by: winner.data.user.id });
    const sessions = await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?').bind(winner.data.user.id).first<{ n: number }>();
    expect(sessions?.n).toBe(1); expect(send).toHaveBeenCalledTimes(1);
  });

});
