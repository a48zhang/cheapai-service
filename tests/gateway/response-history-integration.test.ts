import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { app } from '../../apps/worker/app';
import type { Env } from '../../apps/worker/env';
import { encryptChannelSecret } from '../../apps/worker/admin/channel-secrets';
import { generateToken, hashToken } from '../../apps/worker/auth/tokens';
import { routesCacheKey } from '../../apps/worker/cache/routes';
import { testEnv } from '../helpers/database';

const origin = 'https://q08.example';
const group = 'q08-group';
const owner = 'q08-owner';
const other = 'q08-other';
const model = 'q08-model';
const channelA = 'q08-channel-a';
const channelB = 'q08-channel-b';
let env: Env;
let ownerKey: string;
let ownerSecondKey: string;
let otherKey: string;
let keyBytes: Uint8Array;

const response = (id: string, modelName: string) => ({ id, object: 'response', created_at: 1, model: modelName, status: 'completed', output: [],
  usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } });
const body = (previous?: string) => ({ model, input: 'Synthetic next input', max_output_tokens: 16, ...(previous === undefined ? {} : { previous_response_id: previous }) });
async function call(token: string, value: Record<string, unknown>) {
  const context = createExecutionContext();
  const result = await app.fetch(new Request(origin + '/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value) }), env, context);
  const text = await result.text(); await waitOnExecutionContext(context);
  return { result, text };
}
async function chatWithHistory(token: string, previous: string) {
  const context = createExecutionContext();
  const result = await app.fetch(new Request(origin + '/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'cross protocol' }], previous_response_id: previous }) }), env, context);
  const text = await result.text(); await waitOnExecutionContext(context);
  return { result, text };
}
async function addKey(id: string, userId: string): Promise<string> {
  const token = generateToken('apiKey');
  await testEnv.DB.prepare(`INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at)
    VALUES(?,?,?,'s2a_key_ABCDEFGH','Q08','active',0,0)`).bind(id, userId, await hashToken('apiKey', token)).run();
  return token;
}
async function addChannel(id: string, priority: number, secret: string): Promise<void> {
  const encrypted = await encryptChannelSecret(secret, id, 'v1', keyBytes);
  await testEnv.DB.prepare(`INSERT INTO channels(id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES(?,?,?,?,'v1','active',?,2,60,1,0,0)`).bind(id, id, `https://provider-${id}.example.invalid`, encrypted, priority).run();
  await testEnv.DB.prepare('INSERT INTO channel_groups(channel_id,group_id) VALUES(?,?)').bind(id, group).run();
  await testEnv.DB.prepare(`INSERT INTO channel_models(channel_id,public_model_id,upstream_model,protocol,capabilities_json,config_version)
    VALUES(?,?,?,?,?,1)`).bind(id, model, `upstream-${id}`, 'responses', JSON.stringify({ protocol: 'responses', features: ['streaming', 'response_history'], maxOutputTokens: 64 })).run();
}

beforeEach(async () => {
  const now = Date.now();
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('q08-group','Q08','active',1,?,?)").bind(now, now).run();
  for (const [id, role] of [[owner, 'user'], [other, 'user']] as const) {
    await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES(?,?, 'test-only',?,'active','q08-group',1000000,2,60,'bootstrap',?,?)`).bind(id, `${id}@example.invalid`, role, now, now).run();
  }
  ownerKey = await addKey('q08-owner-key', owner);
  ownerSecondKey = await addKey('q08-owner-second-key', owner);
  otherKey = await addKey('q08-other-key', other);
  keyBytes = crypto.getRandomValues(new Uint8Array(32));
  env = { ...testEnv, ENVIRONMENT: 'local', PUBLIC_BASE_URL: origin, CHANNEL_KEYRING_JSON: JSON.stringify({ v1: btoa(String.fromCharCode(...keyBytes)) }), CHANNEL_ACTIVE_KEY_VERSION: 'v1' } as Env;
  await testEnv.DB.prepare(`INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES (?,'active','{"input":"1","output":"2"}', 1, 0, 64, 0, 0)`).bind(model).run();
  await addChannel(channelA, 10, 'q08-upstream-a'); await addChannel(channelB, 1, 'q08-upstream-b');
});

describe('Q08 Responses history ownership through the Worker', () => {
  it('keeps native continuation on the original channel and isolates user/key references', async () => {
    const calls: { url: string; previous?: string }[] = [];
    const upstream = vi.fn(async (url: string, init: RequestInit) => {
      const wire = JSON.parse(init.body as string) as { previous_response_id?: string };
      calls.push({ url, ...(wire.previous_response_id === undefined ? {} : { previous: wire.previous_response_id }) });
      if (url.includes(`provider-${channelB}`)) throw new Error('cross-channel upstream must not be called');
      return Response.json(response(calls.length === 1 ? 'provider-response-a-1' : 'provider-response-a-2', `upstream-${channelA}`));
    });
    vi.stubGlobal('fetch', upstream);

    const first = await call(ownerKey, body());
    expect(first.result.status).toBe(200);
    const publicId = (JSON.parse(first.text) as { id: string }).id;
    expect(publicId).toMatch(/^resp_[0-9a-f-]{36}$/);
    const continued = await call(ownerKey, body(publicId));
    expect(continued.result.status).toBe(200);
    expect(calls).toEqual([
      { url: `https://provider-${channelA}.example.invalid/v1/responses` },
      { url: `https://provider-${channelA}.example.invalid/v1/responses`, previous: 'provider-response-a-1' },
    ]);
    expect(upstream).toHaveBeenCalledTimes(2); expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(2);
    expect((await testEnv.DB.prepare('SELECT channel_id FROM requests ORDER BY created_at,id').all()).results).toEqual([{ channel_id: channelA }, { channel_id: channelA }]);

    for (const token of [ownerSecondKey, otherKey]) {
      const denied = await call(token, body(publicId));
      expect(denied.result.status).toBe(400); expect(JSON.parse(denied.text)).toHaveProperty('error');
    }
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('rejects channel failover and cross-protocol references instead of crossing ownership', async () => {
    const upstream = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes(`provider-${channelB}`)) throw new Error('cross-channel upstream must not be called');
      return Response.json(response('provider-response-a', `upstream-${channelA}`));
    });
    vi.stubGlobal('fetch', upstream);
    const first = await call(ownerKey, body());
    const publicId = (JSON.parse(first.text) as { id: string }).id;
    await testEnv.DB.prepare("UPDATE channels SET status='disabled' WHERE id=?").bind(channelA).run();
    await testEnv.CACHE.delete(routesCacheKey(group, model));
    const noFailover = await call(ownerKey, body(publicId));
    expect(noFailover.result.status).toBeGreaterThanOrEqual(400); expect(upstream).toHaveBeenCalledOnce();
    const crossProtocol = await chatWithHistory(ownerKey, publicId);
    expect(crossProtocol.result.status).toBe(400); expect(JSON.parse(crossProtocol.text)).toHaveProperty('error'); expect(upstream).toHaveBeenCalledOnce();
  });
});
