import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { app } from '../../../apps/worker/app';
import type { Env } from '../../../apps/worker/env';
import { encryptChannelSecret } from '../../../apps/worker/admin/channel-secrets';
import { generateToken, hashToken } from '../../../apps/worker/auth/tokens';
import { LeaseStorage } from '../../../apps/worker/limits/storage';
import { prepare } from '../../../apps/worker/db';
import { testEnv } from '../../helpers/database';
import type { UpstreamFetch } from '../../../apps/worker/gateway/transport';
import type { Protocol } from '../../../packages/apicompat/types/shared';

export type { UpstreamFetch } from '../../../apps/worker/gateway/transport';

export type MatrixUpstream = Protocol;
export type MatrixScenario = 'text' | 'single-tool' | 'parallel-tool' | 'error';

export interface MatrixTool {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
  readonly result: string;
}

export interface MatrixFixture {
  readonly id: string;
  readonly publicModel: string;
  readonly upstreamModel: string;
  readonly answer: string;
  readonly followupAnswer: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number };
  readonly singleTool: MatrixTool;
  readonly parallelTools: readonly MatrixTool[];
  readonly error: { readonly status: number; readonly code: string; readonly message: string };
}

export interface MatrixHarness {
  readonly fixture: MatrixFixture;
  readonly upstream: MatrixUpstream;
  readonly publicModel: string;
  readonly upstreamModel: string;
  readonly channelId: string;
  readonly userId: string;
  readonly token: string;
  readonly keyring: Map<string, Uint8Array>;
  /** Calls the real Worker app route. Tests inject only the upstream with vi.stubGlobal('fetch'). */
  readonly call: (payload: unknown, headers?: HeadersInit) => Promise<MatrixCall>;
  readonly activeLeases: (subject: string) => Promise<number>;
}

export interface MatrixCall {
  readonly response: Response;
  readonly text: string;
  readonly requestId: string | null;
}

export interface MatrixUpstreamPlan {
  readonly scenario: MatrixScenario;
  /** Tool requests return calls on the first invocation and text on the next. */
  readonly invocation?: number;
}

