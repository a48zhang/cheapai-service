import { describe, expect, it } from 'vitest';
import { createResponsesToChatSession, streamResponsesToChat } from '../../../packages/apicompat/streams/responses-to-chat.js';
import { parseChatStreamChunk } from '../../../packages/apicompat/types/chat.js';
import type { ResponseContext, StreamOptions } from '../../../packages/apicompat/types/adapter.js';
import { SseByteParser } from '../../../packages/apicompat/streams/parser.js';

const context: ResponseContext = {
  targetModel: 'public-model',
  identity: { responseId: 'resp_public', upstreamResponseId: 'resp_native' },
  createdAt: 123,
  idFor: (_kind, key) => `item_${key.replaceAll(':', '_')}`,
};
const options: StreamOptions = { unknownEventPolicy: 'reject', maxBufferedBytes: 8192 };
const response = (status: string, output: readonly object[] = []) => ({
  id: 'resp_native', object: 'response', created_at: 12, model: 'provider-model', status, output,
});
const message = (id = 'msg_native', content: readonly object[] = []) => ({ type: 'message', id, role: 'assistant', status: 'in_progress', content });
const frame = (value: object, sequence: number) => ({ event: (value as { type: string }).type, data: JSON.stringify({ ...value, sequence_number: sequence }) });
const created = frame({ type: 'response.created', response: response('in_progress') }, 0);
const itemAdded = frame({ type: 'response.output_item.added', output_index: 0, item: message() }, 1);
const partAdded = frame({ type: 'response.content_part.added', output_index: 0, item_id: 'msg_native', content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }, 2);
const textDelta = (delta: string, sequence = 3) => frame({ type: 'response.output_text.delta', output_index: 0, item_id: 'msg_native', content_index: 0, delta }, sequence);
const textDone = (value: string, sequence = 4) => frame({ type: 'response.output_text.done', output_index: 0, item_id: 'msg_native', content_index: 0, text: value }, sequence);
const partDone = (value: string, sequence = 5) => frame({ type: 'response.content_part.done', output_index: 0, item_id: 'msg_native', content_index: 0, part: { type: 'output_text', text: value, annotations: [] } }, sequence);
const itemDone = (value: string, sequence = 6) => frame({ type: 'response.output_item.done', output_index: 0,
  item: { type: 'message', id: 'msg_native', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: value, annotations: [] }] } }, sequence);
const completed = (value: string, sequence = 7) => frame({ type: 'response.completed', response: { ...response('completed', [{ type: 'message', id: 'msg_native', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: value, annotations: [] }] }]) } }, sequence);

function session(config = options) {
  const result = createResponsesToChatSession(context, config);
  if (!result.ok) throw new Error('Invalid test configuration');
  return result.value;
}

