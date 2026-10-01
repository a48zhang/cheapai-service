import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixtureValue from '../../fixtures/matrix/chat-messages.json';
import type { MatrixFixture, MatrixHarness, MatrixScenario, UpstreamFetch } from './helper';
import { billingCount, chatFollowupRequest, chatTextRequest, chatToolFollowupRequest, chatToolRequest, mockUpstream, settledRequest, setupMatrix } from './helper';

const fixture = fixtureValue as unknown as MatrixFixture;
let harness: MatrixHarness;

beforeEach(async () => { harness = await setupMatrix(fixture, 'messages', 'chat'); });

function provider(scenario: MatrixScenario, stream: boolean) {
  let invocation = 0;
  const upstream = vi.fn(async (url: string, init: RequestInit) => {
    invocation += 1;
    expect(url).toContain('/matrix-q-cm-messages.example.invalid/v1/messages');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe(harness.upstreamModel);
    expect(body.stream).toBe(stream);
    expect(body).not.toHaveProperty('stream_options');
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

describe('Q-CM Chat downstream → Messages upstream', () => {
  it('runs ordinary JSON through the real Worker route and settles once', async () => {
    const upstream = provider('text', false);
    const call = await harness.call(chatTextRequest(harness.publicModel));
    expect(call.response.status).toBe(200);
    expect(JSON.parse(call.text)).toMatchObject({ object: 'chat.completion', model: harness.publicModel, choices: [{ message: { content: fixture.answer } }] });
    expect(call.text).not.toContain('PRIVATE_UPSTREAM_KEY');
    expect(upstream).toHaveBeenCalledTimes(1);
    await assertSettled(call.requestId, 1);
  });

  it('runs Messages SSE through the Worker route and keeps original usage for billing', async () => {
    const upstream = provider('text', true);
    const call = await harness.call({ ...chatTextRequest(harness.publicModel), stream: true });
    expect(call.response.status).toBe(200);
    expect(call.response.headers.get('content-type')).toContain('text/event-stream');
    expect(call.text).toContain(fixture.answer);
    expect(call.text).toContain('[DONE]');
    expect(upstream).toHaveBeenCalledTimes(1);
    await assertSettled(call.requestId, 1);
  });

  it('preserves a complete text history across two JSON turns', async () => {
    const upstream = provider('text', false);
    const first = await harness.call(chatTextRequest(harness.publicModel, 'matrix first turn'));
    expect(first.response.status).toBe(200);
    await assertSettled(first.requestId, 1);
    const second = await harness.call(chatFollowupRequest(harness.publicModel, fixture.answer));
    expect(second.response.status).toBe(200);
    expect(JSON.parse(second.text)).toMatchObject({ choices: [{ message: { content: fixture.followupAnswer } }] });
    const sent = JSON.parse((upstream.mock.calls[1]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(sent.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', content: [{ type: 'text', text: fixture.answer }] }),
      expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'matrix follow-up' }] }),
    ]));
    await assertSettled(second.requestId, 2);
  });

  it.each([false, true])('round-trips a single Messages tool call over stream=%s without duplicate billing', async stream => {
    const upstream = provider('single-tool', stream);
    const first = await harness.call(chatToolRequest(harness.publicModel, [fixture.singleTool], stream));
    expect(first.response.status).toBe(200);
    expect(first.text).toContain(fixture.singleTool.id);
    await assertSettled(first.requestId, 1);
    const second = await harness.call(chatToolFollowupRequest(harness.publicModel, [fixture.singleTool], stream));
    expect(second.response.status).toBe(200);
    expect(second.text).toContain(fixture.followupAnswer);
    const sent = JSON.parse((upstream.mock.calls[1]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(sent.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', content: [{ type: 'tool_use', id: fixture.singleTool.id, name: fixture.singleTool.name, input: { q: 'single' } }] }),
      expect.objectContaining({ role: 'user', content: [{ type: 'tool_result', tool_use_id: fixture.singleTool.id, content: fixture.singleTool.result }] }),
    ]));
    await assertSettled(second.requestId, 2);
  });

  it.each([false, true])('round-trips parallel Messages tools over stream=%s with IDs and results intact', async stream => {
    const upstream = provider('parallel-tool', stream);
    const first = await harness.call(chatToolRequest(harness.publicModel, fixture.parallelTools, stream));
    expect(first.response.status).toBe(200);
    for (const tool of fixture.parallelTools) expect(first.text).toContain(tool.id);
    await assertSettled(first.requestId, 1);
    const second = await harness.call(chatToolFollowupRequest(harness.publicModel, fixture.parallelTools, stream));
    expect(second.response.status).toBe(200);
    expect(second.text).toContain(fixture.followupAnswer);
    const sent = JSON.parse((upstream.mock.calls[1]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(sent.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', content: fixture.parallelTools.map(tool => ({ type: 'tool_use', id: tool.id, name: tool.name, input: { q: tool.id.endsWith('_a') ? 'a' : 'b' } })) }),
      expect.objectContaining({ role: 'user', content: fixture.parallelTools.map(tool => ({ type: 'tool_result', tool_use_id: tool.id, content: tool.result })) }),
    ]));
    await assertSettled(second.requestId, 2);
  });

  it.each([false, true])('maps upstream Messages errors safely for stream=%s without billing', async stream => {
    const upstream = provider('error', stream);
    const call = await harness.call({ ...chatTextRequest(harness.publicModel), ...(stream ? { stream: true } : {}) });
    expect(call.response.status).toBeGreaterThanOrEqual(500);
    expect(call.text).not.toContain(fixture.error.message);
    expect(call.text).not.toContain('PRIVATE_UPSTREAM_KEY');
    expect(await billingCount()).toBe(0);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