export async function setupMatrix(fixture: MatrixFixture, upstream: MatrixUpstream, downstream: Protocol = 'chat'): Promise<MatrixHarness> {
  const suffix = fixture.id.toLowerCase().replace(/[^a-z0-9_-]/gu, '_');
  const groupId = `matrix_${suffix}_group`;
  const userId = `matrix_${suffix}_user`;
  const keyId = `matrix_${suffix}_key`;
  const channelId = `matrix_${suffix}_${upstream}`;
  const token = generateToken('apiKey');
  const encryptionKey = crypto.getRandomValues(new Uint8Array(32));
  const keyring = new Map<string, Uint8Array>([['matrix', encryptionKey]]);
  const encrypted = await encryptChannelSecret('PRIVATE_UPSTREAM_KEY', channelId, 'matrix', encryptionKey);
  const env = { ...testEnv, ENVIRONMENT: 'local', PUBLIC_BASE_URL: 'https://matrix-gateway.example',
    CHANNEL_KEYRING_JSON: JSON.stringify({ matrix: btoa(String.fromCharCode(...encryptionKey)) }), CHANNEL_ACTIVE_KEY_VERSION: 'matrix' } as Env;

  await prepare(testEnv.DB, `INSERT INTO groups(id,name,status,version,created_at,updated_at)
    VALUES(?,?,'active',1,0,0)`, [groupId, `Matrix ${fixture.id}`]).run();
  await prepare(testEnv.DB, `INSERT INTO users(id,email_normalized,password_hash,role,status,group_id,balance_units,concurrency_limit,rpm_limit,created_via,created_at,updated_at)
    VALUES(?,?,'matrix-test-hash','user','active',?,1000000,4,60,'admin',0,0)`, [userId, `${userId}@example.invalid`, groupId]).run();
  await prepare(testEnv.DB, `INSERT INTO api_keys(id,user_id,key_hash,display_prefix,name,status,created_at,updated_at)
    VALUES(?,?,?,'s2a_key_MATRIX01','Matrix Key','active',0,0)`, [keyId, userId, await hashToken('apiKey', token)]).run();
  const baseUrl = `https://${channelId.replace(/_/gu, '-')}.example.invalid`;
  await prepare(testEnv.DB, `INSERT INTO channels(id,name,base_url,secret_ciphertext,secret_key_version,status,priority,concurrency_limit,rpm_limit,config_version,created_at,updated_at)
    VALUES(?,?,?,?,'matrix','active',10,4,60,1,0,0)`, [channelId, `Matrix ${upstream}`, baseUrl, encrypted]).run();
  await prepare(testEnv.DB, `INSERT INTO models (public_model_id,status,sell_prices_json,price_version,admission_min_balance_units,max_output_tokens,created_at,updated_at) VALUES (?,'active','{"input":"1","output":"2"}',1,0,64,0,0)`, [fixture.publicModel]).run();
  await prepare(testEnv.DB, 'INSERT INTO channel_groups(channel_id,group_id) VALUES(?,?)', [channelId, groupId]).run();
  const features = ['streaming', 'tools', 'tool_choice', 'parallel_tools', 'parallel_tool_control', ...(upstream === 'chat' ? ['stream_usage'] : [])];
  await prepare(testEnv.DB, `INSERT INTO channel_models(channel_id,public_model_id,protocol,upstream_model,capabilities_json,config_version)
    VALUES(?,?,?,?,?,1)`, [channelId, fixture.publicModel, upstream, fixture.upstreamModel, JSON.stringify({ protocol: upstream, features, maxOutputTokens: 64 })]).run();

  const call = async (payload: unknown, headers: HeadersInit = {}): Promise<MatrixCall> => {
    const context = createExecutionContext();
    const path = downstream === 'chat' ? '/v1/chat/completions' : `/v1/${downstream}`;
    const credential = downstream === 'messages' ? { 'x-api-key': token, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${token}` };
    const response = await app.fetch(new Request(`https://matrix-gateway.example${path}`, { method: 'POST', headers: {
      'Content-Type': 'application/json', ...credential, ...headers,
    }, body: JSON.stringify(payload) }), env, context);
    const text = await response.text();
    await waitOnExecutionContext(context);
    return { response, text, requestId: response.headers.get('X-Request-Id') };
  };
  const activeLeases = (subject: string) => runInDurableObject(testEnv.GATE.get(testEnv.GATE.idFromName(subject)), (_instance, context) => new LeaseStorage(context.storage).read(Date.now()).leases.length);
  return { fixture, upstream, publicModel: fixture.publicModel, upstreamModel: fixture.upstreamModel, channelId, userId, token, keyring, call, activeLeases };
}

export function chatTextRequest(model: string, text = 'matrix text'): Record<string, unknown> {
  return { model, max_tokens: 16, messages: [{ role: 'user', content: text }] };
}

export function chatFollowupRequest(model: string, answer: string): Record<string, unknown> {
  return { model, max_tokens: 16, messages: [{ role: 'user', content: 'matrix first turn' }, { role: 'assistant', content: answer }, { role: 'user', content: 'matrix follow-up' }] };
}

export function chatToolRequest(model: string, tools: readonly MatrixTool[], stream = false): Record<string, unknown> {
  const definitions = tools.map(tool => ({ type: 'function', function: { name: tool.name, description: 'Matrix fixture tool', parameters: {
    type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false,
  }, strict: false } }));
  return { model, max_tokens: 16, messages: [{ role: 'user', content: 'matrix tool turn' }], tools: definitions,
    tool_choice: tools.length === 1 ? { type: 'function', function: { name: tools[0]!.name } } : 'required',
    ...(stream ? { stream: true, stream_options: { include_usage: false } } : {}) };
}

export function chatToolFollowupRequest(model: string, tools: readonly MatrixTool[], stream = false): Record<string, unknown> {
  return { model, max_tokens: 16, messages: [{ role: 'user', content: 'matrix tool turn' }, {
    role: 'assistant', content: null, tool_calls: tools.map(tool => ({ id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } })),
  }, ...tools.map(tool => ({ role: 'tool', tool_call_id: tool.id, content: tool.result }))],
    ...(stream ? { stream: true, stream_options: { include_usage: false } } : {}) };
}

