import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixtureValue from '../../fixtures/matrix/messages-chat.json';
import {
  billingCount,
  mockUpstream,
  settledRequest,
  setupMatrix,
  type MatrixFixture,
  type MatrixHarness,
} from './helper';

const fixture = fixtureValue as MatrixFixture;
let harness: MatrixHarness;

const textRequest = (model: string, answer = 'matrix messages text', stream = false) => ({
  model, max_tokens: 16, messages: [{ role: 'user', content: answer }], ...(stream ? { stream: true } : {}),
});
const followupRequest = (model: string, answer: string) => ({
  model,
  max_tokens: 16,
  messages: [
    { role: 'user', content: 'matrix first turn' },
    { role: 'assistant', content: answer },
    { role: 'user', content: 'matrix follow-up' },
  ],
});
const toolRequest = (model: string, tools: readonly MatrixFixture['singleTool'][], stream = false) => ({
  model,
  max_tokens: 16,
  messages: [{ role: 'user', content: 'matrix tool turn' }],
  tools: tools.map(tool => ({ name: tool.name, description: 'matrix fixture tool', input_schema: {
    type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false,
  } })),
  tool_choice: tools.length === 1 ? { type: 'tool', name: tools[0]!.name } : { type: 'any' },
  ...(stream ? { stream: true } : {}),
});
const toolFollowupRequest = (model: string, tools: readonly MatrixFixture['singleTool'][], stream = false) => ({
  model,
  max_tokens: 16,
  messages: [
    { role: 'user', content: 'matrix tool turn' },
    { role: 'assistant', content: tools.map(tool => ({ type: 'tool_use', id: tool.id, name: tool.name, input: JSON.parse(tool.arguments) })) },
    { role: 'user', content: tools.map(tool => ({ type: 'tool_result', tool_use_id: tool.id, content: tool.result })) },
  ], ...(stream ? { stream: true } : {}),
});

function upstreamMock(scenario: 'text' | 'single-tool' | 'parallel-tool' | 'error', stream: boolean) {
  let invocation = 0;
  const upstream = vi.fn(async (url: string, init: RequestInit) => {
    invocation += 1;
    const headers = new Headers(init.headers);
    expect(url).toContain('/v1/chat/completions');
    expect(headers.get('Authorization')).toBe('Bearer PRIVATE_UPSTREAM_KEY');
    expect(headers.get('x-api-key')).toBeNull();
    expect(JSON.stringify(init.headers)).not.toContain(harness.token);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe(harness.upstreamModel);
    expect(body.stream).toBe(stream);
    return mockUpstream(fixture, 'chat', { scenario, invocation }, stream);
  });
  vi.stubGlobal('fetch', upstream);
  return upstream;
}

beforeEach(async () => {
  harness = await setupMatrix(fixture, 'chat', 'messages');
});

