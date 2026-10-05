import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { createChatRoute, CHAT_COMPLETIONS_PATH } from '../../apps/worker/gateway/chat-route';
import { generateToken, hashToken } from '../../apps/worker/auth/tokens';
import type { Env } from '../../apps/worker/env';
import { testEnv } from '../helpers/database';

let token: string;
let env: Env;
const body = (stream = false) => ({ model: 'route-model', messages: [{ role: 'user', content: 'Synthetic' }], stream });
beforeEach(async () => {
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('route-group','Fixture','active',1,0,0)").run();
  await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES('route-user','route@example.invalid','synthetic','user','active','route-group',1000,1,60,'admin',0,0)`).run();
  token = generateToken('apiKey');
  await testEnv.DB.prepare("INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at) VALUES('route-key','route-user',?,'s2a_key_ABCDEFGH','Fixture','active',0,0)").bind(await hashToken('apiKey', token)).run();

  const credential = 'synthetic-upstream';
  env = { DB: testEnv.DB, CACHE: testEnv.CACHE, GATE: testEnv.GATE,  } as Env;
  await testEnv.DB.prepare(`INSERT INTO channels(id,name,base_url,upstream_key,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES('route-channel','Fixture','https://provider.example',?,'active',1,1,60,1,0,0)`).bind(credential).run();
  await testEnv.DB.prepare("INSERT INTO channel_groups(channel_id,group_id) VALUES('route-channel','route-group')").run();
  await testEnv.DB.prepare(`INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES ('route-model','active','{"input":"1","output":"2"}',1,0,64,0,0)`).run();
  await testEnv.DB.prepare(`INSERT INTO channel_models(channel_id,public_model_id,upstream_model,protocol,capabilities_json,config_version)
    VALUES('route-channel','route-model','provider','chat','{"protocol":"chat","features":["streaming","stream_usage"],"maxOutputTokens":64}',1)`).run();
});
const post = (value: unknown, auth = true) => new Request(`https://local.test${CHAT_COMPLETIONS_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(value) });

describe('G16 native Chat route', () => {
  it.each([false, true])('POST stream=%s delegates once and preserves accounting completion', async stream => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const wire = JSON.parse(init.body as string); expect(wire.model).toBe('provider');
      if (!stream) return Response.json({ id: 'native', object: 'chat.completion', created: 1, model: 'provider', choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } });
      expect(wire.stream_options.include_usage).toBe(true);
      const base = { id: 'native', object: 'chat.completion.chunk', created: 1, model: 'provider' };
      return new Response([{ ...base, choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: 'stop' }] }, { ...base, choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } }]
        .map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const context = createExecutionContext();
    const result = await createChatRoute({ fetch: fetcher }).fetch(post(body(stream)), env, context);
    const text = await result.text(); await waitOnExecutionContext(context);
    expect(result.status).toBe(200); expect(result.headers.get('Cache-Control')).toBe('no-store'); expect(text).toContain('Hi');
    expect(fetcher).toHaveBeenCalledTimes(1); expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(1);
    expect(await testEnv.DB.prepare('SELECT cost_units FROM requests').first('cost_units')).toBe(800);
  });

  it('returns native auth/input errors before dispatch', async () => {
    for (const [value, auth, status] of [[{}, false, 401], [{}, true, 400]] as const) {
      const context = createExecutionContext(); const result = await createChatRoute().fetch(post(value, auth), env, context);
      expect(result.status).toBe(status); expect(await result.json()).toHaveProperty('error'); await waitOnExecutionContext(context);
    }
  });

  it('has only the fixed POST path', async () => {
    const context = createExecutionContext(); const result = await createChatRoute().fetch(new Request(`https://local.test${CHAT_COMPLETIONS_PATH}`), env, context);
    expect(result.status).toBe(404); expect(result.headers.get('Cache-Control')).toBe('no-store'); expect(await result.json()).toHaveProperty('error');
  });
});