export function mockUpstream(fixture: MatrixFixture, upstream: MatrixUpstream, plan: MatrixUpstreamPlan, stream: boolean): Response {
  const invocation = plan.invocation ?? 1;
  if (plan.scenario === 'error') return upstreamError(upstream, fixture);
  const toolScenario = plan.scenario === 'single-tool' || plan.scenario === 'parallel-tool';
  const returnTool = toolScenario && invocation === 1;
  if (!stream) return Response.json(jsonBody(fixture, upstream, returnTool ? plan.scenario : 'text', invocation));
  return sseBody(fixture, upstream, returnTool ? plan.scenario : 'text', invocation);
}

function upstreamError(upstream: MatrixUpstream, fixture: MatrixFixture): Response {
  const body = upstream === 'messages'
    ? { type: 'error', error: { type: fixture.error.code, message: fixture.error.message } }
    : { error: { type: 'server_error', code: fixture.error.code, message: fixture.error.message } };
  return Response.json(body, { status: fixture.error.status });
}

function usage(fixture: MatrixFixture, upstream: MatrixUpstream, outputTokens = fixture.usage.outputTokens): Record<string, unknown> {
  if (upstream === 'chat') return { prompt_tokens: fixture.usage.inputTokens, completion_tokens: outputTokens, total_tokens: fixture.usage.inputTokens + outputTokens };
  if (upstream === 'responses') return { input_tokens: fixture.usage.inputTokens, output_tokens: outputTokens, total_tokens: fixture.usage.inputTokens + outputTokens };
  return { input_tokens: fixture.usage.inputTokens, output_tokens: outputTokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

function jsonBody(fixture: MatrixFixture, upstream: MatrixUpstream, scenario: MatrixScenario, invocation: number): Record<string, unknown> {
  const id = `${fixture.id.toLowerCase()}_${scenario}_${invocation}`;
  const tools = scenario === 'single-tool' ? [fixture.singleTool] : scenario === 'parallel-tool' ? fixture.parallelTools : [];
  if (upstream === 'chat') return { id, object: 'chat.completion', created: 1, model: fixture.upstreamModel, choices: [{ index: 0,
    message: tools.length ? { role: 'assistant', content: null, tool_calls: tools.map(tool => ({ id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } })) } : { role: 'assistant', content: invocation > 1 ? fixture.followupAnswer : fixture.answer },
    finish_reason: tools.length ? 'tool_calls' : 'stop' }], usage: usage(fixture, upstream) };
  if (upstream === 'responses') return { id, object: 'response', created_at: 1, model: fixture.upstreamModel, status: 'completed',
    output: tools.length ? tools.map(tool => ({ id: `${id}_${tool.id}`, type: 'function_call', call_id: tool.id, name: tool.name, arguments: tool.arguments, status: 'completed' }))
      : [{ id: `${id}_message`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: invocation > 1 ? fixture.followupAnswer : fixture.answer, annotations: [] }] }], usage: usage(fixture, upstream) };
  return { id, type: 'message', role: 'assistant', model: fixture.upstreamModel,
    content: tools.length ? tools.map(tool => ({ type: 'tool_use', id: tool.id, name: tool.name, input: parseObject(tool.arguments) })) : [{ type: 'text', text: invocation > 1 ? fixture.followupAnswer : fixture.answer }],
    stop_reason: tools.length ? 'tool_use' : 'end_turn', stop_sequence: null, usage: usage(fixture, upstream) };
}

