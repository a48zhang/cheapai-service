import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { app } from '../../apps/worker/app';
import type { Env } from '../../apps/worker/env';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { issueCsrfToken } from '../../apps/worker/auth/csrf';
import { generateToken, hashToken } from '../../apps/worker/auth/tokens';
import { testEnv } from '../helpers/database';

const origin = 'https://q10.example';
const group = 'q10-group';
const admin = 'q10-admin';
const owner = 'q10-owner';
const other = 'q10-other';
const model = 'q10-model';
const channel = 'q10-channel';
let env: Env;
let adminCookie: string;
let ownerCookie: string;
let ownerKey: string;
let ownerSecondKey: string;
let otherKey: string;
let ownerKeyId: string;
let otherKeyId: string;

const chatBody = () => ({ model, messages: [{ role: 'user', content: 'Q10 synthetic input' }] });
const chatReply = () => Response.json({ id: 'q10-upstream-response', object: 'chat.completion', created: 1, model: 'q10-upstream',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Q10 output' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });
function writeHeaders(cookie: string, options: { origin?: string; csrf?: boolean } = {}): Record<string, string> {
  const nonce = issueCsrfToken();
  return { Cookie: `${cookie}; ${nonce.setCookie.split(';')[0]}`, 'Content-Type': 'application/json',
    ...(options.origin === undefined ? { Origin: origin } : { Origin: options.origin }),
    ...(options.csrf === false ? {} : { 'X-CSRF-Token': nonce.token }) };
}
async function call(path: string, init: RequestInit = {}, bindings: Env = env) {
  const context = createExecutionContext();
  const response = await app.fetch(new Request(origin + path, init), bindings, context);
  const text = await response.text(); await waitOnExecutionContext(context);
  return { response, text };
}
async function addKey(id: string, userId: string): Promise<string> {
  const token = generateToken('apiKey');
  await testEnv.DB.prepare(`INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at)
    VALUES(?,?,?,'s2a_key_ABCDEFGH','Q10','active',0,0)`).bind(id, userId, await hashToken('apiKey', token)).run();
  return token;
}

beforeEach(async () => {
  const now = Date.now();
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('q10-group','Q10','active',1,?,?)").bind(now, now).run();
  for (const [id, role] of [[admin, 'admin'], [owner, 'user'], [other, 'user']] as const) {
    await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES(?,?, 'test-only',?,'active','q10-group',1000000,2,60,'bootstrap',?,?)`).bind(id, `${id}@example.invalid`, role, now, now).run();
  }
  adminCookie = (await createCookieSession(testEnv.DB, admin, now)).setCookie.split(';')[0]!;
  ownerCookie = (await createCookieSession(testEnv.DB, owner, now)).setCookie.split(';')[0]!;
  ownerKeyId = 'q10-owner-key'; otherKeyId = 'q10-other-key';
  ownerKey = await addKey(ownerKeyId, owner); ownerSecondKey = await addKey('q10-owner-key-second', owner); otherKey = await addKey(otherKeyId, other);

  const credential = 'q10-private-upstream-key';
  env = { ...testEnv, ENVIRONMENT: 'local', PUBLIC_BASE_URL: origin,
     } as Env;
  await testEnv.DB.prepare(`INSERT INTO channels(id,name,base_url,upstream_key,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES(?,?,?,?,'active',1,2,60,1,0,0)`).bind(channel, 'Q10', 'https://provider-q10.example.invalid', credential).run();
  await testEnv.DB.prepare("INSERT INTO channel_groups(channel_id,group_id) VALUES('q10-channel','q10-group')").run();
  await testEnv.DB.prepare(`INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES ('q10-model','active','{"input":"1","output":"2"}',1,0,64,0,0)`).run();
  await testEnv.DB.prepare(`INSERT INTO channel_models(channel_id,public_model_id,upstream_model,protocol,capabilities_json,config_version)
    VALUES('q10-channel','q10-model','q10-upstream','chat','{"protocol":"chat","features":["streaming","stream_usage"],"maxOutputTokens":64}',1)`).run();
});

describe('Q10 HTTP permission and security boundaries through the Worker', () => {
  it('honors Key revocation and user disablement on the next gateway admission', async () => {
    const upstream = vi.fn(async () => chatReply()); vi.stubGlobal('fetch', upstream);
    const first = await call('/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${ownerKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(chatBody()) });
    expect(first.response.status).toBe(200); expect(upstream).toHaveBeenCalledOnce();

    const revoke = await call(`/api/v1/admin/keys/${ownerKeyId}/revoke`, { method: 'POST', headers: writeHeaders(adminCookie), body: JSON.stringify({ version: 1 }) });
    expect(revoke.response.status).toBe(200);
    const revoked = await call('/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${ownerKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(chatBody()) });
    expect(revoked.response.status).toBe(401); expect(upstream).toHaveBeenCalledOnce();

    const second = await call('/v1/chat/completions', { method: 'POST', headers: { 'x-api-key': ownerSecondKey, 'Content-Type': 'application/json' }, body: JSON.stringify(chatBody()) });
    expect(second.response.status).toBe(200); expect(upstream).toHaveBeenCalledTimes(2);
    const disabled = await call(`/api/v1/admin/users/${owner}`, { method: 'PATCH', headers: writeHeaders(adminCookie), body: JSON.stringify({ version: 1, status: 'disabled' }) });
    expect(disabled.response.status).toBe(200);
    const stopped = await call('/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${ownerSecondKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(chatBody()) });
    expect(stopped.response.status).toBe(401); expect(upstream).toHaveBeenCalledTimes(2);
    expect(await testEnv.DB.prepare("SELECT status FROM api_keys WHERE id='q10-owner-key'").first('status')).toBe('revoked');
    expect(await testEnv.DB.prepare("SELECT status FROM users WHERE id='q10-owner'").first('status')).toBe('disabled');
  });

  it('keeps IDs and management scopes bound to the authenticated identity, with CSRF before writes', async () => {
    const foreignKey = await call(`/api/v1/keys/${otherKeyId}`, { headers: { Cookie: ownerCookie } });
    expect(foreignKey.response.status).toBe(404);
    await testEnv.DB.prepare('UPDATE users SET balance_units=0 WHERE id=?').bind(other).run();
    const foreignBalance = await call(`/api/v1/account/balance?userId=${other}`, { headers: { Cookie: ownerCookie } });
    expect(foreignBalance.response.status).toBe(200);
    const ownBalance = await call('/api/v1/account/balance', { headers: { Cookie: ownerCookie } });
    expect(JSON.parse(foreignBalance.text).data).toEqual(JSON.parse(ownBalance.text).data);
    const forbiddenAdjustment = await call(`/api/v1/admin/users/${other}/balance-adjustments`, { method: 'POST', headers: writeHeaders(ownerCookie), body: JSON.stringify({ kind: 'grant', deltaUnits: '1', reason: 'must be denied' }) });
    expect(forbiddenAdjustment.response.status).toBe(403);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(0);

    const before = await testEnv.DB.prepare("SELECT status,version FROM users WHERE id='q10-owner'").first();
    const missingCsrf = await call(`/api/v1/admin/users/${owner}`, { method: 'PATCH', headers: writeHeaders(adminCookie, { csrf: false }), body: JSON.stringify({ version: 1, status: 'disabled' }) });
    expect(missingCsrf.response.status).toBe(403); expect(await testEnv.DB.prepare("SELECT status,version FROM users WHERE id='q10-owner'").first()).toEqual(before);
  });

  it('keeps Origin and credential boundaries while allowing administrator HTTP, private and query URLs', async () => {
    const evilPreflight = await call('/v1/chat/completions', { method: 'OPTIONS', headers: {
      Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Authorization',
    } });
    expect(evilPreflight.response.status).toBe(403); expect(evilPreflight.response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const allowedPreflight = await call('/v1/chat/completions', { method: 'OPTIONS', headers: {
      Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Authorization, Content-Type',
    } });
    expect(allowedPreflight.response.status).toBe(204); expect(allowedPreflight.response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    expect(allowedPreflight.response.headers.get('Access-Control-Allow-Credentials')).toBeNull();

    const upstream = vi.fn(async () => chatReply()); vi.stubGlobal('fetch', upstream);
    const conflicting = await call('/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${ownerKey}`, 'x-api-key': generateToken('apiKey'), 'Content-Type': 'application/json' }, body: JSON.stringify(chatBody()) });
    expect(conflicting.response.status).toBe(400); expect(upstream).not.toHaveBeenCalled();

    const validChannel = { name: 'Q10 injected channel', baseUrl: 'https://provider-q10-new.example.invalid', upstreamKey: 'q10-new-secret', concurrencyLimit: 1, rpmLimit: 60, priority: 1, status: 'active' };
    const badValues = ['https://user:pass@provider.example.invalid'];
    for (const baseUrl of badValues) {
      const result = await call('/api/v1/admin/channels', { method: 'POST', headers: writeHeaders(adminCookie), body: JSON.stringify({ ...validChannel, baseUrl }) });
      expect(result.response.status, baseUrl).toBe(400);
    }
    for (const baseUrl of ['http://127.0.0.1:8080', 'https://provider.example.invalid/path?x=1']) {
      const result = await call('/api/v1/admin/channels', { method: 'POST', headers: writeHeaders(adminCookie), body: JSON.stringify({ ...validChannel, baseUrl }) });
      expect(result.response.status, baseUrl).toBe(201);
      expect(result.text).not.toContain(validChannel.upstreamKey);
    }
    const injectedSecret = await call('/api/v1/admin/channels', { method: 'POST', headers: writeHeaders(adminCookie), body: JSON.stringify({ ...validChannel, upstreamKey: 'q10-secret\r\nX-Injected: yes' }) });
    expect(injectedSecret.response.status).toBe(400);
    expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM channels WHERE name='Q10 injected channel'").first('n')).toBe(2);
  });
});