describe('P-RC-S1 Responses → Chat text lifecycle', () => {
  it('emits the public assistant identity and text incrementally before completion', () => {
    const stream = session();
    expect(stream.push(created).events.map(event => JSON.parse(event.data))).toEqual([{
      id: 'resp_public', object: 'chat.completion.chunk', created: 123, model: 'public-model',
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    }]);
    expect(stream.push(itemAdded).events).toEqual([]);
    expect(stream.push(partAdded).events).toEqual([]);
    const first = stream.push(textDelta('你好'));
    expect(first.events).toHaveLength(1);
    expect(JSON.parse(first.events[0]!.data)).toMatchObject({ id: 'resp_public', model: 'public-model', choices: [{ delta: { content: '你好' }, finish_reason: null }] });
    expect(stream.push(textDone('你好')).events).toEqual([]);
    expect(stream.push(partDone('你好')).events).toEqual([]);
    expect(stream.push(itemDone('你好')).events).toEqual([]);
    const end = stream.push(completed('你好'));
    expect(end.terminal).toEqual({ status: 'completed', reason: 'stop' });
    expect(end.events.map(event => event.data === '[DONE]' ? '[DONE]' : JSON.parse(event.data).choices[0]?.finish_reason)).toEqual(['stop', '[DONE]']);
    expect(parseChatStreamChunk(JSON.parse(end.events[0]!.data)).ok).toBe(true);
    expect(stream.push(completed('你好')).events).toEqual([]);
  });

  it('keeps an empty message without inventing a text chunk', () => {
    const stream = session();
    stream.push(created);
    const end = stream.push(frame({ type: 'response.completed', response: response('completed', []) }, 1));
    expect(end.terminal).toEqual({ status: 'completed', reason: 'stop' });
    expect(end.events).toHaveLength(2);
    expect(JSON.parse(end.events[0]!.data).choices[0].delta).toEqual({});
  });

  it('does not turn an incomplete SSE source into successful output', () => {
    const stream = session();
    stream.push(created); stream.push(itemAdded); stream.push(partAdded); stream.push(textDelta('partial'));
    expect(stream.finish({ kind: 'eof' })).toMatchObject({ terminal: { status: 'incomplete', reason: 'unexpected_eof' } });
  });

  it('preserves incremental output under one-byte UTF-8/SSE splits', async () => {
    const wire = [created, itemAdded, partAdded, textDelta('你好'), textDone('你好'), partDone('你好'), itemDone('你好'), completed('你好')]
      .map(item => `event: ${item.event}\ndata: ${item.data}\n\n`).join('');
    const bytes = new TextEncoder().encode(wire); let cursor = 0;
    const source = new ReadableStream<Uint8Array>({ pull(controller) { if (cursor < bytes.length) controller.enqueue(Uint8Array.of(bytes[cursor++]!)); else controller.close(); } }, { highWaterMark: 0 });
    const parser = new SseByteParser(); const chunks: string[] = [];
    for await (const step of streamResponsesToChat(source, context, options)) chunks.push(...parser.push(step.bytes).map(event => event.data));
    expect(chunks.some(data => data.includes('"content":"你好"'))).toBe(true);
    expect(chunks.at(-1)).toBe('[DONE]');
  });

  it('rejects duplicate starts and unsafe context configuration', () => {
    const stream = session(); stream.push(created);
    expect(stream.push(created).terminal?.status).toBe('failed');
    expect(createResponsesToChatSession({ ...context, targetModel: '' }, options).ok).toBe(false);
    expect(createResponsesToChatSession(context, { ...options, maxBufferedBytes: 0 }).ok).toBe(false);
  });
});

describe('P-RC-S2 Responses function-call argument fragments', () => {
  const toolAdded = (sequence = 1) => frame({ type: 'response.output_item.added', output_index: 0,
    item: { type: 'function_call', id: 'item_native_call', call_id: 'call_native', name: 'lookup', arguments: '', status: 'in_progress' } }, sequence);
  const argsDelta = (delta: string, sequence: number) => frame({ type: 'response.function_call_arguments.delta', output_index: 0,
    item_id: 'item_native_call', delta }, sequence);
  const argsDone = (argumentsText: string, sequence: number) => frame({ type: 'response.function_call_arguments.done', output_index: 0,
    item_id: 'item_native_call', arguments: argumentsText, name: 'lookup' }, sequence);
  const toolDone = (argumentsText: string, sequence: number) => frame({ type: 'response.output_item.done', output_index: 0,
    item: { type: 'function_call', id: 'item_native_call', call_id: 'call_native', name: 'lookup', arguments: argumentsText, status: 'completed' } }, sequence);

  it('forwards argument fragments as Chat tool deltas without parsing each fragment', () => {
    const stream = session(); stream.push(created);
    const start = stream.push(toolAdded());
    expect(JSON.parse(start.events[0]!.data).choices[0].delta).toEqual({
      tool_calls: [{ index: 0, id: 'call_native', type: 'function', function: { name: 'lookup', arguments: '' } }],
    });
    expect(JSON.parse(stream.push(argsDelta('{"q":', 2)).events[0]!.data).choices[0].delta.tool_calls[0]).toMatchObject({ index: 0, function: { arguments: '{"q":' } });
    expect(JSON.parse(stream.push(argsDelta('"中"}', 3)).events[0]!.data).choices[0].delta.tool_calls[0]).toMatchObject({ index: 0, function: { arguments: '"中"}' } });
    stream.push(argsDone('{"q":"中"}', 4)); stream.push(toolDone('{"q":"中"}', 5));
    const end = stream.push(frame({ type: 'response.completed', response: { ...response('completed', [{ type: 'function_call', id: 'item_native_call', call_id: 'call_native', name: 'lookup', arguments: '{"q":"中"}', status: 'completed' }]) } }, 6));
    expect(end.terminal).toEqual({ status: 'completed', reason: 'tool_calls' });
    expect(JSON.parse(end.events[0]!.data).choices[0].finish_reason).toBe('tool_calls');
  });

  it('rejects an arguments completion that changes the observed fragment stream', () => {
    const stream = session(); stream.push(created); stream.push(toolAdded()); stream.push(argsDelta('{', 2));
    expect(stream.push(argsDone('{}', 3)).terminal?.status).toBe('failed');
  });
});

