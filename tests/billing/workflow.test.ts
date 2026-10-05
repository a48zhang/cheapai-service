import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { app } from '../../apps/worker/app';
import type { Env } from '../../apps/worker/env';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { issueCsrfToken } from '../../apps/worker/auth/csrf';
import { generateToken, hashToken } from '../../apps/worker/auth/tokens';
import { LeaseStorage } from '../../apps/worker/limits/storage';
import { testEnv } from '../helpers/database';

const origin = 'https://q04.example';
const group = 'q04-group';
const owner = 'q04-owner';
const admin = 'q04-admin';
const channel = 'q04-channel';
const model = 'q04-model';
let env: Env;
let ownerCookie: string;
let adminCookie: string;
let apiKey: string;

function csrfHeaders(cookie: string, operation?: string): Record<string, string> {
  const csrf = issueCsrfToken();
  return { Cookie: `${cookie}; ${csrf.setCookie.split(';')[0]}`, Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.token,
    ...(operation === undefined ? {} : { 'Idempotency-Key': operation }) };
}
async function invoke(path: string, init: RequestInit = {}) {
  const context = createExecutionContext();
  const response = await app.fetch(new Request(origin + path, init), env, context);
  const text = await response.text();
  await waitOnExecutionContext(context);
  return { response, text };
}
async function balance(cookie: string): Promise<string> {
  const result = await invoke('/api/v1/account/balance', { headers: { Cookie: cookie } });
  expect(result.response.status).toBe(200);
  return (JSON.parse(result.text) as { data: { balance_units: string } }).data.balance_units;
}
async function grant(cookie: string, operation: string, deltaUnits: string) {
  return invoke(`/api/v1/admin/users/${owner}/balance-adjustments`, { method: 'POST', headers: csrfHeaders(cookie, operation),
    body: JSON.stringify({ kind: 'grant', deltaUnits, reason: `Q04 local workflow ${operation}` }) });
}
const chatRequest = () => ({ model, messages: [{ role: 'user', content: 'Synthetic workflow input' }], stream: false });
const chatReply = () => Response.json({ id: 'q04-upstream-response', object: 'chat.completion', created: 1, model: 'q04-upstream',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Synthetic workflow output' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } });

beforeEach(async () => {
  const now = Date.now();
  await testEnv.DB.prepare(`INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES(?,?, 'active',1,?,?)`).bind(group, 'Q04', now, now).run();
  for (const [id, role] of [[owner, 'user'], [admin, 'admin']] as const) {
    await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES(?,?, 'test-only',?,'active',?,0,2,60,'bootstrap',?,?)`).bind(id, `${id}@example.invalid`, role, group, now, now).run();
  }
  ownerCookie = (await createCookieSession(testEnv.DB, owner, now)).setCookie.split(';')[0]!;
  adminCookie = (await createCookieSession(testEnv.DB, admin, now)).setCookie.split(';')[0]!;
  apiKey = generateToken('apiKey');
  await testEnv.DB.prepare(`INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at)
    VALUES('q04-key',?,?, 's2a_key_ABCDEFGH','Q04','active',0,0)`).bind(owner, await hashToken('apiKey', apiKey)).run();

  const credential = 'q04-upstream-secret';
  env = { ...testEnv, ENVIRONMENT: 'local', PUBLIC_BASE_URL: origin,
     } as Env;
  await testEnv.DB.prepare(`INSERT INTO channels(id,name,base_url,upstream_key,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES(?,?,?,?,'active',1,1,60,1,0,0)`).bind(channel, 'Q04', 'https://provider-q04.example.invalid', credential).run();
  await testEnv.DB.prepare('INSERT INTO channel_groups(channel_id,group_id) VALUES(?,?)').bind(channel, group).run();
  await testEnv.DB.prepare(`INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES (?,'active','{"input":"1","output":"2"}', 1, 0, 4096, 0, 0)`).bind(model).run();
  await testEnv.DB.prepare(`INSERT INTO channel_models(channel_id,public_model_id,upstream_model,protocol,capabilities_json,config_version)
    VALUES(?,?,?,?,?,1)`).bind(channel, model, 'q04-upstream', 'chat', JSON.stringify({ protocol: 'chat', features: ['streaming', 'stream_usage'], maxOutputTokens: 4096 })).run();
});

describe('Q04 local billing workflow through native D1/DO and mock upstream', () => {
  it('grants, charges into a negative balance, rejects at admission, then recovers after recharge', async () => {
    const upstream = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://provider-q04.example.invalid/v1/chat/completions');
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer q04-upstream-secret');
      return chatReply();
    });
    vi.stubGlobal('fetch', upstream);

    const initial = await balance(ownerCookie); expect(initial).toBe('0');
    expect((await grant(adminCookie, 'q04-grant-1', '100000')).response.status).toBe(201);
    expect(await balance(ownerCookie)).toBe('100000');

    const first = await invoke('/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(chatRequest()) });
    expect(first.response.status).toBe(200); expect(JSON.parse(first.text)).toMatchObject({ object: 'chat.completion', choices: [{ message: { content: 'Synthetic workflow output' } }] });
    expect(await balance(ownerCookie)).toBe('-100000');
    expect(upstream).toHaveBeenCalledTimes(1);
    const firstRequest = await testEnv.DB.prepare('SELECT id,execution_status,billing_status,cost_units FROM requests').first();
    expect(firstRequest).toMatchObject({ execution_status: 'succeeded', billing_status: 'settled', cost_units: 200000 });

    const rejected = await invoke('/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(chatRequest()) });
    expect(rejected.response.status).toBe(402); expect(JSON.parse(rejected.text)).toHaveProperty('error');
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM requests').first('n')).toBe(1);

    expect((await grant(adminCookie, 'q04-grant-2', '300000')).response.status).toBe(201);
    expect(await balance(ownerCookie)).toBe('200000');
    const recovered = await invoke('/v1/chat/completions', { method: 'POST', headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(chatRequest()) });
    expect(recovered.response.status).toBe(200); expect(upstream).toHaveBeenCalledTimes(2);
    expect(await balance(ownerCookie)).toBe('0');
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM requests').first('n')).toBe(2);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(4);
    expect((await testEnv.DB.prepare("SELECT kind,delta_units FROM billing_entries ORDER BY created_at,id").all()).results)
      .toEqual(expect.arrayContaining([{ kind: 'grant', delta_units: 100000 }, { kind: 'consumption', delta_units: -200000 }, { kind: 'grant', delta_units: 300000 }, { kind: 'consumption', delta_units: -200000 }]));
    const userLeaseCount = await runInDurableObject(testEnv.GATE.get(testEnv.GATE.idFromName(`user:${owner}`)), (_instance, context) => new LeaseStorage(context.storage).read(Date.now()).leases.length);
    const channelLeaseCount = await runInDurableObject(testEnv.GATE.get(testEnv.GATE.idFromName(`channel:${channel}`)), (_instance, context) => new LeaseStorage(context.storage).read(Date.now()).leases.length);
    expect(userLeaseCount).toBe(0); expect(channelLeaseCount).toBe(0);
  });
});
