import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { app } from '../../apps/worker/app';
import type { Env } from '../../apps/worker/env';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { issueCsrfToken } from '../../apps/worker/auth/csrf';
import { generateToken, hashToken } from '../../apps/worker/auth/tokens';
import { testEnv } from '../helpers/database';

const origin = 'https://console.example';
const admin = 'g22-admin';
const user = 'g22-user';
const model = 'g22-model';
const channel = 'g22-channel';
let env: Env;
let adminCookie: string;
let userCookie: string;
let token: string;

function jsonResponse(value: unknown): Response { return Response.json(value); }
const chatResponse = () => jsonResponse({ id: 'g22-upstream', object: 'chat.completion', created: 1, model: 'g22-upstream',
  choices: [{ index: 0, message: { role: 'assistant', content: 'observed' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });
async function invoke(path: string, init: RequestInit = {}, execution = false) {
  const context = execution ? createExecutionContext() : undefined;
  const response = await app.fetch(new Request(origin + path, init), env, context);
  const text = await response.text();
  if (context) await waitOnExecutionContext(context);
  return { response, text };
}
function csrfHeaders(cookie: string): Record<string, string> {
  const csrf = issueCsrfToken();
  return { Cookie: `${cookie}; ${csrf.setCookie.split(';')[0]}`, Origin: origin, 'X-CSRF-Token': csrf.token, 'Content-Type': 'application/json' };
}

beforeEach(async () => {
  const now = Date.now();
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('g22-group','G22','active',1,?,?)").bind(now, now).run();
  for (const [id, role] of [[admin, 'admin'], [user, 'user']] as const) {
    await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES(?,?, 'test-only',?,'active','g22-group',1000000,2,60,'bootstrap',?,?)`).bind(id, `${id}@example.invalid`, role, now, now).run();
  }
  adminCookie = (await createCookieSession(testEnv.DB, admin, now)).setCookie.split(';')[0]!;
  userCookie = (await createCookieSession(testEnv.DB, user, now)).setCookie.split(';')[0]!;
  token = generateToken('apiKey');
  await testEnv.DB.prepare("INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at) VALUES('g22-key',?,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','s2a_key_ABCDEFGH','G22','active',0,0)")
    .bind(user).run();
  await testEnv.DB.prepare("UPDATE api_keys SET key_hash=? WHERE id='g22-key'").bind(await hashToken('apiKey', token)).run();

  env = { ...testEnv, ENVIRONMENT: 'local', PUBLIC_BASE_URL: origin,
     } as Env;
  const credential = 'G22-PRIVATE-UPSTREAM-KEY';
  await testEnv.DB.prepare(`INSERT INTO channels(id,name,base_url,upstream_key,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES(?,?,?,?,'active',1,2,60,1,0,0)`).bind(channel, 'G22', 'https://provider.example.invalid/g22', credential).run();
  await testEnv.DB.prepare("INSERT INTO channel_groups(channel_id,group_id) VALUES('g22-channel','g22-group')").run();
  await testEnv.DB.prepare(`INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES (?,'active','{"input":"1","output":"2"}', 1, 0, 64, 0, 0)`).bind(model).run();
  await testEnv.DB.prepare(`INSERT INTO channel_models(channel_id,public_model_id,upstream_model,protocol,capabilities_json,config_version)
    VALUES(?,?,?,?,?,1)`).bind(channel, model, 'g22-upstream', 'chat', JSON.stringify({ protocol: 'chat', features: ['streaming', 'stream_usage'], maxOutputTokens: 64 })).run();
});

describe('G22 diagnostics and request observability through the Worker', () => {
  it('protects channel diagnostics and audits the explicit probe without billing a request', async () => {
    const fetcher = vi.fn(async () => chatResponse()); vi.stubGlobal('fetch', fetcher);
    const body = JSON.stringify({ publicModelId: model, protocol: 'chat', channelVersion: 1, mappingVersion: 1, priceVersion: 1 });
    const denied = await invoke(`/api/v1/admin/channels/${channel}/test`, { method: 'POST', headers: csrfHeaders(userCookie), body });
    expect(denied.response.status).toBe(403); expect(fetcher).not.toHaveBeenCalled();
    const result = await invoke(`/api/v1/admin/channels/${channel}/test`, { method: 'POST', headers: csrfHeaders(adminCookie), body });
    expect(result.response.status).toBe(200); expect(result.response.headers.get('Cache-Control')).toBe('no-store');
    expect(result.text).toContain('responded'); expect(result.text).not.toContain('G22-PRIVATE-UPSTREAM-KEY');
    expect(fetcher).toHaveBeenCalledOnce();
    expect((await testEnv.DB.prepare("SELECT action FROM admin_audit WHERE action LIKE 'channel.test.%' ORDER BY action").all()).results)
      .toEqual([{ action: 'channel.test.intent' }, { action: 'channel.test.responded.200' }]);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM requests').first('n')).toBe(0);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(0);
  });

  it('emits bounded lifecycle observations without changing native response or billing', async () => {
    const fetcher = vi.fn(async () => chatResponse()); vi.stubGlobal('fetch', fetcher);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const result = await invoke('/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'private prompt' }] }) }, true);
    expect(result.response.status).toBe(200); expect(JSON.parse(result.text)).toMatchObject({ object: 'chat.completion', choices: [{ message: { content: 'observed' } }] });
    expect(fetcher).toHaveBeenCalledOnce(); expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(1);
    const records = info.mock.calls.map(call => call[0]).filter((value): value is string => typeof value === 'string' && value.startsWith('{"schema_version"'))
      .map(value => JSON.parse(value) as { request_id: string; stage: string; [key: string]: unknown });
    expect(records.map(record => record.stage)).toEqual(['received', 'admitted', 'upstream_started', 'first_byte', 'settlement', 'completed']);
    expect(new Set(records.map(record => record.request_id)).size).toBe(1);
    expect(JSON.stringify(records)).not.toMatch(/private prompt|G22-PRIVATE|authorization|password/i);
    expect(records.at(-1)).toMatchObject({ terminal_status: 'completed', usage_quality: 'complete', billing_status: 'settled' });
    info.mockRestore();
  });
});
