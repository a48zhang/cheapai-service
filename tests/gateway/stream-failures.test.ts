import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { app } from '../../apps/worker/app';
import type { Env } from '../../apps/worker/env';
import { encryptChannelSecret } from '../../apps/worker/admin/channel-secrets';
import { generateToken, hashToken } from '../../apps/worker/auth/tokens';
import { LeaseStorage } from '../../apps/worker/limits/storage';
import { testEnv } from '../helpers/database';

const origin = 'https://q09.example';
const group = 'q09-group';
const user = 'q09-user';
const channel = 'q09-channel';
const model = 'q09-model';
let env: Env;
let token: string;

const chunk = (delta: Record<string, unknown> = {}, finish: string | null = null) => JSON.stringify({ id: 'q09-upstream', object: 'chat.completion.chunk', created: 1,
  model: 'q09-upstream', choices: [{ index: 0, delta, finish_reason: finish }] });
const usage = JSON.stringify({ id: 'q09-upstream', object: 'chat.completion.chunk', created: 1, model: 'q09-upstream', choices: [],
  usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });
const frame = (data: string) => new TextEncoder().encode(`data: ${data}\n\n`);
const streamResponse = (source: ReadableStream<Uint8Array>) => new Response(source, { headers: { 'Content-Type': 'text/event-stream' } });
const requestBody = () => JSON.stringify({ model, messages: [{ role: 'user', content: 'Q09 synthetic input' }], stream: true });
async function invoke(init: RequestInit = {}, database: D1Database = testEnv.DB) {
  const context = createExecutionContext();
  const response = await app.fetch(new Request(origin + '/v1/chat/completions', init), { ...env, DB: database }, context);
  return { context, response };
}
async function active(subject: string): Promise<number> {
  return runInDurableObject(testEnv.GATE.get(testEnv.GATE.idFromName(subject)), (_instance, context) => new LeaseStorage(context.storage).read(Date.now()).leases.length);
}
async function state() {
  return testEnv.DB.prepare('SELECT execution_status,billing_status,usage_quality,cost_units FROM requests').first();
}
function authorized(signal?: AbortSignal): RequestInit {
  return { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: requestBody(), signal };
}

