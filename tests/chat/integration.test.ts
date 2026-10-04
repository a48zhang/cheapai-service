import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { LeaseStorage } from '../../apps/worker/limits/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../../apps/worker/app';
import type { Env } from '../../apps/worker/env';
import { issueCsrfToken } from '../../apps/worker/auth/csrf';
import { createCookieSession } from '../../apps/worker/auth/sessions';
import { generateToken } from '../../apps/worker/auth/tokens';
import { encryptChannelSecret } from '../../apps/worker/admin/channel-secrets';
import { ChatService, createD1ChatStorage as legacyD1Storage } from '../../apps/worker/chat/service';
import { createD1ChatStorage } from '../../apps/worker/chat/d1-storage';
import type { ChatStorage } from '../../apps/worker/chat/storage';
import { testEnv } from '../helpers/database';

/**
 * This file is intentionally contract driven.  The feature was delivered in
 * migration 0020+ and mounted by the root agent; until both the schema and the
 * route exist, the tests report a skip rather than turning another agent's
 * incomplete work into a failure.
 */
const origin = 'https://chat-integration.example';
const model = 'chat-integration-model';
const answer = 'local chat fixture answer';
const keyVersion = 'chat-test';

type Identity = { id: string; cookie: string; csrf: string; headers: HeadersInit };
type AppResult = { response: Response; text: string };

let env: Env;
let keyring: Uint8Array;
let sequence = 0;

function jsonHeaders(identity?: Identity, write = false): HeadersInit {
  if (!identity) return { 'Content-Type': 'application/json' };
  return {
    'Content-Type': 'application/json',
    Cookie: identity.cookie,
    ...(write ? identity.headers : {}),
  };
}

async function request(path: string, init: RequestInit = {}, requestEnv = env): Promise<AppResult> {
  const context = createExecutionContext();
  const response = await app.fetch(new Request(origin + path, init), requestEnv, context);
  const text = await response.text();
  await waitOnExecutionContext(context);
  return { response, text };
}

async function body(result: AppResult): Promise<any> {
  try { return JSON.parse(result.text); } catch { return null; }
}

function events(text: string): Array<{ event: string; data: any }> {
  return text.split(/\r?\n\r?\n/).flatMap(frame => {
    const lines = frame.split(/\r?\n/);
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return [];
    const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() ?? '';
    try { return [{ event, data: JSON.parse(data) }]; } catch { return [{ event, data }]; }
  });
}

function streamResponse(text = answer, responseModel = 'upstream-chat'): Response {
  const encoder = new TextEncoder();
  const frames = [
    { data: { id: 'chat-fixture', object: 'chat.completion.chunk', created: 1, model: responseModel, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] } },
    { data: { id: 'chat-fixture', object: 'chat.completion.chunk', created: 1, model: responseModel, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } },
    { data: { id: 'chat-fixture', object: 'chat.completion.chunk', created: 1, model: responseModel, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 0 } } } },
    { data: '[DONE]' },
  ];
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    const frame = frames[index++];
    if (!frame) { controller.close(); return; }
    controller.enqueue(encoder.encode(`data: ${typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data)}\n\n`));
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}

async function hasColumns(table: string, columns: string[]): Promise<boolean> {
  const row = await testEnv.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(table).first();
  if (!row) return false;
  const info = await testEnv.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  const found = new Set(info.results.map((column: { name: string }) => column.name));
  return columns.every(column => found.has(column));
}

async function chatContractReady(): Promise<boolean> {
  const schema = await Promise.all([
    hasColumns('chat_conversations', ['id', 'user_id', 'version']),
    hasColumns('chat_messages', ['id', 'conversation_id', 'status', 'operation_id']),
    hasColumns('api_keys', ['kind']),
    hasColumns('groups', ['billing_multiplier']),
  ]);
  if (schema.some(value => !value)) return false;
  const probe = await request('/api/v1/chat/models', {}, { ...env, PUBLIC_BASE_URL: origin });
  return probe.response.status !== 404;
}

