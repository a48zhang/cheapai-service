/** SPDX-License-Identifier: LGPL-3.0-only
 * Independent synthetic fixtures for the direct Chat -> Responses stream
 * adapter. Behavioral reference and fixed upstream attribution are recorded
 * in the implementation file and docs/protocol-baseline.md.
 */
import { describe, expect, it } from 'vitest';
import { createChatToResponsesSession, streamChatToResponses } from '../../../packages/apicompat/streams/chat-to-responses.js';
import { createResponsesStreamSession } from '../../../packages/apicompat/passthrough/responses-stream.js';
import type { ResponseContext, StreamOptions } from '../../../packages/apicompat/types/adapter.js';
import { SseByteParser } from '../../../packages/apicompat/streams/parser.js';

const context: ResponseContext = { targetModel: 'public', identity: { responseId: 'resp_public', upstreamResponseId: 'chat_native' }, createdAt: 123,
  idFor: (_kind, key) => 'item_' + key.replaceAll(':', '_') };
const options: StreamOptions = { unknownEventPolicy: 'reject', maxBufferedBytes: 8192 };
const source = (delta: object, finish_reason: string | null = null, usage?: object) => ({ data: JSON.stringify({
  id: 'chat_native', object: 'chat.completion.chunk', model: 'native-model', created: 12,
  choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
}) });
function session(config = options) { const result = createChatToResponsesSession(context, config); if (!result.ok) throw new Error('Invalid fixture'); return result.value; }

describe('CR-S1 text lifecycle', () => {
  it('emits text before DONE, with correct Responses IDs, indices and completion order', () => {
    const stream = session(); const frames = [];
    const first = stream.push(source({ role: 'assistant', content: '你好' }));
    expect(first.events.map(item => item.event)).toEqual(['response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added', 'response.output_text.delta']);
    expect(first.terminal).toBeUndefined(); frames.push(...first.events);
    frames.push(...stream.push(source({ content: '🧭' })).events);
    expect(stream.push(source({}, 'stop')).terminal).toBeUndefined();
    const final = stream.push({ data: '[DONE]' }); frames.push(...final.events);
    expect(final.events.map(item => item.event)).toEqual(['response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.completed']);
    expect(final.terminal).toMatchObject({ status: 'completed', reason: 'stop' });
    const target = createResponsesStreamSession({ ...context, identity: { responseId: 'resp_public', upstreamResponseId: 'resp_public' } }, options);
    if (!target.ok) throw new Error('Target config');
    for (const item of frames) expect(target.value.push(item).terminal?.status).not.toBe('failed');
    const response = JSON.parse(final.events.at(-1)!.data).response;
    expect(response).toMatchObject({ id: 'resp_public', model: 'public', created_at: 123, output: [{ id: 'item_message_0', content: [{ text: '你好🧭' }] }] });
    expect(response).not.toHaveProperty('usage');
    expect(stream.push({ data: '[DONE]' })).toEqual({ events: [], usageUpdates: [] });
  });
  it('does not allocate an item for empty text and does not complete on EOF', () => {
    const empty = session(); empty.push(source({ content: '' }, 'stop'));
    expect(JSON.parse(empty.push({ data: '[DONE]' }).events[0]!.data).response.output).toEqual([]);
    const eof = session(); eof.push(source({ content: 'partial' }));
    expect(eof.finish({ kind: 'eof' }).terminal).toEqual({ status: 'incomplete', reason: 'unexpected_eof' });
  });
  it('preserves mapped reasoning as a Responses summary item', () => {
    const stream = session();
    const first = stream.push(source({ reasoning_content: 'thought' }));
    expect(first.events.map(event => event.event)).toEqual(['response.created', 'response.in_progress', 'response.output_item.added', 'response.reasoning_summary_part.added', 'response.reasoning_summary_text.delta']);
    const end = stream.push(source({}, 'stop')); // finish the otherwise reasoning-only turn
    expect(end.terminal).toBeUndefined();
    const done = stream.push({ data: '[DONE]' });
    expect(done.terminal).toMatchObject({ status: 'completed' });
    expect(JSON.parse(done.events.at(-1)!.data).response.output).toEqual([{ type: 'reasoning', id: 'item_reasoning_0', status: 'completed', summary: [{ type: 'summary_text', text: 'thought' }] }]);
  });
  it('produces a stream accepted by the native Responses lifecycle validator', () => {
    const stream = session(); const output = [];
    output.push(...stream.push(source({ reasoning_content: 'consider', content: 'answer' })).events);
    output.push(...stream.push(source({}, 'stop')).events);
    output.push(...stream.push({ data: '[DONE]' }).events);
    const target = createResponsesStreamSession({ ...context, identity: { responseId: 'resp_public', upstreamResponseId: 'resp_public' } }, options);
    if (!target.ok) throw new Error('Target configuration');
    for (const event of output) expect(target.value.push(event).terminal?.status).not.toBe('failed');
  });
  it('retains observed partial usage without completing and enforces buffer limits', () => {
    expect(session().push(source({ content: 'x' }, null, { prompt_tokens: 1 })).usageUpdates).toMatchObject([{ counts: { inputTokens: 1 }, mode: 'cumulative' }]);
    expect(session({ ...options, maxBufferedBytes: 300 }).push(source({ content: 'x'.repeat(250) })).terminal?.status).toBe('failed');
  });
  it('emits actual SSE incrementally under byte splitting', async () => {
    const values = [source({ content: '你好' }).data, source({}, 'stop').data, '[DONE]'];
    const bytes = new TextEncoder().encode(values.map(data => `data: ${data}\n\n`).join('')); let offset = 0;
    const input = new ReadableStream<Uint8Array>({ pull(c) { if (offset < bytes.length) c.enqueue(bytes.subarray(offset, ++offset)); else c.close(); } }, { highWaterMark: 0 });
    const parser = new SseByteParser(); const types = [];
    for await (const result of streamChatToResponses(input, context, options)) types.push(...parser.push(result.bytes).map(frame => frame.event));
    expect(types).toContain('response.output_text.delta'); expect(types.at(-1)).toBe('response.completed');
  });
});