function parseObject(value: string): Record<string, unknown> {
  try { const parsed = JSON.parse(value) as unknown; return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}

function sseBody(fixture: MatrixFixture, upstream: MatrixUpstream, scenario: MatrixScenario, invocation: number): Response {
  const id = `${fixture.id.toLowerCase()}_${scenario}_${invocation}`;
  const tools = scenario === 'single-tool' ? [fixture.singleTool] : scenario === 'parallel-tool' ? fixture.parallelTools : [];
  const answer = invocation > 1 ? fixture.followupAnswer : fixture.answer;
  let events: readonly { readonly event?: string; readonly data: unknown }[];
  if (upstream === 'chat') {
    const base = { id, object: 'chat.completion.chunk', created: 1, model: fixture.upstreamModel };
    events = tools.length ? [
      { data: { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: tools.map((tool, index) => ({ index, id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } })) }, finish_reason: null }] } },
      { data: { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] } },
      { data: { ...base, choices: [], usage: usage(fixture, upstream) } }, { data: '[DONE]' },
    ] : [{ data: { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }] } },
      { data: { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } }, { data: { ...base, choices: [], usage: usage(fixture, upstream) } }, { data: '[DONE]' }];
  } else if (upstream === 'responses') {
    const response = { id, object: 'response', created_at: 1, model: fixture.upstreamModel, status: 'in_progress', output: [], usage: null };
    if (tools.length) {
      const items = tools.map(tool => ({ id: `${id}_${tool.id}`, type: 'function_call', call_id: tool.id, name: tool.name, arguments: '', status: 'in_progress' }));
      events = [{ type: 'response.created', response }, ...items.flatMap((item, index) => [
        { type: 'response.output_item.added', output_index: index, item },
        { type: 'response.function_call_arguments.delta', output_index: index, item_id: item.id, delta: tools[index]!.arguments },
        { type: 'response.function_call_arguments.done', output_index: index, item_id: item.id, arguments: tools[index]!.arguments },
        { type: 'response.output_item.done', output_index: index, item: { ...item, arguments: tools[index]!.arguments, status: 'completed' } },
      ]), { type: 'response.completed', response: { ...jsonBody(fixture, upstream, scenario, invocation) } }].map((data, sequence_number) => ({ event: data.type, data: { ...data, sequence_number } }));
    } else {
      const item = { id: `${id}_message`, type: 'message', role: 'assistant', status: 'in_progress', content: [] };
      const part = { type: 'output_text', text: '', annotations: [] };
      const completePart = { ...part, text: answer };
      events = [{ type: 'response.created', response }, { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.content_part.added', output_index: 0, item_id: item.id, content_index: 0, part },
        { type: 'response.output_text.delta', output_index: 0, item_id: item.id, content_index: 0, delta: answer },
        { type: 'response.output_text.done', output_index: 0, item_id: item.id, content_index: 0, text: answer },
        { type: 'response.content_part.done', output_index: 0, item_id: item.id, content_index: 0, part: completePart },
        { type: 'response.output_item.done', output_index: 0, item: { ...item, status: 'completed', content: [completePart] } },
        { type: 'response.completed', response: { ...jsonBody(fixture, upstream, scenario, invocation) } }].map((data, sequence_number) => ({ event: data.type, data: { ...data, sequence_number } }));
    }
  } else {
    if (tools.length) events = [{ type: 'message_start', message: { ...jsonBody(fixture, upstream, scenario, invocation), content: [], stop_reason: null, usage: usage(fixture, upstream, 0) } },
      ...tools.flatMap((tool, index) => [{ type: 'content_block_start', index, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } },
        { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: tool.arguments } }, { type: 'content_block_stop', index }]),
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: usage(fixture, upstream) }, { type: 'message_stop' }];
    else events = [{ type: 'message_start', message: { ...jsonBody(fixture, upstream, scenario, invocation), content: [], stop_reason: null, usage: usage(fixture, upstream, 0) } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } },
      { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: usage(fixture, upstream) }, { type: 'message_stop' }];
    events = events.map(data => ({ event: data.type, data }));
  }
  const encoder = new TextEncoder();
  const body = events.map(item => `${item.event ? `event: ${item.event}\n` : ''}data: ${typeof item.data === 'string' ? item.data : JSON.stringify(item.data)}\n\n`).join('');
  return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(body)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
}

export async function settledRequest(requestId: string): Promise<Record<string, unknown> | null> {
  return await prepare(testEnv.DB, 'SELECT id,execution_status,billing_status,usage_quality,cost_units,response_id FROM requests WHERE id=?', [requestId]).first() as Record<string, unknown> | null;
}

export async function billingCount(): Promise<number> {
  const row = await prepare(testEnv.DB, 'SELECT COUNT(*) AS n FROM billing_entries').first<{ n: number | string }>();
  return typeof row?.n === 'number' ? row.n : Number(row?.n ?? 0);
}