async function createIdentity(id: string, groups: string[] = ['chat-full', 'chat-discount']): Promise<Identity> {
  const now = Date.now();
  await testEnv.DB.prepare(`INSERT INTO users
    (id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES (?,?,'fixture-hash','user','active',?,10000000,2,60,'admin',?,?)`)
    .bind(id, `${id}@example.invalid`, groups[0], now, now).run();
  for (const groupId of groups) {
    await testEnv.DB.prepare('INSERT OR IGNORE INTO user_group_access(user_id,group_id,created_at) VALUES(?,?,?)')
      .bind(id, groupId, now).run();
  }
  const session = await createCookieSession(testEnv.DB, id, now);
  const csrf = issueCsrfToken();
  return {
    id,
    cookie: `${session.setCookie.split(';', 1)[0]}; ${csrf.setCookie.split(';', 1)[0]}`,
    csrf: csrf.token,
    headers: { Origin: origin, 'X-CSRF-Token': csrf.token },
  };
}

async function seedChatFixtures(): Promise<void> {
  sequence += 1;
  const now = Date.now();
  for (const [id, name, multiplier] of [
    ['chat-full', 'Chat full', '1'],
    ['chat-discount', 'Chat 0.2x', '0.2'],
  ] as const) {
    await testEnv.DB.prepare(`INSERT INTO groups(id,name,status,version,created_at,updated_at,billing_multiplier)
      VALUES(?,?, 'active',1,?,?,?)`).bind(id, `${name} ${sequence}`, now, now, multiplier).run();
  }
  await testEnv.DB.prepare(`INSERT INTO models(public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at)
    VALUES(?,'active','{"input":"1","output":"1","cacheRead":"0.5"}',1,0,64,?,?)`).bind(model, now, now).run();
  for (const [groupId, channelId, upstream] of [
    ['chat-full', `chat-full-channel-${sequence}`, 'upstream-full'],
    ['chat-discount', `chat-discount-channel-${sequence}`, 'upstream-discount'],
  ] as const) {
    const encrypted = await encryptChannelSecret('local-chat-upstream-key', channelId, keyVersion, keyring);
    await testEnv.DB.prepare(`INSERT INTO channels
      (id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
      VALUES(?,?,?,?,'${keyVersion}','active',1,2,60,1,?,?)`)
      .bind(channelId, channelId, 'https://e2e-upstream.example.invalid/v1', encrypted, now, now).run();
    await testEnv.DB.prepare('INSERT INTO channel_groups(channel_id,group_id) VALUES(?,?)').bind(channelId, groupId).run();
    await testEnv.DB.prepare(`INSERT INTO channel_models(channel_id,public_model_id,protocol,upstream_model,capabilities_json,config_version)
      VALUES(?,?, 'chat',?,'{"protocol":"chat","features":["streaming","stream_usage"],"maxOutputTokens":64}',1)`)
      .bind(channelId, model, upstream).run();
  }
}

beforeEach(async () => {
  keyring = crypto.getRandomValues(new Uint8Array(32));
  env = {
    ...testEnv,
    ENVIRONMENT: 'local',
    PUBLIC_BASE_URL: origin,
    CHANNEL_ACTIVE_KEY_VERSION: keyVersion,
    CHANNEL_KEYRING_JSON: JSON.stringify({ [keyVersion]: btoa(String.fromCharCode(...keyring)) }),
  } as Env;
});

