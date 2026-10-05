import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, waitOnExecutionContext, runInDurableObject } from 'cloudflare:test';
import { dispatchGatewayRequest } from '../../apps/worker/gateway/dispatch';
import type { GatewayDispatchDependencies } from '../../apps/worker/gateway/dispatch';
import { generateToken, hashToken } from '../../apps/worker/auth/tokens';
import { LeaseStorage } from '../../apps/worker/limits/storage';
import { routesCacheKey } from '../../apps/worker/cache/routes';
import type { Protocol } from '../../packages/apicompat/types/shared';
import { testEnv } from '../helpers/database';
import { defaultProtocolRegistry } from '../../packages/apicompat';
import type { ProtocolRegistry } from '../../packages/apicompat';

const protocols: Protocol[] = ['chat', 'responses', 'messages'];
let token: string;
const active = (subject: string) => runInDurableObject(testEnv.GATE.get(testEnv.GATE.idFromName(subject)), (_instance, context) => new LeaseStorage(context.storage).read(Date.now()).leases.length);
function input(protocol: Protocol, stream = false): Record<string, unknown> {
  return protocol === 'responses' ? { model: `model-${protocol}`, input: 'Synthetic text', max_output_tokens: 16, stream }
    : { model: `model-${protocol}`, messages: [{ role: 'user', content: 'Synthetic text' }], max_tokens: 16, stream };
}
function output(protocol: Protocol, id = 'native_response'): Record<string, unknown> {
  if (protocol === 'chat') return { id, object: 'chat.completion', created: 1, model: 'provider', choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } };
  if (protocol === 'responses') return { id, object: 'response', created_at: 1, model: 'provider', status: 'completed', output: [{ id: 'item_native', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }], usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } };
  return { id, type: 'message', role: 'assistant', model: 'provider', content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
}
function sse(protocol: Protocol): Response {
  let events: { event?: string; data: unknown }[];
  if (protocol === 'chat') {
    const base = { id: 'native_response', object: 'chat.completion.chunk', created: 1, model: 'provider' };
    events = [ { data: { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }] } },
      { data: { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
      { data: { ...base, choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } } }, { data: '[DONE]' } ];
  } else if (protocol === 'messages') {
    events = [
      { type: 'message_start', message: { ...output(protocol), content: [], stop_reason: null, usage: { input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }, { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }, { type: 'message_stop' },
    ].map(value => ({ event: value.type, data: value }));
  } else {
    const item = { id: 'item_native', type: 'message', role: 'assistant', status: 'in_progress', content: [] };
    const part = { type: 'output_text', text: '', annotations: [] };
    const finalPart = { ...part, text: 'hello' };
    const finalItem = { ...item, status: 'completed', content: [finalPart] };
    events = [
      { type: 'response.created', response: { ...output(protocol), status: 'in_progress', output: [], usage: null } },
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.content_part.added', output_index: 0, item_id: item.id, content_index: 0, part },
      { type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: 'hello' },
      { type: 'response.output_text.done', output_index: 0, item_id: item.id, content_index: 0, text: 'hello' },
      { type: 'response.content_part.done', output_index: 0, item_id: item.id, content_index: 0, part: finalPart },
      { type: 'response.output_item.done', output_index: 0, item: finalItem }, { type: 'response.completed', response: output(protocol) },
    ].map((value, sequence_number) => ({ event: value.type, data: { ...value, sequence_number } }));
  }
  return new Response(events.map(item => `${item.event ? `event: ${item.event}\n` : ''}data: ${typeof item.data === 'string' ? item.data : JSON.stringify(item.data)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
}
async function addChannel(protocol: Protocol, channelId = `channel-${protocol}`, priority = 10) {
  const credential = 'PRIVATE_UPSTREAM_KEY';
  await testEnv.DB.prepare(`INSERT INTO channels(id,name,base_url,upstream_key,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES(?,'Fixture',?,?,'active',?,1,60,1,0,0)`).bind(channelId, `https://${channelId}.example`, credential, priority).run();
  await testEnv.DB.prepare("INSERT INTO channel_groups(channel_id,group_id) VALUES(?,'g14-group')").bind(channelId).run();
  const features = ['streaming', ...(protocol === 'chat' ? ['stream_usage'] : []), ...(protocol === 'responses' ? ['response_history'] : [])];
  await testEnv.DB.prepare('INSERT INTO channel_models(channel_id,public_model_id,upstream_model,protocol,capabilities_json,config_version) VALUES(?,?,?, ?,?,1)')
    .bind(channelId, `model-${protocol}`, 'provider', protocol, JSON.stringify({ protocol, features, maxOutputTokens: 64 })).run();
}
async function call(protocol: Protocol, payload: unknown, fetcher: GatewayDispatchDependencies['fetch'], extra: Partial<GatewayDispatchDependencies> = {}, headers: HeadersInit = {}) {
  const context = createExecutionContext();
  const response = await dispatchGatewayRequest({ DB: testEnv.DB, CACHE: testEnv.CACHE, GATE: testEnv.GATE, fetch: fetcher!, ...extra },
    new Request(`https://gateway.example/v1/${protocol}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(payload) }), protocol, context);
  const text = await response.text(); await waitOnExecutionContext(context);
  return { response, text };
}
beforeEach(async () => {
  await testEnv.DB.prepare("INSERT INTO groups(id,name,status,version,created_at,updated_at) VALUES('g14-group','Fixture','active',1,0,0)").run();
  for (const id of ['g14-user', 'g14-other']) await testEnv.DB.prepare(`INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES(?,?,'synthetic','user','active','g14-group',1000,1,60,'admin',0,0)`).bind(id, `${id}@example.invalid`).run();
  token = generateToken('apiKey');
  await testEnv.DB.prepare("INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at) VALUES('g14-key','g14-user',?,'s2a_key_ABCDEFGH','Fixture','active',0,0)").bind(await hashToken('apiKey', token)).run();

  for (const protocol of protocols) {
    await testEnv.DB.prepare(`INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES (?,'active','{"input":"1","output":"2"}',1,0,64,0,0)`).bind(`model-${protocol}`).run();
    await addChannel(protocol);
  }
});

describe('G14-BASE real native assembly, mock providers only', () => {
  it.each((['chat', 'responses'] as const).flatMap(from => (['chat', 'responses'] as const).flatMap(to => [false, true].map(stream => ({ from, to, stream })))))
  ('$from -> $to stream=$stream leaves omitted client output limits absent on the wire', async ({ from, to, stream }) => {
    await testEnv.DB.prepare('UPDATE channel_models SET protocol=?,capabilities_json=? WHERE public_model_id=?')
      .bind(to, JSON.stringify({ protocol: to, features: ['streaming', 'stream_usage'], maxOutputTokens: 64 }), `model-${from}`).run();
    const body: Record<string, unknown> = { ...input(from, stream) };
    delete body.max_tokens; delete body.max_output_tokens; delete body.max_completion_tokens;
    const provider = vi.fn(async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(init.body as string);
      for (const field of ['max_tokens', 'max_output_tokens', 'max_completion_tokens']) expect(sent).not.toHaveProperty(field);
      return stream ? sse(to) : Response.json(output(to));
    });
    const result = await call(from, body, provider);
    expect(result.response.status, result.text).toBe(200);
    expect(provider).toHaveBeenCalledOnce();
  });
  it.each(protocols.flatMap(protocol => [false, true].map(stream => ({ protocol, stream }))))('$protocol stream=$stream authenticates, admits, converts and bills once', async ({ protocol, stream }) => {
    const provider = vi.fn(async (_url: string, init: RequestInit) => {
      const wire = JSON.parse(init.body as string); expect(wire.model).toBe('provider'); expect(wire.stream).toBe(stream);
      expect(wire[protocol === 'responses' ? 'max_output_tokens' : protocol === 'messages' ? 'max_tokens' : 'max_tokens']).toBe(16);
      if (protocol === 'chat' && stream) expect(wire.stream_options.include_usage).toBe(true);
      expect(new Headers(init.headers).get(protocol === 'messages' ? 'x-api-key' : 'Authorization')).toContain('PRIVATE_UPSTREAM_KEY');
      expect(JSON.stringify(init.headers)).not.toContain(token);
      return stream ? sse(protocol) : Response.json(output(protocol));
    });
    const { response, text } = await call(protocol, input(protocol, stream), provider);
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    const requestId = response.headers.get('X-Request-Id'); expect(requestId).toBeTruthy(); expect(text).toContain(`resp_${requestId}`);
    expect(text).not.toContain('PRIVATE_UPSTREAM_KEY'); expect(text).toContain('hello'); expect(provider).toHaveBeenCalledTimes(1);
    if (protocol === 'chat' && stream) expect(text).not.toContain('"usage"');
    const row = await testEnv.DB.prepare('SELECT id,billing_status,cost_units FROM requests').first();
    expect(row).toEqual({ id: requestId, billing_status: 'settled', cost_units: 1300 });
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(1);
    expect(await testEnv.DB.prepare("SELECT balance_units FROM users WHERE id='g14-user'").first('balance_units')).toBe(-300);
    expect(await runInDurableObject(testEnv.GATE.get(testEnv.GATE.idFromName('user:g14-user')), (_instance, context) => new LeaseStorage(context.storage).read(Date.now()).leases.length)).toBe(0);
    const denied = await call(protocol, input(protocol), provider); expect(denied.response.status).toBe(402); expect(provider).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('Chat include_usage=%s changes presentation only, never accounting', async include_usage => {
    const payload = { ...input('chat', true), stream_options: { include_usage } };
    const provider = vi.fn(async (_url: string, init: RequestInit) => { expect(JSON.parse(init.body as string).stream_options.include_usage).toBe(true); return sse('chat'); });
    const { response, text } = await call('chat', payload, provider);
    expect(response.status).toBe(200); expect(text.includes('"usage"')).toBe(include_usage); expect(text).toContain('[DONE]');
    expect(payload.stream_options.include_usage).toBe(include_usage);
    expect(await testEnv.DB.prepare('SELECT cost_units FROM requests').first('cost_units')).toBe(1300);
  });

  it('bills actual Chat stream usage even when stream_usage was not declared', async () => {
    await testEnv.DB.prepare("UPDATE channel_models SET capabilities_json=? WHERE public_model_id='model-chat'").bind(JSON.stringify({ protocol: 'chat', features: ['streaming'], maxOutputTokens: 64 })).run();
    const provider = vi.fn(async () => sse('chat'));
    const result = await call('chat', { ...input('chat', true), stream_options: { include_usage: false } }, provider);
    expect(result.response.status).toBe(200); expect(provider).toHaveBeenCalledOnce();
    expect(await testEnv.DB.prepare('SELECT billing_status,cost_units FROM requests').first()).toEqual({ billing_status: 'settled', cost_units: 1300 });
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(1);
  });

  it('rejects unauthenticated and malformed requests before dispatch', async () => {
    const provider = vi.fn(async () => Response.json(output('chat')));
    const anonymous = await call('chat', {}, provider, {}, { Authorization: 'Bearer invalid' });
    expect(anonymous.response.status).toBe(401);
    const malformed = await call('chat', {}, provider);
    expect(malformed.response.status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM requests').first('n')).toBe(0);
  });

  it('enforces Key model permissions and serves an installed direct cross pair', async () => {
    const provider = vi.fn(async () => Response.json(output('responses')));
    await testEnv.DB.prepare("UPDATE api_keys SET allowed_models_json='[]' WHERE id='g14-key'").run();
    expect((await call('chat', input('chat'), provider)).response.status).toBe(403);
    await testEnv.DB.prepare("UPDATE api_keys SET allowed_models_json=NULL WHERE id='g14-key'").run();
    await testEnv.DB.prepare("UPDATE channel_models SET protocol='responses',capabilities_json=? WHERE public_model_id='model-chat'").bind(JSON.stringify({ protocol: 'responses', features: [], maxOutputTokens: 64 })).run();
    const cross = await call('chat', input('chat'), provider); expect(cross.response.status).toBe(200);
    expect(JSON.parse(cross.text)).toMatchObject({ object: 'chat.completion', choices: [{ message: { content: 'hello' } }] });
    expect(JSON.parse(cross.text)).not.toHaveProperty('request_id'); expect(provider).toHaveBeenCalledOnce();
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(1);
  });

  it('returns a request error for a local stream conversion rejection without fetch, billing, or lease residue', async () => {
    const provider = vi.fn(async () => sse('chat'));
    const registry = {
      directions: [{ from: 'chat', to: 'chat' }],
      available: () => true,
      lookup(direction: Parameters<ProtocolRegistry['lookup']>[0], context: Parameters<ProtocolRegistry['lookup']>[1]) {
        const resolved = defaultProtocolRegistry.lookup(direction, context);
        if (!resolved.ok) return resolved;
        return { ok: true as const, value: { ...resolved.value, request: { ...resolved.value.request,
          convert: () => ({ ok: false as const, error: { kind: 'invalid_request' as const, code: 'request_constraint', message: 'Request constraint rejected.', param: '$.stream_options' } }) } } };
      },
    } as unknown as ProtocolRegistry;
    const result = await call('chat', { ...input('chat', true), stream_options: { include_usage: false } }, provider, { registry });
    expect(result.response.status).toBe(400); expect(JSON.parse(result.text)).toHaveProperty('error'); expect(provider).not.toHaveBeenCalled();
    expect(await testEnv.DB.prepare('SELECT execution_status,billing_status,error_code FROM requests').first()).toMatchObject({ execution_status: 'failed', billing_status: 'not_chargeable', error_code: 'internal_error' });
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(0);
    expect(await active('user:g14-user')).toBe(0); expect(await active('channel:channel-chat')).toBe(0);
  });

  it('returns a request error for a local JSON conversion rejection without fetch, billing, or lease residue', async () => {
    const provider = vi.fn(async () => Response.json(output('chat')));
    const registry = {
      directions: [{ from: 'chat', to: 'chat' }],
      available: () => true,
      lookup(direction: Parameters<ProtocolRegistry['lookup']>[0], context: Parameters<ProtocolRegistry['lookup']>[1]) {
        const resolved = defaultProtocolRegistry.lookup(direction, context);
        if (!resolved.ok) return resolved;
        return { ok: true as const, value: { ...resolved.value, request: { ...resolved.value.request,
          convert: () => ({ ok: false as const, error: { kind: 'invalid_request' as const, code: 'request_constraint', message: 'Request constraint rejected.', param: '$.input' } }) } } };
      },
    } as unknown as ProtocolRegistry;
    const result = await call('chat', input('chat'), provider, { registry });
    expect(result.response.status).toBe(400); expect(JSON.parse(result.text)).toMatchObject({ error: { code: 'invalid_request' } }); expect(provider).not.toHaveBeenCalled();
    expect(await testEnv.DB.prepare('SELECT execution_status,billing_status,error_code FROM requests').first()).toMatchObject({ execution_status: 'failed', billing_status: 'not_chargeable', error_code: 'internal_error' });
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(0);
    expect(await active('user:g14-user')).toBe(0); expect(await active('channel:channel-chat')).toBe(0);
  });

  it.each(['busy', 'cooldown'])('only skips a reviewed unregistered %s channel, explicitly excluding it', async failure => {
    await addChannel('chat', 'spare-chat', 0);
    const gate = testEnv.GATE.get(testEnv.GATE.idFromName('channel:channel-chat'));
    if (failure === 'cooldown') await gate.setCooldown({ ttlMs: 60000, errorClass: 'rate_limited' });
    else await gate.acquire({ requestId: 'blocker', limit: 1, ttlMs: 60000 });
    const provider = vi.fn(async (url: string) => { expect(url).toContain('spare-chat.example'); return Response.json(output('chat')); });
    expect((await call('chat', input('chat'), provider)).response.status).toBe(200);
    expect(provider).toHaveBeenCalledTimes(1); expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM requests').first('n')).toBe(1);
  });

  it('does not switch or regenerate after a registered provider failure and hides private errors', async () => {
    await addChannel('chat', 'spare-chat', 0);
    const provider = vi.fn(async () => Response.json({ error: { message: 'PRIVATE_PROVIDER_SECRET' } }, { status: 500 }));
    const result = await call('chat', input('chat'), provider);
    expect(result.response.status).toBe(502); expect(result.text).not.toContain('PRIVATE_PROVIDER_SECRET'); expect(provider).toHaveBeenCalledTimes(1);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM requests').first('n')).toBe(1);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(0);
  });

  it('continues native Responses on its owned original channel with the upstream reference restored', async () => {
    await testEnv.DB.prepare("UPDATE users SET balance_units=10000 WHERE id='g14-user'").run();
    let calls = 0;
    const provider = vi.fn(async (url: string, init: RequestInit) => {
      calls++; expect(url).toContain('channel-responses.example');
      if (calls === 2) expect(JSON.parse(init.body as string).previous_response_id).toBe('native_first');
      return Response.json(output('responses', calls === 1 ? 'native_first' : 'native_second'));
    });
    const first = await call('responses', input('responses'), provider); const responseId = JSON.parse(first.text).id;
    await addChannel('responses', 'spare-responses', 100);
    await testEnv.CACHE.delete(routesCacheKey('g14-group', 'model-responses'));
    const second = await call('responses', { model: 'model-responses', previous_response_id: responseId, max_output_tokens: 16 }, provider);
    expect(second.response.status).toBe(200); expect(provider).toHaveBeenCalledTimes(2);
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(2);
    for (const owner of ['g14-user', 'g14-other']) {
      const otherToken = generateToken('apiKey');
      await testEnv.DB.prepare("INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at) VALUES(?,?,?,'s2a_key_ABCDEFGH','Fixture','active',0,0)")
        .bind(`history-key-${owner}`, owner, await hashToken('apiKey', otherToken)).run();
      const denied = await call('responses', { model: 'model-responses', previous_response_id: responseId }, provider, {}, { Authorization: `Bearer ${otherToken}` });
      expect(denied.response.status).toBe(400);
    }
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('associates cancellation completion with waitUntil rather than returning an unowned billing task', async () => {
    const context = createExecutionContext();
    const provider = vi.fn(async () => sse('chat'));
    const response = await dispatchGatewayRequest({ DB: testEnv.DB, CACHE: testEnv.CACHE, GATE: testEnv.GATE, fetch: provider },
      new Request('https://gateway.example/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input('chat', true)) }), 'chat', context);
    const reader = response.body!.getReader(); await reader.read(); await reader.cancel();
    await waitOnExecutionContext(context);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await testEnv.DB.prepare('SELECT billing_status FROM requests').first('billing_status')).toBe('settled');
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(1);
  });

  it('forwards requested Messages beta and version headers without policy configuration', async () => {
    const provider = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      expect(headers.get('anthropic-beta')).toBe('test-beta-2026');
      expect(headers.get('anthropic-version')).toBe('future-version');
      return Response.json(output('messages'));
    });
    const result = await call('messages', input('messages'), provider, {}, {
      'anthropic-beta': 'test-beta-2026', 'anthropic-version': 'future-version',
    });
    expect(result.response.status).toBe(200); expect(provider).toHaveBeenCalledOnce();
  });
});

describe('BV02 logical RPM and production cooldown wiring', () => {
  it.each(['busy', 'cooldown'])('counts one user RPM across %s fallback and a new count for a later dispatch', async failure => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    try {
      await testEnv.DB.prepare("UPDATE users SET rpm_limit=1,balance_units=10000 WHERE id='g14-user'").run();
      await addChannel('chat', 'spare-chat', 0);
      const gate = testEnv.GATE.get(testEnv.GATE.idFromName('channel:channel-chat'));
      if (failure === 'cooldown') await gate.setCooldown({ ttlMs: 60000, errorClass: 'rate_limited' });
      else await gate.acquire({ requestId: 'rpm-blocker', limit: 1, ttlMs: 60000 });
      const provider = vi.fn(async (url: string) => { expect(url).toContain('spare-chat.example'); return Response.json(output('chat')); });
      const first = await call('chat', input('chat'), provider);
      expect(first.response.status, first.text).toBe(200);
      const second = await call('chat', input('chat'), provider);
      expect(second.response.status, second.text).toBe(429);
      expect(provider).toHaveBeenCalledOnce();
      expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM requests').first('n')).toBe(1);
      expect(await active('user:g14-user')).toBe(0);
    } finally { clock.mockRestore(); }
  });

  it.each([401, 403, 429].flatMap(status => [false, true].flatMap(stream => ['json', 'html', 'empty'].map(format => ({ status, stream, format })))))
  ('observes $status stream=$stream format=$format before decoding and skips the cooled channel on the next call', async ({ status, stream, format }) => {
    await testEnv.DB.prepare("UPDATE users SET balance_units=10000 WHERE id='g14-user'").run();
    await addChannel('chat', 'spare-chat', 0);
    const provider = vi.fn(async (url: string) => {
      if (url.includes('spare-chat.example')) return stream ? sse('chat') : Response.json(output('chat'));
      const body = format === 'json' ? JSON.stringify({ error: { message: 'PRIVATE_ERROR' } }) : format === 'html' ? '<html>PRIVATE_ERROR</html>' : null;
      return new Response(body, { status, headers: { 'Content-Type': format === 'json' ? 'application/json' : 'text/html', 'Retry-After': '9999999999' } });
    });
    const first = await call('chat', input('chat', stream), provider);
    expect(first.response.status).toBe(502);
    expect(first.text).not.toContain('PRIVATE_ERROR');
    expect(provider).toHaveBeenCalledOnce();
    const cooldown = await testEnv.GATE.get(testEnv.GATE.idFromName('channel:channel-chat')).getCooldown();
    expect(cooldown).toMatchObject({ active: true, errorClass: status === 429 ? 'rate_limited' : 'auth_rejected' });
    expect(cooldown.retryAfterMs).toBeGreaterThan(290_000);
    expect(cooldown.retryAfterMs).toBeLessThanOrEqual(300_000);
    const second = await call('chat', input('chat', stream), provider);
    expect(second.response.status, second.text).toBe(200);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(await active('user:g14-user')).toBe(0);
    expect(await active('channel:channel-chat')).toBe(0);
    expect(await active('channel:spare-chat')).toBe(0);
  });
});

describe('BV02 uncertain cooldown write', () => {
  it('bounds a hanging Gate write without changing upstream classification or retaining leases', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gate: GatewayDispatchDependencies['GATE'] = {
      idFromName: name => testEnv.GATE.idFromName(name),
      get(id) {
        const native = testEnv.GATE.get(id);
        return { acquire: input => native.acquire(input), renew: input => native.renew(input), release: input => native.release(input),
          getCooldown: () => native.getCooldown(), setCooldown: () => new Promise(() => undefined) };
      },
    };
    try {
      const provider = vi.fn(async () => new Response('<html>PRIVATE_PROVIDER_ERROR</html>', { status: 429 }));
      const result = await call('chat', input('chat'), provider, { GATE: gate });
      expect(result.response.status).toBe(502);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('channel_cooldown_write_uncertain'));
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('"error_code":"timeout"'));
      expect(JSON.stringify(warning.mock.calls)).not.toContain('PRIVATE_PROVIDER_ERROR');
      expect(await active('user:g14-user')).toBe(0); expect(await active('channel:channel-chat')).toBe(0);
    } finally { warning.mockRestore(); }
  });
});