describe('P-RC-S3 interleaved Responses tools', () => {
  const tool = (index: number, id: string, callId: string, name: string, sequence: number) => frame({ type: 'response.output_item.added', output_index: index,
    item: { type: 'function_call', id, call_id: callId, name, arguments: '', status: 'in_progress' } }, sequence);
  const delta = (id: string, outputIndex: number, value: string, sequence: number) => frame({ type: 'response.function_call_arguments.delta', output_index: outputIndex,
    item_id: id, delta: value }, sequence);
  const done = (outputIndex: number, id: string, callId: string, name: string, args: string, sequence: number) => frame({ type: 'response.output_item.done', output_index: outputIndex,
    item: { type: 'function_call', id, call_id: callId, name, arguments: args, status: 'completed' } }, sequence);

  it('keeps tool indexes stable when argument fragments arrive in arbitrary order', () => {
    const stream = session(); stream.push(created);
    expect(JSON.parse(stream.push(tool(0, 'item_a', 'call_a', 'first', 1)).events[0]!.data).choices[0].delta.tool_calls[0].index).toBe(0);
    expect(JSON.parse(stream.push(tool(1, 'item_b', 'call_b', 'second', 2)).events[0]!.data).choices[0].delta.tool_calls[0].index).toBe(1);
    const a = stream.push(delta('item_a', 0, '{"a":', 3));
    const b = stream.push(delta('item_b', 1, '{"b":', 4));
    expect(JSON.parse(a.events[0]!.data).choices[0].delta.tool_calls[0]).toMatchObject({ index: 0, function: { arguments: '{"a":' } });
    expect(JSON.parse(b.events[0]!.data).choices[0].delta.tool_calls[0]).toMatchObject({ index: 1, function: { arguments: '{"b":' } });
    stream.push(delta('item_b', 1, '2}', 5)); stream.push(delta('item_a', 0, '1}', 6));
    stream.push(frame({ type: 'response.function_call_arguments.done', output_index: 1, item_id: 'item_b', arguments: '{"b":2}', name: 'second' }, 7));
    stream.push(frame({ type: 'response.function_call_arguments.done', output_index: 0, item_id: 'item_a', arguments: '{"a":1}', name: 'first' }, 8));
    stream.push(done(1, 'item_b', 'call_b', 'second', '{"b":2}', 9)); stream.push(done(0, 'item_a', 'call_a', 'first', '{"a":1}', 10));
    const end = stream.push(frame({ type: 'response.completed', response: response('completed', [
      { type: 'function_call', id: 'item_a', call_id: 'call_a', name: 'first', arguments: '{"a":1}', status: 'completed' },
      { type: 'function_call', id: 'item_b', call_id: 'call_b', name: 'second', arguments: '{"b":2}', status: 'completed' },
    ]) }, 11));
    expect(end.terminal).toMatchObject({ status: 'completed', reason: 'tool_calls' });
    expect(JSON.parse(end.events[0]!.data).choices[0].finish_reason).toBe('tool_calls');
  });

  it('rejects duplicate source item identities instead of merging calls', () => {
    const stream = session(); stream.push(created); stream.push(tool(0, 'same', 'call_a', 'first', 1));
    expect(stream.push(tool(1, 'same', 'call_b', 'second', 2)).terminal?.status).toBe('failed');
  });
});