describe('Q-MC Messages downstream → Chat upstream', () => {
  it.each([false, true])('runs text through the real Worker JSON/SSE path (%s)', async stream => {
    const upstream = upstreamMock('text', stream);
    const result = await harness.call(textRequest(harness.publicModel, 'matrix messages text', stream));
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get('Cache-Control')).toBe('no-store');
    expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.text).toContain(fixture.answer);
    if (stream) {
      expect(result.response.headers.get('Content-Type')).toMatch(/text\/event-stream/);
      expect(result.text).toContain('message_start');
      expect(result.text).toContain('message_stop');
    } else {
      expect(JSON.parse(result.text)).toMatchObject({ type: 'message', role: 'assistant', stop_reason: 'end_turn', model: harness.publicModel });
    }
    expect(upstream).toHaveBeenCalledOnce();
    const state = await settledRequest(result.requestId!);
    expect(state).toMatchObject({ execution_status: 'succeeded', billing_status: 'settled', usage_quality: 'complete', cost_units: 2_000 });
    expect(await billingCount()).toBe(1);
    expect(await harness.activeLeases(`user:${harness.userId}`)).toBe(0);
    expect(await harness.activeLeases(`channel:${harness.channelId}`)).toBe(0);
  });

  it('preserves complete text history over two JSON turns and settles each request once', async () => {
    const upstream = upstreamMock('text', false);
    const first = await harness.call(textRequest(harness.publicModel));
    expect(first.response.status).toBe(200); expect(first.text).toContain(fixture.answer);
    const second = await harness.call(followupRequest(harness.publicModel, fixture.answer));
    expect(second.response.status).toBe(200); expect(second.text).toContain(fixture.followupAnswer);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(await settledRequest(first.requestId!)).toMatchObject({ billing_status: 'settled', cost_units: 2_000 });
    expect(await settledRequest(second.requestId!)).toMatchObject({ billing_status: 'settled', cost_units: 2_000 });
    expect(await billingCount()).toBe(2);
  });

  it.each([
    ['single-tool', [fixture.singleTool]],
    ['parallel-tool', fixture.parallelTools],
  ] as const)('round-trips %s calls and tool results through Messages JSON', async (_scenario, tools) => {
    const upstream = upstreamMock(_scenario, false);
    const first = await harness.call(toolRequest(harness.publicModel, tools));
    expect(first.response.status).toBe(200);
    const firstBody = JSON.parse(first.text) as Record<string, unknown>;
    expect(firstBody).toMatchObject({ type: 'message', stop_reason: 'tool_use' });
    const content = firstBody.content as readonly Record<string, unknown>[];
    expect(content.filter(item => item.type === 'tool_use')).toHaveLength(tools.length);
    for (const tool of tools) expect(content).toContainEqual(expect.objectContaining({ type: 'tool_use', id: tool.id, name: tool.name }));
    const second = await harness.call(toolFollowupRequest(harness.publicModel, tools));
    expect(second.response.status).toBe(200); expect(second.text).toContain(fixture.followupAnswer);
    expect(upstream).toHaveBeenCalledTimes(2);
    const forwarded = JSON.parse(upstream.mock.calls[1]![1].body as string) as { messages: readonly Record<string, unknown>[] };
    const assistant = forwarded.messages.find(message => message.role === 'assistant');
    expect(assistant?.content).toBeNull();
    const calls = assistant?.tool_calls as readonly Record<string, unknown>[];
    for (const tool of tools) expect(calls).toContainEqual(expect.objectContaining({ id: tool.id,
      function: { name: tool.name, arguments: tool.arguments } }));
    for (const tool of tools) expect(forwarded.messages).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: tool.id, content: tool.result }));
    expect(await billingCount()).toBe(2);
    expect(await settledRequest(first.requestId!)).toMatchObject({ billing_status: 'settled', usage_quality: 'complete' });
    expect(await settledRequest(second.requestId!)).toMatchObject({ billing_status: 'settled', usage_quality: 'complete' });
  });

  it.each([
    ['single-tool', [fixture.singleTool]],
    ['parallel-tool', fixture.parallelTools],
  ] as const)('streams %s tool output and continues with tool results', async (scenario, tools) => {
    const upstream = upstreamMock(scenario, true);
    const result = await harness.call(toolRequest(harness.publicModel, tools, true));
    expect(result.response.status).toBe(200);
    for (const tool of tools) expect(result.text).toContain(tool.id);
    expect(result.text).toContain('message_stop');
    const followup = await harness.call(toolFollowupRequest(harness.publicModel, tools, true));
    expect(followup.response.status).toBe(200); expect(followup.text).toContain(fixture.followupAnswer); expect(followup.text).toContain('message_stop');
    expect(upstream).toHaveBeenCalledTimes(2);
    const forwarded = JSON.parse(upstream.mock.calls[1]![1].body as string) as { messages: readonly Record<string, unknown>[] };
    const assistant = forwarded.messages.find(message => message.role === 'assistant');
    const calls = assistant?.tool_calls as readonly Record<string, unknown>[];
    for (const tool of tools) expect(calls).toContainEqual(expect.objectContaining({ id: tool.id, function: { name: tool.name, arguments: tool.arguments } }));
    for (const tool of tools) expect(forwarded.messages).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: tool.id, content: tool.result }));
    expect(await settledRequest(result.requestId!)).toMatchObject({ billing_status: 'settled', usage_quality: 'complete', cost_units: 2_000 });
    expect(await settledRequest(followup.requestId!)).toMatchObject({ billing_status: 'settled', usage_quality: 'complete', cost_units: 2_000 });
    expect(await billingCount()).toBe(2);
  });

  it.each([false, true])('returns a sanitized upstream error for JSON/SSE mode (%s) without a zero-cost bill', async stream => {
    const upstream = upstreamMock('error', stream);
    const result = await harness.call(textRequest(harness.publicModel, 'matrix messages text', stream));
    expect(result.response.status).toBe(502);
    expect(result.text).toContain('error');
    expect(result.text).not.toContain(fixture.error.message);
    expect(result.text).not.toContain(fixture.error.code);
    expect(upstream).toHaveBeenCalledOnce();
    expect(await settledRequest(result.requestId!)).toMatchObject({ execution_status: 'failed', billing_status: 'usage_unknown', cost_units: null });
    expect(await billingCount()).toBe(0);
  });
});
