import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixtureValue from '../../fixtures/matrix/chat-chat.json';
import type { MatrixFixture, MatrixHarness, MatrixScenario, UpstreamFetch } from './helper';
import { billingCount, chatFollowupRequest, chatTextRequest, chatToolFollowupRequest, chatToolRequest, mockUpstream, settledRequest, setupMatrix } from './helper';

const fixture = fixtureValue as unknown as MatrixFixture;
let harness: MatrixHarness;

beforeEach(async () => { harness = await setupMatrix(fixture, 'chat'); });

function provider(scenario: MatrixScenario, stream: boolean) {
  let invocation = 0;
  const upstream = vi.fn(async (url: string, init: RequestInit) => {
    invocation += 1;
    expect(url).toContain(`/matrix-q-cc-chat.example.invalid/v1/chat/completions`);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe(harness.upstreamModel);
    expect(body.stream).toBe(stream);
    expect(new Headers(init.headers).get('Authorization')).toContain('PRIVATE_UPSTREAM_KEY');
    expect(JSON.stringify([...new Headers(init.headers).entries()])).not.toContain(harness.token);
    return mockUpstream(fixture, 'chat', { scenario, invocation }, stream);
  }) as unknown as UpstreamFetch & { mock: { calls: unknown[][] } };
  vi.stubGlobal('fetch', upstream);
  return upstream;
}

async function assertSettled(requestId: string | null, expectedEntries: number): Promise<void> {
  expect(requestId).toBeTruthy();
  const row = await settledRequest(requestId!);
  expect(row).toMatchObject({ execution_status: 'succeeded', billing_status: 'settled', usage_quality: 'complete', cost_units: 1300 });
  expect(await billingCount()).toBe(expectedEntries);
  expect(await harness.activeLeases(`user:${harness.userId}`)).toBe(0);
}

describe('Q-CC Chat downstream → Chat upstream', () => {
  it('runs ordinary JSON through Worker routing and settles exactly once', async () => {
    const upstream = provider('text', false);
    const call = await harness.call(chatTextRequest(harness.publicModel));
    expect(call.response.status).toBe(200);
    expect(JSON.parse(call.text)).toMatchObject({ object: 'chat.completion', model: harness.publicModel, choices: [{ message: { content: fixture.answer } }] });
    expect(call.text).not.toContain('PRIVATE_UPSTREAM_KEY');
    expect(upstream).toHaveBeenCalledTimes(1);
    await assertSettled(call.requestId, 1);
  });

  it('runs Chat SSE, keeps usage for billing and emits one terminal stream', async () => {
    const upstream = provider('text', true);
    const call = await harness.call({ ...chatTextRequest(harness.publicModel), stream: true });
    expect(call.response.status).toBe(200);
    expect(call.response.headers.get('content-type')).toContain('text/event-stream');
    expect(call.text).toContain(fixture.answer);
    expect(call.text).toContain('[DONE]');
    expect(upstream).toHaveBeenCalledTimes(1);
    await assertSettled(call.requestId, 1);
  });

  it('preserves complete text history across two JSON turns and bills each request once', async () => {
    const upstream = provider('text', false);
    const first = await harness.call(chatTextRequest(harness.publicModel, 'matrix first turn'));
    expect(first.response.status).toBe(200);
    await assertSettled(first.requestId, 1);
    const second = await harness.call(chatFollowupRequest(harness.publicModel, fixture.answer));
    expect(second.response.status).toBe(200);
    expect(JSON.parse(second.text)).toMatchObject({ choices: [{ message: { content: fixture.followupAnswer } }] });
    const sent = JSON.parse((upstream.mock.calls[1]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(sent.messages).toEqual(expect.arrayContaining([{ role: 'assistant', content: fixture.answer }, { role: 'user', content: 'matrix follow-up' }]));
    await assertSettled(second.requestId, 2);
  });

  it.each([false, true])('round-trips one tool call and result over stream=%s without duplicate billing', async stream => {
    const upstream = provider('single-tool', stream);
    const first = await harness.call(chatToolRequest(harness.publicModel, [fixture.singleTool], stream));
    expect(first.response.status).toBe(200);
    if (stream) expect(first.text).toContain(fixture.singleTool.id);
    else expect(JSON.parse(first.text)).toMatchObject({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: fixture.singleTool.id, function: { name: fixture.singleTool.name } }] } }] });
    await assertSettled(first.requestId, 1);
    const second = await harness.call(chatToolFollowupRequest(harness.publicModel, [fixture.singleTool], stream));
    expect(second.response.status).toBe(200);
    if (stream) expect(second.text).toContain(fixture.followupAnswer);
    else expect(JSON.parse(second.text)).toMatchObject({ choices: [{ message: { content: fixture.followupAnswer } }] });
    const sent = JSON.parse((upstream.mock.calls[1]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(sent.messages).toEqual(expect.arrayContaining([
      { role: 'assistant', content: null, tool_calls: [{ id: fixture.singleTool.id, type: 'function', function: { name: fixture.singleTool.name, arguments: fixture.singleTool.arguments } }] },
      { role: 'tool', tool_call_id: fixture.singleTool.id, content: fixture.singleTool.result },
    ]));
    await assertSettled(second.requestId, 2);
  });

  it.each([false, true])('round-trips two parallel tool calls over stream=%s with stable IDs and one bill per request', async stream => {
    const upstream = provider('parallel-tool', stream);
    const first = await harness.call(chatToolRequest(harness.publicModel, fixture.parallelTools, stream));
    expect(first.response.status).toBe(200);
    expect(first.text).toContain(fixture.parallelTools[0]!.id);
    expect(first.text).toContain(fixture.parallelTools[1]!.id);
    await assertSettled(first.requestId, 1);
    const second = await harness.call(chatToolFollowupRequest(harness.publicModel, fixture.parallelTools, stream));
    expect(second.response.status).toBe(200);
    expect(second.text).toContain(fixture.followupAnswer);
    if (stream) expect(second.text).toContain('[DONE]');
    const sent = JSON.parse((upstream.mock.calls[1]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(sent.messages).toEqual(expect.arrayContaining([
      { role: 'assistant', content: null, tool_calls: fixture.parallelTools.map(tool => ({ id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } })) },
      ...fixture.parallelTools.map(tool => ({ role: 'tool', tool_call_id: tool.id, content: tool.result })),
    ]));
    await assertSettled(second.requestId, 2);
  });

  it.each([false, true])('maps upstream HTTP errors safely for stream=%s without charging', async stream => {
    const upstream = provider('error', stream);
    const call = await harness.call({ ...chatTextRequest(harness.publicModel), ...(stream ? { stream: true } : {}) });
    expect(call.response.status).toBeGreaterThanOrEqual(500);
    expect(call.text).not.toContain(fixture.error.message);
    expect(call.text).not.toContain('PRIVATE_UPSTREAM_KEY');
    expect(await billingCount()).toBe(0);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