describe('web chat HTTP contract and accounting boundaries', () => {
  it('requires a session and CSRF, then returns authorized groups with exact multipliers', async () => {
    expect(await chatContractReady()).toBe(true);
    await seedChatFixtures();
    const user = await createIdentity('chat-contract-user');
    const anonymous = await request('/api/v1/chat/models', {}, env);
    expect(anonymous.response.status).toBe(401);
    const models = await request('/api/v1/chat/models', { headers: jsonHeaders(user) }, env);
    expect(models.response.status).toBe(200);
    const catalog = (await body(models)).data.items as Array<{ id: string; billingMultiplier: string; models: Array<{ publicModelId: string }> }>;
    const fullGroup = catalog.find(group => group.id === 'chat-full');
    const discountGroup = catalog.find(group => group.id === 'chat-discount');
    expect(fullGroup?.billingMultiplier).toBe('1');
    expect(discountGroup?.billingMultiplier).toBe('0.2');
    expect(fullGroup?.models.some(item => item.publicModelId === model)).toBe(true);
    expect(discountGroup?.models.some(item => item.publicModelId === model)).toBe(true);
    // A smaller alternate channel must not reduce the model limit offered by
    // another eligible channel. The gateway filters candidates per request.
    await testEnv.DB.prepare("UPDATE channel_models SET capabilities_json=json_set(capabilities_json,'$.maxOutputTokens',8) WHERE channel_id=?")
      .bind(`chat-discount-channel-${sequence}`).run();
    await testEnv.DB.prepare("INSERT INTO channel_groups(channel_id,group_id) VALUES(?,'chat-full')")
      .bind(`chat-discount-channel-${sequence}`).run();
    const mixed = await body(await request('/api/v1/chat/models', { headers: jsonHeaders(user) }));
    expect(mixed.data.items.find((group: { id: string }) => group.id === 'chat-full').models)
      .toContainEqual({ publicModelId: model, maxOutputTokens: 64, sellPrices: { input: '1', output: '1', cacheRead: '0.5' } });
    await testEnv.DB.prepare("UPDATE user_group_access SET created_at=? WHERE user_id=? AND group_id='chat-discount'")
      .bind(Date.now() + 60_000, user.id).run();
    const beforeGrant = await body(await request('/api/v1/chat/models', { headers: jsonHeaders(user) }));
    expect(beforeGrant.data.items.some((group: { id: string }) => group.id === 'chat-discount')).toBe(false);
    const withoutCsrf = await request('/api/v1/chat/conversations', {
      method: 'POST', headers: jsonHeaders(user), body: JSON.stringify({ groupId: 'chat-full', modelId: model }),
    });
    expect(withoutCsrf.response.status).toBe(403);
    const conversation = await request('/api/v1/chat/conversations', {
      method: 'POST', headers: jsonHeaders(user, true), body: JSON.stringify({ groupId: 'chat-full', modelId: model }),
    });
    expect(conversation.response.status, conversation.text).toBe(201);
    expect(await body(conversation)).toMatchObject({ data: { groupId: 'chat-full', modelId: model, version: expect.any(Number) } });
  }, 30_000);

  it('does not cross conversation ownership and refuses an unauthorized group at send time', async () => {
    expect(await chatContractReady()).toBe(true);
    await seedChatFixtures();
    const owner = await createIdentity('chat-owner', ['chat-full']);
    const other = await createIdentity('chat-other', ['chat-full']);
    const created = await request('/api/v1/chat/conversations', {
      method: 'POST', headers: jsonHeaders(owner, true), body: JSON.stringify({ groupId: 'chat-full', modelId: model }),
    });
    const conversation = (await body(created)).data;
    const foreignRead = await request(`/api/v1/chat/conversations/${conversation.id}`, { headers: jsonHeaders(other) });
    expect([403, 404]).toContain(foreignRead.response.status);
    const forgedGroup = await request(`/api/v1/chat/conversations/${conversation.id}/messages`, {
      method: 'POST', headers: jsonHeaders(owner, true), body: JSON.stringify({ operationId: 'forged-group', conversationVersion: conversation.version, groupId: 'chat-discount', modelId: model, content: 'must be denied' }),
    });
    expect([400, 403], forgedGroup.text).toContain(forgedGroup.response.status);
    const rows = await testEnv.DB.prepare('SELECT COUNT(*) AS count FROM chat_messages').first<{ count: number }>();
    expect(rows?.count).toBe(0);
  }, 30_000);

  it('replays a duplicate operation once, bills once, and never exposes the virtual key as a Bearer key', async () => {
    expect(await chatContractReady()).toBe(true);
    await seedChatFixtures();
    const user = await createIdentity('chat-idempotency-user');
    const created = await request('/api/v1/chat/conversations', {
      method: 'POST', headers: jsonHeaders(user, true), body: JSON.stringify({ groupId: 'chat-full', modelId: model }),
    });
    const conversation = (await body(created)).data;
    const operationId = 'same-chat-operation';
    const input = { operationId, conversationVersion: conversation.version, groupId: 'chat-full', modelId: model, content: 'only once' };
    const calls: Array<{ body: string; headers: Headers }> = [];
    vi.stubGlobal('fetch', async (inputRequest: RequestInfo | URL, init?: RequestInit) => {
      const upstream = new Request(inputRequest, init);
      calls.push({ body: await upstream.clone().text(), headers: upstream.headers });
      let upstreamModel = 'upstream-chat';
      try { upstreamModel = (JSON.parse(calls.at(-1)?.body ?? '{}') as { model?: string }).model ?? upstreamModel; } catch { /* gateway reports malformed fixtures */ }
      return streamResponse(answer, upstreamModel);
    });
    const [first, replay] = await Promise.all([
      request(`/api/v1/chat/conversations/${conversation.id}/messages`, { method: 'POST', headers: jsonHeaders(user, true), body: JSON.stringify(input) }),
      request(`/api/v1/chat/conversations/${conversation.id}/messages`, { method: 'POST', headers: jsonHeaders(user, true), body: JSON.stringify(input) }),
    ]);
    expect(first.response.status, first.text).toBe(200);
    expect(replay.response.status, replay.text).toBe(200);
    const firstEvents = events(first.text); const replayEvents = events(replay.text);
    expect([...firstEvents, ...replayEvents].some(event => event.event === 'done' || event.data?.message)).toBe(true);
    const firstJson = await body(first); const replayJson = await body(replay);
    expect([firstJson, replayJson].some(value => value?.data?.replayed === true)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get('Authorization') ?? '').not.toContain('s2a_key_');
    const [requestCount, chargeCount] = await Promise.all([
      testEnv.DB.prepare('SELECT COUNT(*) AS count FROM requests WHERE user_id=?').bind(user.id).first<{ count: number }>(),
      testEnv.DB.prepare("SELECT COUNT(*) AS count FROM billing_entries WHERE user_id=? AND kind='consumption'").bind(user.id).first<{ count: number }>(),
    ]);
    expect(requestCount?.count).toBe(1); expect(chargeCount?.count).toBe(1);
    const linked = await testEnv.DB.prepare(`SELECT m.operation_id,m.request_id,r.source,r.user_id,r.group_id,r.public_model_id
      FROM chat_messages m JOIN requests r ON r.id=m.request_id WHERE m.conversation_id=? AND m.role='assistant'`)
      .bind(conversation.id).first();
    expect(linked).toMatchObject({ operation_id: operationId, request_id: expect.any(String), source: 'web_chat',
      user_id: user.id, group_id: 'chat-full', public_model_id: model });
    const virtual = await testEnv.DB.prepare("SELECT kind,key_hash,display_prefix,group_id FROM api_keys WHERE user_id=? AND kind='web_chat'").bind(user.id).first<any>();
    expect(virtual).toMatchObject({ kind: 'web_chat', key_hash: null, display_prefix: null, group_id: null });
    const listed = await request('/api/v1/keys', { headers: jsonHeaders(user) });
    expect(listed.response.status).toBe(200);
    expect(JSON.stringify(await body(listed))).not.toContain('web_chat');
    const bearer = await request('/v1/models', { headers: { Authorization: `Bearer ${generateToken('apiKey')}` } });
    expect(bearer.response.status).toBe(401);
  }, 30_000);

  it('uses the selected group snapshot for a shared model and charges 0.2x exactly', async () => {
    expect(await chatContractReady()).toBe(true);
    await seedChatFixtures();
    const user = await createIdentity('chat-billing-user');
    let calls = 0;
    vi.stubGlobal('fetch', async (inputRequest: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const upstream = new Request(inputRequest, init);
      let upstreamModel = 'upstream-chat';
      try { upstreamModel = (JSON.parse(await upstream.text()) as { model?: string }).model ?? upstreamModel; } catch { /* gateway reports malformed fixtures */ }
      return streamResponse(calls === 1 ? answer : answer, upstreamModel);
    });
    const fullConversationResult = await request('/api/v1/chat/conversations', {
      method: 'POST', headers: jsonHeaders(user, true), body: JSON.stringify({ groupId: 'chat-full', modelId: model }),
    });
    const fullConversation = (await body(fullConversationResult)).data;
    const discountedConversationResult = await request('/api/v1/chat/conversations', {
      method: 'POST', headers: jsonHeaders(user, true), body: JSON.stringify({ groupId: 'chat-discount', modelId: model }),
    });
    const discountedConversation = (await body(discountedConversationResult)).data;
    const start = Number((await testEnv.DB.prepare('SELECT balance_units FROM users WHERE id=?').bind(user.id).first<{ balance_units: number }>())?.balance_units);
    for (const conversation of [fullConversation, discountedConversation]) {
      const sent = await request(`/api/v1/chat/conversations/${conversation.id}/messages`, {
        method: 'POST', headers: jsonHeaders(user, true), body: JSON.stringify({ operationId: `billing-${conversation.id}`, conversationVersion: conversation.version, groupId: conversation.groupId, modelId: model, content: 'bill this' }),
      });
      expect(sent.response.status, sent.text).toBe(200);
      expect(events(sent.text).some(event => event.event === 'done')).toBe(true);
    }
    expect(calls).toBe(2);
    const finish = Number((await testEnv.DB.prepare('SELECT balance_units FROM users WHERE id=?').bind(user.id).first<{ balance_units: number }>())?.balance_units);
    const charges = await testEnv.DB.prepare("SELECT cost_units,group_id,price_snapshot FROM requests WHERE user_id=? ORDER BY created_at,id").bind(user.id).all<{ cost_units: number; group_id: string; price_snapshot: string }>();
    expect(charges.results).toHaveLength(2);
    const full = charges.results.find((row: { group_id: string }) => row.group_id === 'chat-full');
    const discounted = charges.results.find((row: { group_id: string }) => row.group_id === 'chat-discount');
    expect(JSON.parse(full?.price_snapshot ?? '{}')).toMatchObject({ group_id: 'chat-full', billing_multiplier: '1' });
    expect(JSON.parse(discounted?.price_snapshot ?? '{}')).toMatchObject({ group_id: 'chat-discount', billing_multiplier: '0.2' });
    expect(Number(full?.cost_units)).toBe(Number(discounted?.cost_units) * 5);
    expect(start - finish).toBe(Number(full?.cost_units) + Number(discounted?.cost_units));
  }, 30_000);

  it('keeps the input and records a failed assistant when the local upstream fails', async () => {
    expect(await chatContractReady()).toBe(true);
    await seedChatFixtures();
    const user = await createIdentity('chat-failure-user');
    vi.stubGlobal('fetch', async () => { throw new Error('synthetic upstream failure'); });
    const created = await request('/api/v1/chat/conversations', {
      method: 'POST', headers: jsonHeaders(user, true), body: JSON.stringify({ groupId: 'chat-full', modelId: model }),
    });
    const conversation = (await body(created)).data;
    const sent = await request(`/api/v1/chat/conversations/${conversation.id}/messages`, {
      method: 'POST', headers: jsonHeaders(user, true), body: JSON.stringify({ operationId: 'failed-chat-operation', conversationVersion: conversation.version, groupId: 'chat-full', modelId: model, content: 'retain this prompt' }),
    });
    expect(sent.response.status, sent.text).toBe(200);
    expect(events(sent.text).some(event => event.event === 'error')).toBe(true);
    const history = await request(`/api/v1/chat/conversations/${conversation.id}`, { headers: jsonHeaders(user) });
    expect(history.response.status).toBe(200);
    const failedMessages = (await body(history)).data.messages as Array<{ role: string; content: string; status: string }>;
    expect(failedMessages.some(message => message.role === 'user' && message.content === 'retain this prompt')).toBe(true);
    expect(failedMessages.some(message => message.role === 'assistant' && message.status === 'failed')).toBe(true);
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM billing_entries WHERE user_id=? AND kind='consumption'").bind(user.id).first<{ count: number }>())?.count).toBe(0);
  }, 30_000);

  it('propagates a cancelled browser stream and persists a stopped assistant', async () => {
    expect(await chatContractReady()).toBe(true);
    await seedChatFixtures();
    const user = await createIdentity('chat-stop-user');
    const created = await request('/api/v1/chat/conversations', {
      method: 'POST', headers: jsonHeaders(user, true), body: JSON.stringify({ groupId: 'chat-full', modelId: model }),
    });
    const conversation = (await body(created)).data;
    let upstreamAbort: (() => void) | undefined;
    const abortObserved = new Promise<void>(resolve => { upstreamAbort = resolve; });
    vi.stubGlobal('fetch', async (_inputRequest: RequestInfo | URL, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => upstreamAbort?.(), { once: true });
      const encoder = new TextEncoder();
      let first = true;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!first) return new Promise<void>(() => { /* hold until Request.signal aborts */ });
          first = false;
          controller.enqueue(encoder.encode('data: {"id":"stop-fixture","object":"chat.completion.chunk","created":1,"model":"upstream-full","choices":[{"index":0,"delta":{"role":"assistant","content":"partial"},"finish_reason":null}]}\n\n'));
        },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const controller = new AbortController();
    const execution = createExecutionContext();
    const response = await app.fetch(new Request(origin + `/api/v1/chat/conversations/${conversation.id}/messages`, {
      method: 'POST', signal: controller.signal, headers: jsonHeaders(user, true),
      body: JSON.stringify({ operationId: 'stopped-chat-operation', conversationVersion: conversation.version, groupId: 'chat-full', modelId: model, content: 'retain before stop' }),
    }), env, execution);
    const reader = response.body?.getReader();
    expect(reader).toBeTruthy();
    await Promise.race([
      reader!.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('chat stream did not start')), 5000)),
    ]);
    controller.abort();
    // Request.signal alone must wake the pending upstream read and finalize;
    // a second downstream reader.cancel() must not be required.
    while (!(await reader!.read()).done) { /* Drain the bounded terminal event. */ }
    await Promise.race([
      abortObserved,
      new Promise((_, reject) => setTimeout(() => reject(new Error('upstream did not receive cancellation')), 5000)),
    ]);
    await waitOnExecutionContext(execution);
    const history = await request(`/api/v1/chat/conversations/${conversation.id}`, { headers: jsonHeaders(user) });
    expect(history.response.status).toBe(200);
    const stoppedMessages = (await body(history)).data.messages as Array<{ role: string; content: string; status: string }>;
    expect(stoppedMessages.some(message => message.role === 'user' && message.content === 'retain before stop')).toBe(true);
    expect(stoppedMessages.some(message => message.role === 'assistant' && message.status === 'stopped')).toBe(true);
    for (const subject of [`user:${user.id}`, `channel:chat-full-channel-${sequence}`]) {
      expect(await runInDurableObject(testEnv.GATE.get(testEnv.GATE.idFromName(subject)), (_instance, context) =>
        new LeaseStorage(context.storage).read(Date.now()).leases.length)).toBe(0);
    }
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(0);
  }, 30_000);

  it('checkpoint failure through the real Chat SSE bridge cancels upstream and releases both leases once', async () => {
    await seedChatFixtures();
    const user = await createIdentity('chat-checkpoint-user');
    const created = await request('/api/v1/chat/conversations', {
      method: 'POST', headers: jsonHeaders(user, true), body: JSON.stringify({ groupId: 'chat-full', modelId: model }),
    });
    const conversation = (await body(created)).data;
    const cancelled = vi.fn();
    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
      upstreamSignal = init?.signal as AbortSignal;
      let sent = false;
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
        if (sent) return new Promise<void>(() => {});
        sent = true;
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: 'checkpoint-fixture', object: 'chat.completion.chunk', created: 1,
          model: 'upstream-full', choices: [{ index: 0, delta: { content: 'x'.repeat(2200) }, finish_reason: null }] })}\n\n`));
      }, cancel: cancelled }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'text/event-stream' } });
    });
    let checkpointAttempts = 0;
    const failing = new Proxy(testEnv.DB, { get(target, property, receiver) {
      if (property === 'prepare') return (sql: string) => {
        if (/UPDATE chat_messages SET content=\?,updated_at/.test(sql)) {
          checkpointAttempts++;
          throw new Error('synthetic checkpoint failure');
        }
        return target.prepare(sql);
      };
      return Reflect.get(target, property, receiver);
    } }) as D1Database;
    const sent = await request(`/api/v1/chat/conversations/${conversation.id}/messages`, {
      method: 'POST', headers: jsonHeaders(user, true), body: JSON.stringify({ operationId: 'checkpoint-failure',
        conversationVersion: conversation.version, groupId: 'chat-full', modelId: model, content: 'retain failed answer' }),
    }, { ...env, DB: failing });
    expect(sent.response.status).toBe(200);
    expect(events(sent.text).filter(event => event.event === 'error')).toHaveLength(1);
    expect(sent.text).toContain('persistence_error');
    expect(checkpointAttempts).toBe(1);
    expect(upstreamSignal?.aborted).toBe(true);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(await testEnv.DB.prepare("SELECT status,content FROM chat_messages WHERE role='assistant'").first())
      .toMatchObject({ status: 'failed', content: 'x'.repeat(2200) });
    for (const subject of [`user:${user.id}`, `channel:chat-full-channel-${sequence}`]) {
      expect(await runInDurableObject(testEnv.GATE.get(testEnv.GATE.idFromName(subject)), (_instance, context) =>
        new LeaseStorage(context.storage).read(Date.now()).leases.length)).toBe(0);
    }
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(0);
    expect(await testEnv.DB.prepare('SELECT execution_status FROM requests').first('execution_status')).toBe('cancelled');
  }, 30_000);

  it('web Chat shares the real gateway cooldown and skips the failed channel on the next conversation', async () => {
    await seedChatFixtures();
    const user = await createIdentity('chat-cooldown-user');
    const upstream = vi.fn(async () => new Response('not-json', { status: 401 }));
    vi.stubGlobal('fetch', upstream);
    for (const operationId of ['cooldown-first', 'cooldown-next']) {
      const created = await request('/api/v1/chat/conversations', {
        method: 'POST', headers: jsonHeaders(user, true), body: JSON.stringify({ groupId: 'chat-full', modelId: model }),
      });
      const conversation = (await body(created)).data;
      const sent = await request(`/api/v1/chat/conversations/${conversation.id}/messages`, {
        method: 'POST', headers: jsonHeaders(user, true), body: JSON.stringify({ operationId, conversationVersion: conversation.version,
          groupId: 'chat-full', modelId: model, content: 'cooldown route probe' }),
      });
      expect(sent.response.status >= 400 || events(sent.text).some(event => event.event === 'error')).toBe(true);
    }
    expect(upstream).toHaveBeenCalledOnce();
    expect(await testEnv.GATE.get(testEnv.GATE.idFromName(`channel:chat-full-channel-${sequence}`)).getCooldown())
      .toMatchObject({ active: true, errorClass: 'auth_rejected' });
    expect(await testEnv.DB.prepare('SELECT COUNT(*) AS n FROM billing_entries').first('n')).toBe(0);
  }, 30_000);

  it('creates a new charged variant for regenerate and rejects stale version updates', async () => {
    expect(await chatContractReady()).toBe(true);
    await seedChatFixtures();
    const user = await createIdentity('chat-version-user');
    let calls = 0;
    vi.stubGlobal('fetch', async (inputRequest: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const upstream = new Request(inputRequest, init);
      let upstreamModel = 'upstream-chat';
      try { upstreamModel = (JSON.parse(await upstream.text()) as { model?: string }).model ?? upstreamModel; } catch { /* gateway reports malformed fixtures */ }
      return streamResponse(calls === 1 ? 'first answer' : 'second answer', upstreamModel);
    });
    const created = await request('/api/v1/chat/conversations', {
      method: 'POST', headers: jsonHeaders(user, true), body: JSON.stringify({ groupId: 'chat-full', modelId: model }),
    });
    const conversation = (await body(created)).data;
    const sent = await request(`/api/v1/chat/conversations/${conversation.id}/messages`, {
      method: 'POST', headers: jsonHeaders(user, true), body: JSON.stringify({ operationId: 'version-send', conversationVersion: conversation.version, groupId: 'chat-full', modelId: model, content: 'versioned prompt' }),
    });
    expect(sent.response.status, sent.text).toBe(200);
    const afterSend = (await body(await request(`/api/v1/chat/conversations/${conversation.id}`, { headers: jsonHeaders(user) }))).data;
    const oldAssistant = afterSend.messages.find((message: any) => message.role === 'assistant');
    expect(oldAssistant).toBeTruthy();
    const regenerated = await request(`/api/v1/chat/conversations/${conversation.id}/regenerate`, {
      method: 'POST', headers: jsonHeaders(user, true), body: JSON.stringify({ operationId: 'version-regenerate', conversationVersion: afterSend.conversation.version, groupId: 'chat-full', modelId: model }),
    });
    expect(regenerated.response.status, regenerated.text).toBe(200);
    const afterRegenerate = (await body(await request(`/api/v1/chat/conversations/${conversation.id}`, { headers: jsonHeaders(user) }))).data;
    const assistants = afterRegenerate.messages.filter((message: any) => message.role === 'assistant');
    expect(calls).toBe(2); expect(assistants.length).toBe(2);
    expect(assistants.some((message: any) => message.variant === oldAssistant.variant && message.selected === false)).toBe(true);
    expect(assistants.some((message: any) => message.selected === true && message.content.includes('second answer'))).toBe(true);
    const stale = await request(`/api/v1/chat/conversations/${conversation.id}`, {
      method: 'PATCH', headers: jsonHeaders(user, true), body: JSON.stringify({ version: afterSend.conversation.version, title: 'stale write', groupId: 'chat-full', modelId: model }),
    });
    expect(stale.response.status, stale.text).toBe(409);
    const selected = await request(`/api/v1/chat/conversations/${conversation.id}/select`, {
      method: 'POST', headers: jsonHeaders(user, true), body: JSON.stringify({ conversationVersion: afterRegenerate.conversation.version, messageId: oldAssistant.id }),
    });
    expect(selected.response.status).toBe(200);
    expect((await body(selected)).data.messages.find((message: any) => message.id === oldAssistant.id).selected).toBe(true);
  }, 30_000);
});


describe('extracted ChatStorage contract', () => {
  it('uses injected isolated storage without touching D1 for conversation reads', async () => {
    const conversation = { id: 'isolated-conversation', title: 'isolated', groupId: null, modelId: null,
      version: 1, createdAt: 1, updatedAt: 1 };
    const view = { conversation, messages: [] };
    const unsupported = async (): Promise<never> => { throw new Error('unexpected storage operation'); };
    const storage: ChatStorage = {
      listConversations: vi.fn(async () => ({ items: [conversation], nextCursor: null })),
      getConversation: vi.fn(async () => view),
      createConversation: unsupported, updateConversation: unsupported, deleteConversation: unsupported,
      startMessage: unsupported, associateRequest: unsupported, saveAssistantProgress: unsupported,
      finishAssistant: unsupported, selectVersion: unsupported,
    };
    const database = new Proxy({} as D1Database, { get() { throw new Error('D1 must not be accessed'); } });
    const service = new ChatService({ database, storage, now: () => 1 });
    expect(service.storage).toBe(storage);
    expect(await service.conversations('isolated-user', null, 20)).toEqual({ items: [conversation], nextCursor: null });
    expect(await service.conversation('isolated-user', conversation.id)).toEqual(view);
    expect(storage.listConversations).toHaveBeenCalledWith('isolated-user', null, 20);
    expect(storage.getConversation).toHaveBeenCalledWith('isolated-user', conversation.id);
  });

  it('preserves D1 replay, CAS, checkpoints, regeneration context and deletion boundaries', async () => {
    expect(legacyD1Storage).toBe(createD1ChatStorage);
    await seedChatFixtures();
    const user = await createIdentity('storage-contract-user');
    const storage: ChatStorage = createD1ChatStorage(testEnv.DB);
    const now = Date.now();
    const conversation = await storage.createConversation(user.id, { groupId: 'chat-full', modelId: model, now });
    const input = { operationId: 'storage-contract-send', conversationVersion: conversation.version,
      groupId: 'chat-full', modelId: model, content: 'preserved prompt', now, regenerate: false };
    const accepted = await storage.startMessage(user.id, conversation.id, input);
    expect(accepted.kind).toBe('accepted');
    if (accepted.kind !== 'accepted') throw new Error('expected accepted generation');
    expect(accepted.context).toEqual([{ role: 'user', content: 'preserved prompt' }]);
    expect((await storage.startMessage(user.id, conversation.id, input)).kind).toBe('replayed');
    await expect(storage.startMessage(user.id, conversation.id, { ...input, operationId: 'competing-generation' }))
      .rejects.toMatchObject({ code: 'conflict' });
    await storage.saveAssistantProgress(user.id, conversation.id, accepted.assistantMessage.id, 'partial', now + 1);
    expect((await storage.getConversation(user.id, conversation.id))?.messages)
      .toContainEqual(expect.objectContaining({ id: accepted.assistantMessage.id, content: 'partial', status: 'generating' }));
    await storage.finishAssistant(user.id, conversation.id, accepted.assistantMessage.id, 'completed', 'first answer', now + 2);
    const finished = await storage.getConversation(user.id, conversation.id);
    await expect(storage.updateConversation(user.id, conversation.id, conversation.version, { title: 'stale' }, now + 3))
      .rejects.toMatchObject({ code: 'conflict' });
    const regenerated = await storage.startMessage(user.id, conversation.id, { ...input,
      operationId: 'storage-contract-regenerate', conversationVersion: finished!.conversation.version, regenerate: true, now: now + 3 });
    expect(regenerated.kind).toBe('accepted');
    if (regenerated.kind !== 'accepted') throw new Error('expected regenerated generation');
    expect(regenerated.context).toEqual([{ role: 'user', content: 'preserved prompt' }]);
    await expect(storage.deleteConversation(user.id, conversation.id, regenerated.conversation.version, now + 4))
      .rejects.toMatchObject({ code: 'conflict' });
    await storage.finishAssistant(user.id, conversation.id, regenerated.assistantMessage.id, 'stopped', 'stopped answer', now + 4);
    const stopped = await storage.getConversation(user.id, conversation.id);
    expect(await storage.deleteConversation(user.id, conversation.id, stopped!.conversation.version, now + 4)).toBe(true);
    await expect(storage.saveAssistantProgress(user.id, conversation.id, regenerated.assistantMessage.id, 'late', now + 5))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(storage.finishAssistant(user.id, conversation.id, regenerated.assistantMessage.id, 'completed', 'late', now + 5))
      .rejects.toMatchObject({ code: 'not_found' });
    expect(await storage.getConversation(user.id, conversation.id)).toBeNull();
  });
});