describe('CR-S5 upstream usage and single final evidence', () => {
  const usageOnly = (usage: object) => ({ data: JSON.stringify({ id: 'chat_native', object: 'chat.completion.chunk', model: 'native', created: 12, choices: [], usage }) });
  it('keeps cumulative updates separate and maps only final known counters into Responses', () => {
    const stream = session();
    const first = stream.push(source({ content: 'x' }, null, { prompt_tokens: 4, completion_tokens: 1 }));
    expect(first.usageUpdates[0]?.counts.outputTokens).toBe(1);
    stream.push(source({}, 'stop'));
    const finalUsage = { prompt_tokens: 4, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } };
    const observed = stream.push(usageOnly(finalUsage));
    expect(observed.events).toEqual([]); expect(observed.usageUpdates).toMatchObject([{ final: true, counts: { outputTokens: 3 }, mode: 'cumulative' }]);
    expect(stream.push(usageOnly(finalUsage)).usageUpdates).toEqual([]);
    const final = stream.push({ data: '[DONE]' });
    expect(final.usage).toMatchObject({ protocol: 'chat', quality: 'complete', counts: { inputTokens: 4, outputTokens: 3 } });
    expect(JSON.parse(final.events.at(-1)!.data).response.usage).toEqual({ input_tokens: 4, output_tokens: 3, total_tokens: 7,
      input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } });
    expect(stream.finish({ kind: 'eof' })).toEqual({ events: [], usageUpdates: [] });
  });
  it('never fills unknown counters with zero or blesses regressed evidence', () => {
    const missing = session(); missing.push(source({ content: 'x' }, 'stop'));
    const final = missing.push({ data: '[DONE]' });
    expect(final.usage).toMatchObject({ quality: 'missing' }); expect(JSON.parse(final.events.at(-1)!.data).response).not.toHaveProperty('usage');
    const bad = session(); bad.push(source({ content: 'x' }, 'stop', { prompt_tokens: 4, completion_tokens: 3 }));
    bad.push(usageOnly({ prompt_tokens: 4, completion_tokens: 2 }));
    const invalid = bad.push({ data: '[DONE]' });
    expect(invalid.usage).toMatchObject({ quality: 'invalid' }); expect(JSON.parse(invalid.events.at(-1)!.data).response).not.toHaveProperty('usage');
  });
  it('retains final usage evidence on EOF without converting missing DONE to success', () => {
    const stream = session(); stream.push(source({}, 'stop')); stream.push(usageOnly({ prompt_tokens: 1, completion_tokens: 2 }));
    const eof = stream.finish({ kind: 'eof' });
    expect(eof).toMatchObject({ terminal: { status: 'incomplete', reason: 'unexpected_eof' }, usage: { quality: 'complete', counts: { outputTokens: 2 } } });
  });
});