beforeEach(async () => {
  const now = Date.now();
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('q09-group','Q09','active',1,?,?)").bind(now, now).run();
  await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES('q09-user','q09@example.invalid','test-only','user','active','q09-group',1000000,1,60,'bootstrap',?,?)`).bind(now, now).run();
  token = generateToken('apiKey');
  await testEnv.DB.prepare("INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at) VALUES('q09-key','q09-user',?,'s2a_key_ABCDEFGH','Q09','active',0,0)")
    .bind(await hashToken('apiKey', token)).run();
  const key = crypto.getRandomValues(new Uint8Array(32));
  const encrypted = await encryptChannelSecret('q09-upstream-secret', channel, 'v1', key);
  env = { ...testEnv, ENVIRONMENT: 'local', PUBLIC_BASE_URL: origin,
    CHANNEL_KEYRING_JSON: JSON.stringify({ v1: btoa(String.fromCharCode(...key)) }), CHANNEL_ACTIVE_KEY_VERSION: 'v1' } as Env;
  await testEnv.DB.prepare(`INSERT INTO channels(id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES('q09-channel','Q09','https://provider-q09.example.invalid',?,'v1','active',1,1,60,1,0,0)`).bind(encrypted).run();
  await testEnv.DB.prepare("INSERT INTO channel_groups(channel_id,group_id) VALUES('q09-channel','q09-group')").run();
  await testEnv.DB.prepare(`INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES ('q09-model','active','{"input":"1","output":"2"}',1,0,64,0,0)`).run();
  await testEnv.DB.prepare(`INSERT INTO channel_models(channel_id,public_model_id,upstream_model,protocol,capabilities_json,config_version)
    VALUES('q09-channel','q09-model','q09-upstream','chat','{"protocol":"chat","features":["streaming","stream_usage"],"maxOutputTokens":64}',1)`).run();
});

describe('Q09 stream failure lifecycles through the real Worker HTTP entry', () => {
  it('does not prefetch while the client is slow, then completes and releases both leases', async () => {
    const parts = [frame(chunk({ role: 'assistant', content: 'slow' })), frame(chunk({}, 'stop')), frame(usage), frame('[DONE]')];
    let pulls = 0;
    const upstream = vi.fn(async () => streamResponse(new ReadableStream<Uint8Array>({ pull(controller) {
      pulls++;
      const part = parts.shift(); if (part) controller.enqueue(part); else controller.close();
    } }, { highWaterMark: 0 })));
    vi.stubGlobal('fetch', upstream);
    const { context, response } = await invoke(authorized());
    expect(response.status).toBe(200); expect(pulls).toBe(0);
    const reader = response.body!.getReader();
    const first = await reader.read(); expect(new TextDecoder().decode(first.value)).toContain('slow'); expect(pulls).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 5)); expect(pulls).toBe(1);
    while (!(await reader.read()).done) { /* Drive one downstream pull at a time. */ }
    await waitOnExecutionContext(context);
    expect(await state()).toMatchObject({ execution_status: 'succeeded', billing_status: 'settled', usage_quality: 'complete', cost_units: 800 });
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(1);
    expect(await active(`user:${user}`)).toBe(0); expect(await active(`channel:${channel}`)).toBe(0);
  });

  it('propagates client cancellation/termination to the upstream and settles the bounded lifecycle', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    let upstreamSignal: AbortSignal | undefined;
    const cancelled = vi.fn();
    const upstream = vi.fn(async (_url: string, init: RequestInit) => {
      upstreamSignal = init.signal as AbortSignal;
      return streamResponse(new ReadableStream<Uint8Array>({ start(controller) { source = controller; }, cancel: cancelled }, { highWaterMark: 0 }));
    });
    vi.stubGlobal('fetch', upstream);
    const abort = new AbortController();
    const { context, response } = await invoke(authorized(abort.signal));
    expect(response.status).toBe(200); expect(await active(`user:${user}`)).toBe(1);
    abort.abort();
    await waitOnExecutionContext(context);
    expect(upstreamSignal?.aborted).toBe(true); expect(cancelled).toHaveBeenCalled();
    expect((await state()).execution_status).toBe('cancelled');
    expect(await active(`user:${user}`)).toBe(0); expect(await active(`channel:${channel}`)).toBe(0);
    // A termination before usage evidence is available cannot create a charge.
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(0);
    void source;
  });

  it('marks abrupt upstream EOF incomplete and keeps usage unknown instead of billing a partial stream', async () => {
    const upstream = vi.fn(async () => streamResponse(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(frame(chunk({ content: 'partial' }))); controller.close();
    } }, { highWaterMark: 0 })));
    vi.stubGlobal('fetch', upstream);
    const { context, response } = await invoke(authorized());
    const text = await response.text(); await waitOnExecutionContext(context);
    expect(response.status).toBe(200); expect(text).toContain('partial'); expect(text).not.toContain('[DONE]');
    expect(await state()).toMatchObject({ execution_status: 'succeeded', billing_status: 'usage_unknown', usage_quality: 'missing', cost_units: null });
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(0);
    expect(await active(`user:${user}`)).toBe(0); expect(await active(`channel:${channel}`)).toBe(0);
  });

  it('keeps the request visible as settlement_pending when D1 batch fails after upstream output', async () => {
    let failWrites = false;
    const unavailable = new Proxy(testEnv.DB, { get(target, property, receiver) {
      if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (failWrites) throw new Error('synthetic D1 settlement failure');
        return target.batch(statements);
      };
      return Reflect.get(target, property, receiver);
    } }) as unknown as D1Database;
    const upstream = vi.fn(async () => {
      failWrites = true;
      return streamResponse(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(frame(chunk({}, 'stop'))); controller.enqueue(frame(usage)); controller.enqueue(frame('[DONE]')); controller.close();
      } }, { highWaterMark: 0 }));
    });
    vi.stubGlobal('fetch', upstream);
    const { context, response } = await invoke(authorized(), unavailable);
    await response.text(); await waitOnExecutionContext(context);
    expect(upstream).toHaveBeenCalledOnce();
    expect(await state()).toMatchObject({ execution_status: 'succeeded', billing_status: 'settlement_pending', usage_quality: 'complete', cost_units: 800 });
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(0);
    expect(await active(`user:${user}`)).toBe(0); expect(await active(`channel:${channel}`)).toBe(0);
  });
});
