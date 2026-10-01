import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixtureValue from '../../fixtures/matrix/responses-messages.json';
import type { MatrixFixture, MatrixHarness, MatrixScenario, UpstreamFetch } from './helper';
import { billingCount, mockUpstream, settledRequest, setupMatrix } from './helper';

const fixture = fixtureValue as unknown as MatrixFixture;
let harness: MatrixHarness;

beforeEach(async () => { harness = await setupMatrix(fixture, 'messages', 'responses'); });

function responseTextRequest(text = 'matrix text', stream = false): Record<string, unknown> {
  return { model: harness.publicModel, input: text, max_output_tokens: 16, ...(stream ? { stream: true } : {}) };
}
function responseFollowupRequest(answer: string, stream = false): Record<string, unknown> {
  return { model: harness.publicModel, input: [
    { role: 'user', content: 'matrix first turn' }, { role: 'assistant', content: answer }, { role: 'user', content: 'matrix follow-up' },
  ], max_output_tokens: 16, ...(stream ? { stream: true } : {}) };
}
function responseToolRequest(tools: readonly MatrixFixture['singleTool'][], stream = false): Record<string, unknown> {
  return { model: harness.publicModel, input: 'matrix tool turn', max_output_tokens: 16,
    tools: tools.map(tool => ({ type: 'function', name: tool.name, description: 'Matrix fixture tool', parameters: {
      type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false,
    }, strict: false })), tool_choice: tools.length === 1 ? { type: 'function', name: tools[0]!.name } : 'required',
    ...(tools.length > 1 ? { parallel_tool_calls: true } : {}), ...(stream ? { stream: true } : {}) };
}
function responseToolFollowupRequest(tools: readonly MatrixFixture['singleTool'][], stream = false): Record<string, unknown> {
  return { model: harness.publicModel, input: [
    { role: 'user', content: 'matrix tool turn' },
    ...tools.map(tool => ({ type: 'function_call', call_id: tool.id, name: tool.name, arguments: tool.arguments })),
    ...tools.map(tool => ({ type: 'function_call_output', call_id: tool.id, output: tool.result })),
  ], max_output_tokens: 16, ...(stream ? { stream: true } : {}) };
}

function provider(scenario: MatrixScenario, stream: boolean) {
  let invocation = 0;
  const upstream = vi.fn(async (url: string, init: RequestInit) => {
    invocation += 1;
    expect(url).toContain(`matrix-q-rm-messages.example.invalid/v1/messages`);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe(harness.upstreamModel);
    expect(body.stream).toBe(stream);
    expect(body.max_tokens).toBe(16);
    expect(new Headers(init.headers).get('x-api-key')).toContain('PRIVATE_UPSTREAM_KEY');
    expect(JSON.stringify([...new Headers(init.headers).entries()])).not.toContain(harness.token);
    return mockUpstream(fixture, 'messages', { scenario, invocation }, stream);
  }) as unknown as UpstreamFetch & { mock: { calls: unknown[][] } };
  vi.stubGlobal('fetch', upstream);
  return upstream;
}

async function assertSettled(requestId: string | null, expectedEntries: number): Promise<void> {
  expect(requestId).toBeTruthy();
  expect(await settledRequest(requestId!)).toMatchObject({ execution_status: 'succeeded', billing_status: 'settled', usage_quality: 'complete', cost_units: 1300 });
  expect(await billingCount()).toBe(expectedEntries);
  expect(await harness.activeLeases(`user:${harness.userId}`)).toBe(0);
}

describe('Q-RM Responses downstream -> Messages upstream', () => {
  it('runs Responses JSON through direct request/response conversion and settles once', async () => {
    const upstream = provider('text', false);
    const call = await harness.call(responseTextRequest());
    expect(call.response.status).toBe(200);
    expect(JSON.parse(call.text)).toMatchObject({ object: 'response', model: harness.publicModel, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: fixture.answer }] }], usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } });
    expect(call.text).not.toContain('PRIVATE_UPSTREAM_KEY');
    expect(upstream).toHaveBeenCalledTimes(1);
    await assertSettled(call.requestId, 1);
  });

  it('runs Responses SSE through Messages and settles original usage once', async () => {
    const upstream = provider('text', true);
    const call = await harness.call(responseTextRequest('matrix stream', true));
    expect(call.response.status).toBe(200);
    expect(call.response.headers.get('content-type')).toContain('text/event-stream');
    expect(call.text).toContain(fixture.answer);
    expect(call.text).toContain('response.completed');
    expect(upstream).toHaveBeenCalledTimes(1);
    await assertSettled(call.requestId, 1);
  });

  it('preserves complete Responses text history over two JSON turns and bills each once', async () => {
    const upstream = provider('text', false);
    const first = await harness.call(responseTextRequest('matrix first turn'));
    expect(first.response.status).toBe(200);
    await assertSettled(first.requestId, 1);
    const second = await harness.call(responseFollowupRequest(fixture.answer));
    expect(second.response.status).toBe(200);
    expect(JSON.parse(second.text)).toMatchObject({ output: [{ content: [{ text: fixture.followupAnswer }] }] });
    const sent = JSON.parse((upstream.mock.calls[1]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(sent.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'matrix first turn' }] },
      { role: 'assistant', content: [{ type: 'text', text: fixture.answer }] },
      { role: 'user', content: [{ type: 'text', text: 'matrix follow-up' }] },
    ]);
    await assertSettled(second.requestId, 2);
  });

  it.each([
    ['single-tool', [fixture.singleTool]], ['parallel-tool', fixture.parallelTools],
  ].flatMap(([scenario, tools]) => [false, true].map(stream => [scenario, tools, stream] as const)) as readonly [string, readonly MatrixFixture['singleTool'][], boolean][])('round-trips %s over Responses %s with exact Messages call/result history', async (scenario, tools, stream) => {
    const upstream = provider(scenario as MatrixScenario, stream);
    const first = await harness.call(responseToolRequest(tools, stream));
    expect(first.response.status).toBe(200);
    for (const tool of tools) expect(first.text).toContain(tool.id);
    if (!stream) expect(JSON.parse(first.text)).toMatchObject({ output: tools.map(tool => expect.objectContaining({ type: 'function_call', call_id: tool.id, name: tool.name, arguments: tool.arguments })) });
    await assertSettled(first.requestId, 1);
    const second = await harness.call(responseToolFollowupRequest(tools, stream));
    expect(second.response.status).toBe(200);
    expect(second.text).toContain(fixture.followupAnswer);
    if (stream) expect(second.text).toContain('response.completed');
    const sent = JSON.parse((upstream.mock.calls[1]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(sent.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'matrix tool turn' }] },
      { role: 'assistant', content: tools.map(tool => ({ type: 'tool_use', id: tool.id, name: tool.name, input: JSON.parse(tool.arguments) })) },
      { role: 'user', content: tools.map(tool => ({ type: 'tool_result', tool_use_id: tool.id, content: tool.result })) },
    ]);
    await assertSettled(second.requestId, 2);
  });

  it.each([false, true])('maps upstream Messages HTTP errors safely for stream=%s without charging', async stream => {
    const upstream = provider('error', stream);
    const call = await harness.call(responseTextRequest('matrix error', stream));
    expect(call.response.status).toBeGreaterThanOrEqual(500);
    expect(call.text).not.toContain(fixture.error.message);
    expect(call.text).not.toContain('PRIVATE_UPSTREAM_KEY');
    expect(await billingCount()).toBe(0);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