describe('CR-S4 terminal distinctions', () => {
  it.each(['tool_calls', 'function_call'] as const)('rejects %s without any emitted tool call', reason => {
    const stream = session();
    stream.push(source({}, reason));
    const done = stream.push({ data: '[DONE]' });
    expect(done.terminal).toMatchObject({ status: 'failed', error: { code: 'missing_tool_call' } });
    expect(done.events.map(event => event.event)).toEqual(['error']);
  });

  it.each([['length', 'length'], ['content_filter', 'content_filter']])('maps %s to response.incomplete', (reason, terminalReason) => {
    const stream = session(); stream.push(source({ content: 'partial' }, reason));
    const step = stream.push({ data: '[DONE]' });
    expect(step.terminal).toMatchObject({ status: 'incomplete', reason: terminalReason });
    expect(step.events.at(-1)?.event).toBe('response.incomplete');
  });
  it('retains explicit refusal without inventing text or successful terminal metadata', () => {
    const stream = session(); const first = stream.push(source({ refusal: 'No' }, 'stop'));
    expect(first.events.some(event => event.event === 'response.refusal.delta')).toBe(true);
    const done = stream.push({ data: '[DONE]' });
    expect(done.terminal).toMatchObject({ status: 'incomplete', reason: 'refusal' });
    expect(JSON.parse(done.events.at(-1)!.data).response.output[0].content).toEqual([{ type: 'refusal', refusal: 'No' }]);
  });
  it('does not mark incomplete tool JSON done on length truncation', () => {
    const stream = session(); stream.push(source({ tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{' } }] }, 'length'));
    const step = stream.push({ data: '[DONE]' });
    expect(step.events.map(event => event.event)).toEqual(['response.incomplete']);
    expect(step.terminal).toMatchObject({ status: 'incomplete', reason: 'length' });
  });
  it('separates sanitized upstream errors, unexpected EOF and silent cancellation', () => {
    const failed = session().push({ data: JSON.stringify({ error: { message: 'SECRET', code: 'PRIVATE' } }) });
    expect(failed.terminal).toMatchObject({ status: 'failed', error: { kind: 'upstream_error' } });
    expect(JSON.stringify(failed)).not.toContain('SECRET');
    expect(session().finish({ kind: 'eof' }).terminal).toEqual({ status: 'incomplete', reason: 'unexpected_eof' });
    const cancelled = session();
    expect(cancelled.finish({ kind: 'cancelled' })).toMatchObject({ events: [], terminal: { status: 'cancelled' } });
    expect(cancelled.finish({ kind: 'cancelled' }).terminal).toBeUndefined();
  });
});

describe('CR-S2 single tool fragments', () => {
  it('emits split arguments immediately with one item ID and completes valid JSON once', () => {
    const stream = session();
    const first = stream.push(source({ tool_calls: [{ index: 7, id: 'call_native', function: { name: 'lookup', arguments: '{"q":' } }] }));
    expect(first.events.map(event => event.event)).toContain('response.function_call_arguments.delta');
    const second = stream.push(source({ tool_calls: [{ index: 7, function: { arguments: '"中"}' } }] }, 'tool_calls'));
    expect(JSON.parse(second.events[0]!.data)).toMatchObject({ item_id: 'item_tool_7', output_index: 0, delta: '"中"}' });
    const final = stream.push({ data: '[DONE]' });
    expect(final.terminal).toMatchObject({ status: 'completed', reason: 'tool_calls' });
    expect(JSON.parse(final.events.at(-1)!.data).response.output).toEqual([{ type: 'function_call', id: 'item_tool_7', call_id: 'call_native', name: 'lookup', arguments: '{"q":"中"}', status: 'completed' }]);
    expect(stream.push({ data: '[DONE]' }).events).toEqual([]);
  });
  it('bounds fragments arriving before ID/name and flushes only after identity is known', () => {
    const stream = session();
    expect(stream.push(source({ tool_calls: [{ index: 0, function: { arguments: '{"x":' } }] })).events.map(event => event.event))
      .toEqual(['response.created', 'response.in_progress']);
    const ready = stream.push(source({ tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '1}' } }] }, 'tool_calls'));
    expect(ready.events.map(event => event.event)).toEqual(['response.output_item.added', 'response.function_call_arguments.delta']);
    expect(JSON.parse(ready.events[1]!.data).delta).toBe('{"x":1}');
  });
  it('rejects malformed completed arguments', () => {
    const malformed = session(); malformed.push(source({ tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{' } }] }, 'tool_calls'));
    expect(malformed.push({ data: '[DONE]' }).terminal?.status).toBe('failed');
  });
});

describe('CR-S3 parallel tools and empty text', () => {
  it.each([[0, 1, 0, 1], [1, 0, 1, 0]].map(order => ({ order })))('keeps arbitrary tool interleaving associated %#', ({ order }) => {
    const stream = session(); const seen = new Set<number>(); const frames = [];
    for (const index of order) {
      const first = !seen.has(index); seen.add(index);
      frames.push(...stream.push(source({ content: '', tool_calls: [{ index,
        ...(first ? { id: `call_${index}` } : {}), function: { ...(first ? { name: `f${index}` } : {}), arguments: first ? '{"v":' : `${index}}` } }] })).events);
    }
    stream.push(source({ content: '' }, 'tool_calls'));
    const done = stream.push({ data: '[DONE]' }); frames.push(...done.events);
    const output = JSON.parse(done.events.at(-1)!.data).response.output;
    expect(output).toHaveLength(2);
    for (const index of [0, 1]) expect(output.find((item: { call_id: string }) => item.call_id === `call_${index}`)).toMatchObject({ id: `item_tool_${index}`, arguments: `{"v":${index}}` });
    const target = createResponsesStreamSession({ ...context, identity: { responseId: 'resp_public', upstreamResponseId: 'resp_public' } }, options);
    if (!target.ok) throw new Error('Target configuration');
    for (const frame of frames) expect(target.value.push(frame).terminal?.status).not.toBe('failed');
    expect(frames.filter(frame => frame.event === 'response.output_item.done')).toHaveLength(2);
    expect(stream.push({ data: '[DONE]' }).events).toEqual([]);
  });
  it('text appearing between tools gets its own stable output index', () => {
    const stream = session();
    stream.push(source({ tool_calls: [{ index: 0, id: 'a', function: { name: 'f', arguments: '{}' } }] }));
    stream.push(source({ content: 'explain' }));
    stream.push(source({ content: '', tool_calls: [{ index: 1, id: 'b', function: { name: 'g', arguments: '{}' } }] }, 'tool_calls'));
    const output = JSON.parse(stream.push({ data: '[DONE]' }).events.at(-1)!.data).response.output;
    expect(output.map((item: { type: string }) => item.type)).toEqual(['function_call', 'message', 'function_call']);
  });
});

describe('CR-S6 mapped reasoning, extensions and source policy', () => {
  it('accepts equal reasoning aliases once and preserves their incremental text', () => {
    const stream = session();
    const first = stream.push(source({ reasoning_content: 'a', reasoning: 'a' }));
    const second = stream.push(source({ reasoning: 'b' }, 'stop'));
    const delta = [...first.events, ...second.events].find(event => event.event === 'response.reasoning_summary_text.delta');
    expect(delta).toBeDefined();
    const deltas = [...first.events, ...second.events].filter(event => event.event === 'response.reasoning_summary_text.delta')
      .map(event => JSON.parse(event.data).delta).join('');
    expect(deltas).toBe('ab');
    const done = stream.push({ data: '[DONE]' });
    expect(JSON.parse(done.events.at(-1)!.data).response.output[0]).toMatchObject({ type: 'reasoning', summary: [{ text: 'ab' }] });
  });

  it('rejects conflicting aliases without downgrading either to answer text', () => {
    const stream = session();
    const failed = stream.push(source({ reasoning_content: 'private-a', reasoning: 'private-b' }));
    expect(failed.terminal).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(failed.events)).not.toContain('private-a');
    expect(JSON.stringify(failed.events)).not.toContain('private-b');
  });

  it('accepts standard service metadata and keeps it on the terminal Responses body', () => {
    const stream = session();
    const first = source({ content: 'ok' });
    const parsed = JSON.parse(first.data) as Record<string, unknown>;
    parsed.service_tier = 'default'; parsed.system_fingerprint = 'fp_synthetic';
    stream.push({ data: JSON.stringify(parsed) });
    stream.push(source({}, 'stop'));
    const done = stream.push({ data: '[DONE]' });
    expect(JSON.parse(done.events.at(-1)!.data).response).toMatchObject({ service_tier: 'default' });
    expect(JSON.stringify(done.events)).not.toContain('fp_synthetic');
  });

  it('applies unknown source event policy without forwarding an unsafe event', () => {
    const ignored = session({ ...options, unknownEventPolicy: 'ignore' });
    expect(ignored.push({ event: 'ping', data: 'keep-alive' })).toEqual({ events: [], usageUpdates: [] });
    const rejected = session({ ...options, unknownEventPolicy: 'preserve' }).push({ event: 'ping', data: 'keep-alive' });
    expect(rejected.terminal).toMatchObject({ status: 'failed' });
  });
});