describe('P-RC-S4 Responses terminal, error and cancellation boundaries', () => {
  it.each([
    ['max_output_tokens', 'length'],
    ['content_filter', 'content_filter'],
  ] as const)('maps incomplete %s to a Chat finish without claiming success', (reason, finishReason) => {
    const stream = session(); stream.push(created);
    const result = stream.push(frame({ type: `response.incomplete`, response: { ...response('incomplete', []), incomplete_details: { reason } } }, 1));
    expect(result.terminal).toMatchObject({ status: 'incomplete', reason: finishReason });
    expect(JSON.parse(result.events[0]!.data).choices[0].finish_reason).toBe(finishReason);
    expect(result.events.at(-1)?.data).toBe('[DONE]');
  });

  it('sanitizes failed Responses events and never appends DONE after an error', () => {
    const stream = session(); stream.push(created);
    const result = stream.push(frame({ type: 'response.failed', response: { ...response('failed', []), error: { code: 'private', message: 'secret' } } }, 1));
    expect(result.terminal).toMatchObject({ status: 'failed', error: { code: 'upstream_error' } });
    expect(result.events.at(-1)?.data).not.toBe('[DONE]');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('keeps EOF and cancellation distinct and makes both idempotent', () => {
    const eof = session(); eof.push(created);
    expect(eof.finish({ kind: 'eof' })).toMatchObject({ terminal: { status: 'incomplete', reason: 'unexpected_eof' } });
    expect(eof.finish({ kind: 'eof' })).toEqual({ events: [], usageUpdates: [] });
    const cancelled = session(); cancelled.push(created);
    expect(cancelled.finish({ kind: 'cancelled' })).toMatchObject({ events: [], terminal: { status: 'cancelled' }, usageUpdates: [], usage: { quality: 'missing' } });
    expect(cancelled.finish({ kind: 'cancelled' })).toEqual({ events: [], usageUpdates: [] });
  });

  it('rejects unknown event preservation and ignores unknown events only by explicit policy', () => {
    expect(session({ ...options, unknownEventPolicy: 'ignore' }).push(frame({ type: 'vendor.future', value: 'x' }, 0))).toEqual({ events: [], usageUpdates: [] });
    expect(session({ ...options, unknownEventPolicy: 'preserve' }).push(frame({ type: 'vendor.future' }, 0)).terminal?.status).toBe('failed');
  });
});

describe('P-RC-S5 original Responses usage evidence', () => {
  it('keeps cumulative observations separate and emits one final Chat usage-only chunk', () => {
    const stream = session();
    stream.push(frame({ type: 'response.created', response: { ...response('in_progress'), usage: null } }, 0));
    stream.push(frame({ type: 'response.in_progress', response: { ...response('in_progress'), usage: { input_tokens: 4 } } }, 1));
    const final = stream.push(frame({ type: 'response.completed', response: { ...response('completed', []), usage: {
      input_tokens: 4, output_tokens: 3, total_tokens: 7,
      input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 }, output_tokens_details: { reasoning_tokens: 1 },
    } } }, 2));
    expect(final.usageUpdates).toMatchObject([{ sequence: 2, final: true, mode: 'cumulative', counts: { inputTokens: 4, outputTokens: 3 } }]);
    expect(final.usage).toMatchObject({ protocol: 'responses', quality: 'complete', counts: { inputTokens: 4, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1, reasoningTokens: 1 } });
    expect(final.events).toHaveLength(3);
    expect(JSON.parse(final.events[1]!.data)).toEqual({ id: 'resp_public', object: 'chat.completion.chunk', created: 123, model: 'public-model', choices: [],
      usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7, prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 }, completion_tokens_details: { reasoning_tokens: 1 } } });
    expect(final.events[2]!.data).toBe('[DONE]');
  });

  it('does not invent missing counters or accept regressed final evidence', () => {
    const partial = session(); partial.push(frame({ type: 'response.created', response: response('in_progress') }, 0));
    const partialEnd = partial.push(frame({ type: 'response.completed', response: { ...response('completed', []), usage: { input_tokens: 4 } } }, 1));
    expect(partialEnd.usage).toMatchObject({ quality: 'partial', counts: { inputTokens: 4 } });
    expect(partialEnd.events.filter(event => event.data !== '[DONE]').some(event => Object.hasOwn(JSON.parse(event.data), 'usage'))).toBe(false);

    const regressed = session(); regressed.push(frame({ type: 'response.created', response: response('in_progress') }, 0));
    regressed.push(frame({ type: 'response.in_progress', response: { ...response('in_progress'), usage: { input_tokens: 5, output_tokens: 1 } } }, 1));
    const end = regressed.push(frame({ type: 'response.completed', response: { ...response('completed', []), usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } }, 2));
    expect(end.usage).toMatchObject({ quality: 'invalid', issues: expect.arrayContaining(['regressed_inputTokens']) });
    expect(end.events.filter(event => event.data !== '[DONE]').some(event => Object.hasOwn(JSON.parse(event.data), 'usage'))).toBe(false);
  });
});

