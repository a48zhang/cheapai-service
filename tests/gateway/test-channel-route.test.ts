import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestChannelRoutes } from '../../apps/worker/gateway/test-channel-route';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { issueCsrfToken, CSRF_HEADER_NAME } from '../../apps/worker/auth/csrf';
import { prepare } from '../../apps/worker/db';
import { testEnv } from '../helpers/database';

const now = 1000;
const origin = 'https://console.example.invalid';
const path = '/api/v1/admin/channels/g20-channel/test';
let adminCookie: string;
let userCookie: string;
const body = (protocol = 'chat') => ({ publicModelId: 'g20-model', protocol, channelVersion: 1, mappingVersion: 1, priceVersion: 1 });
function headers(cookie = adminCookie): Headers {
  const csrf = issueCsrfToken();
  return new Headers({ Cookie: `${cookie}; ${csrf.setCookie.split(';')[0]}`, Origin: origin, 'Content-Type': 'application/json', [CSRF_HEADER_NAME]: csrf.token });
}
const chatReply = () => Response.json({ id: 'provider-id', object: 'chat.completion', created: 0, model: 'upstream-chat',
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
const setup = (fetcher = vi.fn(async () => chatReply())) => createTestChannelRoutes({ now: () => now, trustedOrigin: origin, fetch: fetcher });
const actions = async () => (await prepare(testEnv.DB, "SELECT action,redacted_change_json,operation_id FROM admin_audit WHERE action LIKE 'channel.test.%' ORDER BY action").all()).rows;

beforeEach(async () => {
  await prepare(testEnv.DB, "INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('g20-group','G20 Group','active',1,0,0)").run();
  const cookies: string[] = [];
  for (const [id, role] of [['g20-admin', 'admin'], ['g20-user', 'user']]) {
    await prepare(testEnv.DB, `INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
      VALUES(?,?,'test-only-hash',?,'active','g20-group',2,60,'admin',0,0)`, [id!, `${id}@example.invalid`, role!]).run();
    cookies.push((await createCookieSession(testEnv.DB, id!, now)).setCookie.split(';')[0]!);
  }
  [adminCookie, userCookie] = cookies as [string, string];

  const credential = 'g20-synthetic-upstream-secret';
  await prepare(testEnv.DB, `INSERT INTO channels(id,name,base_url,upstream_key,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES('g20-channel','G20 Channel','https://provider.example.com/vendor/v1',?,'active',1,2,60,1,0,0)`, [credential]).run();
  await prepare(testEnv.DB, `INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES ('g20-model','active',?,1,0,4096,0,0)`, [JSON.stringify({ input: '1', output: '2' })]).run();
  for (const protocol of ['chat', 'responses', 'messages']) await prepare(testEnv.DB, `INSERT INTO channel_models
    (channel_id,public_model_id,protocol,upstream_model,capabilities_json,config_version) VALUES('g20-channel','g20-model',?,?,?,1)`,
    [protocol, `upstream-${protocol}`, JSON.stringify({ protocol, features: [], maxOutputTokens: 128 })]).run();
});

describe('explicit administrator channel probes using native D1 and mock fetch', () => {
  it.each(['chat', 'responses', 'messages'])('sends exactly one bounded configured %s request after intent audit', async protocol => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect((await actions()).map(row => row.action)).toEqual(['channel.test.intent']);
      expect(url).toContain('https://provider.example.com/vendor/v1/');
      const sent = JSON.parse(init.body as string);
      expect(sent.model).toBe(`upstream-${protocol}`); expect(sent.stream).toBe(false);
      expect(sent.max_tokens ?? sent.max_output_tokens).toBe(16);
      expect(JSON.stringify(sent)).toContain('Reply OK.');
      if (protocol === 'chat') return chatReply();
      if (protocol === 'messages') return Response.json({ id: 'msg_provider', type: 'message', role: 'assistant', model: 'upstream-messages',
        content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 1 } });
      return Response.json({ id: 'resp_provider', object: 'response', created_at: 0, model: 'upstream-responses', status: 'completed',
        output: [{ id: 'msg_output', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] }],
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } });
    });
    const app = createTestChannelRoutes({ now: () => now, trustedOrigin: origin, fetch: fetcher });
    const response = await app.request(path, { method: 'POST', headers: headers(), body: JSON.stringify(body(protocol)) }, testEnv);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const result = await response.json();
    expect(result).toMatchObject({ data: { outcome: 'responded', mayIncurUpstreamCost: true, userBalanceCharged: false, maxOutputTokens: 16 }, request_id: expect.any(String) });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await actions()).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('g20-synthetic-upstream-secret');
    expect((await prepare(testEnv.DB, 'SELECT count(*) AS n FROM billing_entries').first())?.n).toBe(0);
    expect((await prepare(testEnv.DB, 'SELECT count(*) AS n FROM requests').first())?.n).toBe(0);
  });

  it('does not trigger fetch or origin resolution on GET or unauthorized calls', async () => {
    const fetcher = vi.fn(async () => chatReply());
    const resolveOrigin = vi.fn(() => origin);
    const app = createTestChannelRoutes({ now: () => now, trustedOrigin: resolveOrigin, fetch: fetcher });
    expect((await app.request(path, { headers: headers() }, testEnv)).status).toBe(404);
    expect((await app.request(path, { method: 'POST', headers: headers(userCookie), body: JSON.stringify(body()) }, testEnv)).status).toBe(403);
    expect((await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) }, testEnv)).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled(); expect(resolveOrigin).not.toHaveBeenCalled();
  });

  it('rejects CSRF and arbitrary address, credential, owner or prompt fields', async () => {
    const fetcher = vi.fn(async () => chatReply()); const app = setup(fetcher);
    const invalidHeaders = headers(); invalidHeaders.set('Origin', 'https://attacker.invalid');
    expect((await app.request(path, { method: 'POST', headers: invalidHeaders, body: JSON.stringify(body()) }, testEnv)).status).toBe(403);
    for (const field of ['baseUrl', 'upstreamKey', 'owner', 'prompt', 'max_tokens']) {
      expect((await app.request(path, { method: 'POST', headers: headers(), body: JSON.stringify({ ...body(), [field]: 'untrusted' }) }, testEnv)).status).toBe(400);
    }
    expect(fetcher).not.toHaveBeenCalled(); expect(await actions()).toHaveLength(0);
  });

  it('rejects stale versions and disabled configuration before dispatch', async () => {
    const fetcher = vi.fn(async () => chatReply()); const app = setup(fetcher);
    expect((await app.request(path, { method: 'POST', headers: headers(), body: JSON.stringify({ ...body(), mappingVersion: 2 }) }, testEnv)).status).toBe(409);
    await prepare(testEnv.DB, "UPDATE channels SET status='disabled' WHERE id='g20-channel'").run();
    expect((await app.request(path, { method: 'POST', headers: headers(), body: JSON.stringify(body()) }, testEnv)).status).toBe(409);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rechecks actor state after async configuration resolution before dispatch', async () => {
    const fetcher = vi.fn(async () => chatReply());
    const app = createTestChannelRoutes({ now: () => now, fetch: fetcher, trustedOrigin: async () => {
      await prepare(testEnv.DB, "UPDATE users SET role='user' WHERE id='g20-admin'").run();
      return origin;
    } });
    const response = await app.request(path, { method: 'POST', headers: headers(), body: JSON.stringify(body()) }, testEnv);
    expect(response.status).toBe(409); expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports provider HTTP failures without leaking raw error content', async () => {
    const response = await setup(vi.fn(async () => new Response('provider private key and detailed error', { status: 429 })))
      .request(path, { method: 'POST', headers: headers(), body: JSON.stringify(body()) }, testEnv);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ data: { outcome: 'http_error', upstreamStatus: 429, mayIncurUpstreamCost: true } });
    expect(JSON.stringify(result)).not.toContain('provider private');
    expect(JSON.stringify(await actions())).not.toContain('provider private');
  });

  it('returns an explicit timeout diagnostic and aborts the single fetch', async () => {
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => { signal = init.signal as AbortSignal; return new Promise<Response>(() => {}); });
    const app = createTestChannelRoutes({ now: () => now, trustedOrigin: origin, fetch: fetcher, timeoutMs: 50 });
    const response = await app.request(path, { method: 'POST', headers: headers(), body: JSON.stringify(body()) }, testEnv);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ data: { outcome: 'timeout' } });
    expect(signal?.aborted).toBe(true); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch when intent audit fails', async () => {
    await prepare(testEnv.DB, "CREATE TRIGGER g20_no_intent BEFORE INSERT ON admin_audit WHEN NEW.action='channel.test.intent' BEGIN SELECT RAISE(ABORT,'test audit failure'); END").run();
    const fetcher = vi.fn(async () => chatReply());
    expect((await setup(fetcher).request(path, { method: 'POST', headers: headers(), body: JSON.stringify(body()) }, testEnv)).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not claim complete diagnostics if the post-probe audit fails', async () => {
    await prepare(testEnv.DB, "CREATE TRIGGER g20_no_result BEFORE INSERT ON admin_audit WHEN NEW.action LIKE 'channel.test.responded%' BEGIN SELECT RAISE(ABORT,'test audit failure'); END").run();
    const fetcher = vi.fn(async () => chatReply());
    expect((await setup(fetcher).request(path, { method: 'POST', headers: headers(), body: JSON.stringify(body()) }, testEnv)).status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await actions()).map(row => row.action)).toEqual(['channel.test.intent']);
  });
});
