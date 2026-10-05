import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { app } from '../../apps/worker/app';
import type { Env } from '../../apps/worker/env';
import { generateToken, hashToken } from '../../apps/worker/auth/tokens';
import { testEnv } from '../helpers/database';

const origin = 'https://console.example';
const protocols = ['chat', 'responses', 'messages'] as const;
let env: Env;
let token: string;
const modelFor = (protocol: typeof protocols[number]) => `g19-${protocol}-model`;

function request(path: string, init: RequestInit = {}): Request {
  return new Request(origin + path, init);
}
async function call(path: string, init: RequestInit = {}) {
  const context = createExecutionContext();
  const response = await app.fetch(request(path, init), env, context);
  const text = await response.text();
  await waitOnExecutionContext(context);
  return { response, text };
}
function payload(protocol: typeof protocols[number], stream = false): Record<string, unknown> {
  if (protocol === 'responses') return { model: modelFor(protocol), input: 'Synthetic', stream };
  if (protocol === 'messages') return { model: modelFor(protocol), max_tokens: 16, messages: [{ role: 'user', content: 'Synthetic' }], stream };
  return { model: modelFor(protocol), messages: [{ role: 'user', content: 'Synthetic' }], stream };
}
function output(protocol: typeof protocols[number]) {
  if (protocol === 'chat') return { id: 'upstream-chat', object: 'chat.completion', created: 1, model: 'provider-chat',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } };
  if (protocol === 'responses') return { id: 'upstream-responses', object: 'response', created_at: 1, model: 'provider-responses',
    status: 'completed', output: [], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } };
  return { id: 'upstream-messages', type: 'message', role: 'assistant', model: 'provider-messages', content: [{ type: 'text', text: 'hello' }],
    stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
}
function chatStream(): Response {
  const base = { id: 'upstream-chat-stream', object: 'chat.completion.chunk', created: 1, model: 'provider-chat' };
  const body = [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { ...base, choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }, '[DONE]']
    .map(value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`).join('');
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

beforeEach(async () => {
  const now = Date.now();
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('g19-group','G19','active',1,?,?)").bind(now, now).run();
  await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES('g19-user','g19@example.invalid','synthetic','user','active','g19-group',1000000,2,60,'admin',?,?)`).bind(now, now).run();
  token = generateToken('apiKey');
  await testEnv.DB.prepare("INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at) VALUES('g19-key','g19-user',?,'s2a_key_ABCDEFGH','G19','active',0,0)")
    .bind(await hashToken('apiKey', token)).run();

  env = { ...testEnv, ENVIRONMENT: 'local', PUBLIC_BASE_URL: origin,
     } as Env;
  for (const protocol of protocols) {
    await testEnv.DB.prepare(`INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES (?,'active','{"input":"1","output":"2"}', 1, 0, 64, 0, 0)`).bind(modelFor(protocol)).run();
    const channelId = `g19-${protocol}-channel`;
    const credential = `G19-${protocol}-UPSTREAM`;
    await testEnv.DB.prepare(`INSERT INTO channels(id,name,base_url,upstream_key,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
      VALUES(?,?,?,?,'active',1,2,60,1,0,0)`).bind(channelId, channelId, `https://provider-${protocol}.example`, credential).run();
    await testEnv.DB.prepare("INSERT INTO channel_groups(channel_id,group_id) VALUES(?, 'g19-group')").bind(channelId).run();
    const features = ['streaming', ...(protocol === 'chat' ? ['stream_usage'] : [])];
    await testEnv.DB.prepare('INSERT INTO channel_models(channel_id,public_model_id,upstream_model,protocol,capabilities_json,config_version) VALUES(?,?,?,?,?,1)')
      .bind(channelId, modelFor(protocol), `provider-${protocol}`, protocol, JSON.stringify({ protocol, features, maxOutputTokens: 64 })).run();
  }
});

describe('G19 four native /v1 entries through the Worker', () => {
  it('authenticates each entry, returns native JSON, and lists only the current model', async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      const protocol = protocols.find(item => url.endsWith(`/v1/${item === 'chat' ? 'chat/completions' : item}`))!;
      expect(new Headers(init.headers).get(protocol === 'messages' ? 'x-api-key' : 'Authorization')).toContain(`G19-${protocol}-UPSTREAM`);
      expect(JSON.stringify(init.headers)).not.toContain(token);
      return Response.json(output(protocol));
    });
    vi.stubGlobal('fetch', fetcher);
    for (const protocol of protocols) {
      const path = protocol === 'chat' ? '/v1/chat/completions' : `/v1/${protocol}`;
      const headers = { 'Content-Type': 'application/json', ...(protocol === 'messages' ? { 'x-api-key': token } : { Authorization: `Bearer ${token}` }) };
      const result = await call(path, { method: 'POST', headers, body: JSON.stringify(payload(protocol)) });
      expect(result.response.status, protocol).toBe(200);
      expect(result.response.headers.get('Cache-Control')).toBe('no-store');
      expect(result.response.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.text).toContain(protocol === 'responses' ? 'response' : 'hello'); expect(result.text).not.toContain('G19-');
    }
    const models = await call('/v1/models', { headers: { Authorization: `Bearer ${token}` } });
    expect(models.response.status).toBe(200);
    expect(JSON.parse(models.text)).toEqual({ object: 'list', data: ['chat', 'messages', 'responses'].map(protocol => ({ id: modelFor(protocol as typeof protocols[number]), object: 'model', created: 0, owned_by: 'sub2api' })) });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(3);
  });

  it('keeps authentication native and does not turn unsupported/missing routes into SPA HTML', async () => {
    for (const [path, method] of [['/v1/chat/completions', 'POST'], ['/v1/responses', 'POST'], ['/v1/messages', 'POST']] as const) {
      const result = await call(path, { method, headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(result.response.status).toBe(401); expect(result.response.headers.get('Content-Type')).toMatch(/application\/json/);
      expect(JSON.parse(result.text)).toHaveProperty('error'); expect(result.text).not.toContain('<!doctype');
    }
    const models = await call('/v1/models');
    expect(models.response.status).toBe(401); expect(JSON.parse(models.text)).toHaveProperty('error');
    const methodMismatch = await call('/v1/chat/completions', { method: 'GET' });
    expect(methodMismatch.response.status).toBe(404); expect(JSON.parse(methodMismatch.text)).toHaveProperty('error');
    const unknown = await call('/v1/unknown');
    expect(unknown.response.status).toBe(404); expect(unknown.response.headers.get('Content-Type')).toMatch(/application\/json/);
    expect(unknown.text).not.toContain('<!doctype');
  });

  it('keeps streaming on the native chat entry and attaches completion to the Worker context', async () => {
    const fetcher = vi.fn(async () => chatStream());
    vi.stubGlobal('fetch', fetcher);
    const result = await call('/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload('chat', true)) });
    expect(result.response.status).toBe(200); expect(result.response.headers.get('Content-Type')).toMatch(/text\/event-stream/);
    expect(result.text).toContain('hello'); expect(result.text).toContain('[DONE]'); expect(result.text).not.toContain('"usage"');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await testEnv.DB.prepare('SELECT billing_status,cost_units FROM requests').first()).toEqual({ billing_status: 'settled', cost_units: 800 });
  });
});
