import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { createMessagesRoute, MESSAGES_PATH } from '../../apps/worker/gateway/messages-route';
import { generateToken, hashToken } from '../../apps/worker/auth/tokens';
import { encryptChannelSecret } from '../../apps/worker/admin/channel-secrets';
import type { Env } from '../../apps/worker/env';
import { testEnv } from '../helpers/database';

let token: string;
let env: Env;
const body = (stream = false) => ({ model: 'route-model', max_tokens: 16, messages: [{ role: 'user', content: 'Synthetic' }], stream });
beforeEach(async () => {
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('route-group','Fixture','active',1,0,0)").run();
  await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES('route-user','route@example.invalid','synthetic','user','active','route-group',1000,1,60,'admin',0,0)`).run();
  token = generateToken('apiKey');
  await testEnv.DB.prepare("INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at) VALUES('route-key','route-user',?,'s2a_key_ABCDEFGH','Fixture','active',0,0)").bind(await hashToken('apiKey', token)).run();
  const key = crypto.getRandomValues(new Uint8Array(32));
  const encrypted = await encryptChannelSecret('synthetic-upstream', 'route-channel', 'v1', key);
  env = { DB: testEnv.DB, CACHE: testEnv.CACHE, GATE: testEnv.GATE, CHANNEL_KEYRING_JSON: JSON.stringify({ v1: btoa(String.fromCharCode(...key)) }), CHANNEL_ACTIVE_KEY_VERSION: 'v1' } as Env;
  await testEnv.DB.prepare(`INSERT INTO channels(id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES('route-channel','Fixture','https://provider.example',?,'v1','active',1,1,60,1,0,0)`).bind(encrypted).run();
  await testEnv.DB.prepare("INSERT INTO channel_groups(channel_id,group_id) VALUES('route-channel','route-group')").run();
  await testEnv.DB.prepare(`INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES ('route-model','active','{"input":"1","output":"2"}',1,0,64,0,0)`).run();
  await testEnv.DB.prepare(`INSERT INTO channel_models(channel_id,public_model_id,upstream_model,protocol,capabilities_json,config_version)
    VALUES('route-channel','route-model','provider','messages','{"protocol":"messages","features":["streaming"],"maxOutputTokens":64}',1)`).run();
});
const post = (value: unknown, auth = true) => new Request(`https://local.test${MESSAGES_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { 'x-api-key': token } : {}) }, body: JSON.stringify(value) });

describe('G18 native Messages route', () => {
  it.each([false, true])('POST stream=%s delegates once and preserves accounting completion', async stream => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const wire = JSON.parse(init.body as string); expect(wire.model).toBe('provider');
      expect(new Headers(init.headers).get('anthropic-version')).toBe('2023-06-01');
      expect(new Headers(init.headers).get('x-api-key')).toBe('synthetic-upstream');
      const completed = { id: 'native', type: 'message', role: 'assistant', model: 'provider', content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
      if (!stream) return Response.json(completed);
      return new Response([
        { type: 'message_start', message: { ...completed, content: [], stop_reason: null, usage: { ...completed.usage, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }, { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }, { type: 'message_stop' },
      ].map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const context = createExecutionContext();
    const result = await createMessagesRoute({ fetch: fetcher }).fetch(post(body(stream)), env, context);
    const text = await result.text(); await waitOnExecutionContext(context);
    expect(result.status).toBe(200); expect(result.headers.get('Cache-Control')).toBe('no-store'); expect(text).toContain('Hi');
    expect(fetcher).toHaveBeenCalledTimes(1); expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(1);
    expect(await testEnv.DB.prepare('SELECT cost_units FROM requests').first('cost_units')).toBe(800);
  });

  it('returns native auth/input errors without evaluating broken Secret getters', async () => {
    const getter = vi.fn(() => { throw new Error('PRIVATE SECRET'); });
    const broken = Object.defineProperty({ DB: testEnv.DB, CACHE: testEnv.CACHE, GATE: testEnv.GATE }, 'CHANNEL_KEYRING_JSON', { get: getter }) as Env;
    for (const [value, auth, status] of [[{}, false, 401], [{}, true, 400]] as const) {
      const context = createExecutionContext(); const result = await createMessagesRoute().fetch(post(value, auth), broken, context);
      expect(result.status).toBe(status); expect(await result.json()).toHaveProperty('error'); await waitOnExecutionContext(context);
    }
    expect(getter).not.toHaveBeenCalled();
    const versionContext = createExecutionContext(); const versionRequest = post(body()); versionRequest.headers.set('anthropic-version', '1999-01-01');
    const invalidVersion = await createMessagesRoute().fetch(versionRequest, broken, versionContext);
    expect(invalidVersion.status).toBe(400); expect(await invalidVersion.json()).toMatchObject({ type: 'error' });
    expect(getter).not.toHaveBeenCalled(); await waitOnExecutionContext(versionContext);
    const context = createExecutionContext(); const configured = await createMessagesRoute().fetch(post(body()), broken, context);
    expect(configured.status).toBe(503); expect(await configured.text()).not.toContain('PRIVATE'); await waitOnExecutionContext(context);
  });

  it('has only the fixed POST path', async () => {
    const context = createExecutionContext(); const result = await createMessagesRoute().fetch(new Request(`https://local.test${MESSAGES_PATH}`), env, context);
    expect(result.status).toBe(404); expect(result.headers.get('Cache-Control')).toBe('no-store'); expect(await result.json()).toHaveProperty('error');
  });
});