describe('P-RC-S6 public reasoning, refusal and safe extensions', () => {
  it('maps public reasoning summaries to Chat reasoning_content without exposing private payloads', () => {
    const stream = session(); stream.push(created);
    stream.push(frame({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'reasoning_native', summary: [], status: 'in_progress' } }, 1));
    stream.push(frame({ type: 'response.reasoning_summary_part.added', output_index: 0, item_id: 'reasoning_native', summary_index: 0, part: { type: 'summary_text', text: '' } }, 2));
    const delta = stream.push(frame({ type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'reasoning_native', summary_index: 0, delta: 'plan' }, 3));
    expect(JSON.parse(delta.events[0]!.data).choices[0].delta).toEqual({ reasoning_content: 'plan' });
    stream.push(frame({ type: 'response.reasoning_summary_text.done', output_index: 0, item_id: 'reasoning_native', summary_index: 0, text: 'plan' }, 4));
    stream.push(frame({ type: 'response.reasoning_summary_part.done', output_index: 0, item_id: 'reasoning_native', summary_index: 0, part: { type: 'summary_text', text: 'plan' } }, 5));
    stream.push(frame({ type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'reasoning_native', summary: [{ type: 'summary_text', text: 'plan' }], status: 'completed' } }, 6));
    const end = stream.push(frame({ type: 'response.completed', response: { ...response('completed', [{ type: 'reasoning', id: 'reasoning_native', summary: [{ type: 'summary_text', text: 'plan' }], status: 'completed' }]) } }, 7));
    expect(end.terminal).toMatchObject({ status: 'completed', reason: 'stop' });
    expect(JSON.parse(end.events[0]!.data).choices[0].finish_reason).toBe('stop');
    const privateStream = session(); privateStream.push(created);
    const failed = privateStream.push(frame({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'reasoning_private', summary: [], encrypted_content: 'opaque-secret', status: 'in_progress' } }, 1));
    expect(failed.terminal?.status).toBe('failed'); expect(JSON.stringify(failed)).not.toContain('opaque-secret');
  });

  it('preserves refusal in its dedicated Chat field and retains refusal terminal state', () => {
    const stream = session(); stream.push(created);
    stream.push(frame({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_refusal', role: 'assistant', status: 'in_progress', content: [] } }, 1));
    stream.push(frame({ type: 'response.content_part.added', output_index: 0, item_id: 'msg_refusal', content_index: 0, part: { type: 'refusal', refusal: '' } }, 2));
    expect(JSON.parse(stream.push(frame({ type: 'response.refusal.delta', output_index: 0, item_id: 'msg_refusal', content_index: 0, delta: 'No' }, 3)).events[0]!.data).choices[0].delta).toEqual({ refusal: 'No' });
    stream.push(frame({ type: 'response.refusal.done', output_index: 0, item_id: 'msg_refusal', content_index: 0, refusal: 'No' }, 4));
    stream.push(frame({ type: 'response.content_part.done', output_index: 0, item_id: 'msg_refusal', content_index: 0, part: { type: 'refusal', refusal: 'No' } }, 5));
    stream.push(frame({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_refusal', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'No' }] } }, 6));
    const end = stream.push(frame({ type: 'response.incomplete', response: { ...response('incomplete', [{ type: 'message', id: 'msg_refusal', role: 'assistant', status: 'incomplete', content: [{ type: 'refusal', refusal: 'No' }] }]), incomplete_details: { reason: 'refusal' } } }, 7));
    expect(end.terminal).toMatchObject({ status: 'incomplete', reason: 'refusal' });
    expect(JSON.parse(end.events[0]!.data).choices[0].finish_reason).toBe('stop');
  });
});
