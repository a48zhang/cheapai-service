import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { app } from '../../apps/worker/app';
import type { Env } from '../../apps/worker/env';
import * as passwords from '../../apps/worker/auth/password';
import { encryptChannelSecret } from '../../apps/worker/admin/channel-secrets';
import { DESKTOP_ACCOUNT_PATH, DESKTOP_KEY_PATH, DESKTOP_LOGIN_PATH, DESKTOP_LOGOUT_PATH } from '../../apps/worker/auth/desktop/routes';
import { testEnv } from '../helpers/database';

const origin = 'https://console.example';
const email = 'a43-desktop@example.invalid';
const password = 'fixture-only-password';
const model = 'a43-chat-model';
let env: Env;
let channelKey: Uint8Array;

interface Envelope<T> { data: T; request_id: string }
interface DesktopCredential { token: string; expiresAt: number; user: { id: string } }
interface DesktopKey { key: string; keyId: string; expiresAt: number }

async function call(path: string, init: RequestInit = {}) {
  const executionContext = createExecutionContext();
  const response = await app.fetch(new Request(origin + path, init), env, executionContext);
  const text = await response.text();
  await waitOnExecutionContext(executionContext);
  return { response, text };
}

async function login(): Promise<DesktopCredential> {
  const result = await call(DESKTOP_LOGIN_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  expect(result.response.status).toBe(200);
  return (JSON.parse(result.text) as Envelope<DesktopCredential>).data;
}

async function currentKey(token: string): Promise<DesktopKey> {
  const result = await call(DESKTOP_KEY_PATH, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  expect(result.response.status).toBe(200);
  return (JSON.parse(result.text) as Envelope<DesktopKey>).data;
}

async function modelRequest(key: string) {
  return call('/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'fixture' }] }),
  });
}

beforeEach(async () => {
  const now = Date.now();
  await testEnv.DB.prepare(`INSERT INTO groups(id,name,status,version,created_at,updated_at)
    VALUES('a43-group','A43','active',1,?,?)`).bind(now, now).run();
  await testEnv.DB.prepare(`INSERT INTO users
    (id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES('a43-user',?,'fixture-hash','user','active','a43-group',1000000,2,60,'admin',?,?)`)
    .bind(email, now, now).run();
  await testEnv.DB.prepare(`INSERT INTO models
    (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at)
    VALUES (?,'active','{"input":"1","output":"2"}',1,0,64,0,0)`).bind(model).run();
  channelKey = crypto.getRandomValues(new Uint8Array(32));
  const encrypted = await encryptChannelSecret('A43-UPSTREAM', 'a43-channel', 'v1', channelKey);
  await testEnv.DB.prepare(`INSERT INTO channels
    (id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES ('a43-channel','A43','https://provider-a43.example',?,'v1','active',1,2,60,1,0,0)`)
    .bind(encrypted).run();
  await testEnv.DB.prepare("INSERT INTO channel_groups(channel_id,group_id) VALUES('a43-channel','a43-group')").run();
  await testEnv.DB.prepare(`INSERT INTO channel_models
    (channel_id,public_model_id,upstream_model,protocol,capabilities_json,config_version)
    VALUES ('a43-channel',?,'provider-a43','chat','{"protocol":"chat","features":["streaming","stream_usage"],"maxOutputTokens":64}',1)`)
    .bind(model).run();
  env = {
    ...testEnv,
    ENVIRONMENT: 'local',
    PUBLIC_BASE_URL: origin,
    CHANNEL_KEYRING_JSON: JSON.stringify({ v1: btoa(String.fromCharCode(...channelKey)) }),
    CHANNEL_ACTIVE_KEY_VERSION: 'v1',
  } as Env;
  vi.spyOn(passwords, 'verifyPassword').mockResolvedValue(true);
});

afterEach(() => vi.restoreAllMocks());

describe('desktop route to gateway accounting integration', () => {
  it('bills a real desktop Key, logout blocks only its parent session, and another Token remains usable', async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://provider-a43.example/v1/chat/completions');
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer A43-UPSTREAM');
      return Response.json({ id: 'a43-upstream', object: 'chat.completion', created: 1, model: 'provider-a43',
        choices: [{ index: 0, message: { role: 'assistant', content: 'fixture' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });
    });
    vi.stubGlobal('fetch', fetcher);

    const firstSession = await login();
    const secondSession = await login();
    expect(firstSession.token).not.toBe(secondSession.token);
    const firstKey = await currentKey(firstSession.token);
    const secondKey = await currentKey(secondSession.token);
    expect(firstKey.key).not.toBe(secondKey.key);
    expect(firstKey.keyId).not.toBe(secondKey.keyId);

    const bindings = await testEnv.DB.prepare(`SELECT id,desktop_session_id,status FROM api_keys WHERE id IN (?,?) ORDER BY id`)
      .bind(firstKey.keyId, secondKey.keyId).all<{ id: string; desktop_session_id: string; status: string }>();
    expect(bindings.results).toHaveLength(2);
    expect(bindings.results[0]!.desktop_session_id).not.toBe(bindings.results[1]!.desktop_session_id);
    expect(bindings.results.every(row => row.status === 'active')).toBe(true);

    const firstRequest = await modelRequest(firstKey.key);
    expect(firstRequest.response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const account = await call(DESKTOP_ACCOUNT_PATH, { headers: { Authorization: `Bearer ${firstSession.token}` } });
    expect(account.response.status).toBe(200);
    expect((JSON.parse(account.text) as Envelope<{ user: { id: string }; balance: { balance_units: string } }>).data)
      .toMatchObject({ user: { id: 'a43-user' }, balance: { balance_units: '999200' } });

    const firstState = await testEnv.DB.prepare(`SELECT id,user_id,api_key_id,billing_status,cost_units FROM requests`)
      .first<{ id: string; user_id: string; api_key_id: string; billing_status: string; cost_units: number }>();
    expect(firstState).toMatchObject({ user_id: 'a43-user', api_key_id: firstKey.keyId, billing_status: 'settled', cost_units: 800 });
    const firstLedger = await testEnv.DB.prepare(`SELECT kind,user_id,request_id,currency,delta_units FROM billing_entries`)
      .first<{ kind: string; user_id: string; request_id: string; currency: string; delta_units: number }>();
    expect(firstLedger).toMatchObject({ kind: 'consumption', user_id: 'a43-user', request_id: firstState!.id, currency: 'USD', delta_units: -800 });

    const logout = await call(DESKTOP_LOGOUT_PATH, {
      method: 'POST', headers: { Authorization: `Bearer ${firstSession.token}` },
    });
    expect(logout.response.status).toBe(200);
    expect(JSON.parse(logout.text)).toMatchObject({ data: { loggedOut: true } });
    expect(await testEnv.DB.prepare('SELECT status FROM api_keys WHERE id=?').bind(firstKey.keyId).first('status')).toBe('revoked');
    expect(await testEnv.DB.prepare('SELECT revoked_at,current_key_ciphertext FROM desktop_sessions WHERE id=?')
      .bind(bindings.results.find(row => row.id === firstKey.keyId)!.desktop_session_id).first())
      .toMatchObject({ revoked_at: expect.any(Number), current_key_ciphertext: null });

    const revokedRequest = await modelRequest(firstKey.key);
    expect(revokedRequest.response.status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM requests').first('n')).toBe(1);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(1);

    const survivingRequest = await modelRequest(secondKey.key);
    expect(survivingRequest.response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const settled = await testEnv.DB.prepare(`SELECT user_id,api_key_id,billing_status,cost_units FROM requests ORDER BY created_at,id`)
      .all<{ user_id: string; api_key_id: string; billing_status: string; cost_units: number }>();
    expect(settled.results).toHaveLength(2);
    expect(settled.results.map(row => row.api_key_id)).toEqual(expect.arrayContaining([firstKey.keyId, secondKey.keyId]));
    expect(settled.results.every(row => row.user_id === 'a43-user' && row.billing_status === 'settled' && row.cost_units === 800)).toBe(true);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries WHERE kind=? AND user_id=?')
      .bind('consumption', 'a43-user').first('n')).toBe(2);
    expect(await testEnv.DB.prepare('SELECT balance_units FROM users WHERE id=?').bind('a43-user').first('balance_units')).toBe(998400);
  }, 30_000);

  it('rejects the gateway Key when its parent desktop session expires', async () => {
    const fetcher = vi.fn(async () => Response.json({ id: 'unused', object: 'chat.completion', created: 1, model: 'provider-a43',
      choices: [{ index: 0, message: { role: 'assistant', content: 'unused' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }));
    vi.stubGlobal('fetch', fetcher);
    const session = await login();
    const key = await currentKey(session.token);
    const parent = await testEnv.DB.prepare('SELECT desktop_session_id FROM api_keys WHERE id=?')
      .bind(key.keyId).first<{ desktop_session_id: string }>();
    expect(parent?.desktop_session_id).toBeTruthy();

    await testEnv.DB.prepare('UPDATE desktop_sessions SET expires_at=created_at+1 WHERE id=?')
      .bind(parent!.desktop_session_id).run();

    const account = await call(DESKTOP_ACCOUNT_PATH, { headers: { Authorization: `Bearer ${session.token}` } });
    expect(account.response.status).toBe(401);
    expect(JSON.parse(account.text)).toMatchObject({ error: { code: 'unauthorized', reason: 'session_expired' } });

    const denied = await modelRequest(key.key);
    expect(denied.response.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await testEnv.DB.prepare('SELECT status FROM api_keys WHERE id=?').bind(key.keyId).first('status')).toBe('active');
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM requests').first('n')).toBe(0);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(0);
  }, 30_000);
});
