import { describe, expect, it } from 'vitest';
import { createResponsesToMessagesSession, streamResponsesToMessages } from '../../../packages/apicompat/streams/responses-to-messages.js';
import { parseMessagesStreamEvent } from '../../../packages/apicompat/types/messages.js';
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
  const result = createResponsesToMessagesSession(context, config);
  if (!result.ok) throw new Error('Invalid test configuration');
  return result.value;
}

describe('P-RM-S1 Responses → Messages text lifecycle', () => {
  it('opens one public Messages response and forwards text blocks incrementally', () => {
    const stream = session();
    const start = stream.push(created);
    expect(start.events.map(event => JSON.parse(event.data))).toEqual([{
      type: 'message_start', message: { id: 'resp_public', type: 'message', role: 'assistant', model: 'public-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    }]);
    expect(stream.push(itemAdded).events).toEqual([]);
    expect(JSON.parse(stream.push(partAdded).events[0]!.data)).toEqual({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    const delta = stream.push(textDelta('你好'));
    expect(JSON.parse(delta.events[0]!.data)).toEqual({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } });
    expect(stream.push(textDone('你好')).events).toEqual([]);
    expect(JSON.parse(stream.push(partDone('你好')).events[0]!.data)).toEqual({ type: 'content_block_stop', index: 0 });
    expect(stream.push(itemDone('你好')).events).toEqual([]);
    const end = stream.push(completed('你好'));
    expect(end.terminal).toEqual({ status: 'completed', reason: 'stop' });
    expect(end.events.map(event => JSON.parse(event.data))).toEqual([
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } },
      { type: 'message_stop' },
    ]);
    for (const event of [...start.events, ...delta.events, ...end.events]) expect(parseMessagesStreamEvent(JSON.parse(event.data)).ok).toBe(true);
  });

  it('allows a response with no output items without inventing a text block', () => {
    const stream = session(); stream.push(created);
    const end = stream.push(frame({ type: 'response.completed', response: response('completed') }, 1));
    expect(end.terminal).toEqual({ status: 'completed', reason: 'stop' });
    expect(end.events.map(event => JSON.parse(event.data).type)).toEqual(['message_delta', 'message_stop']);
  });

  it('keeps EOF incomplete and preserves UTF-8 output under one-byte transport splits', async () => {
    const eof = session(); eof.push(created); expect(eof.finish({ kind: 'eof' })).toMatchObject({ terminal: { status: 'incomplete', reason: 'unexpected_eof' } });
    const wire = [created, itemAdded, partAdded, textDelta('你好'), textDone('你好'), partDone('你好'), itemDone('你好'), completed('你好')]
      .map(item => `event: ${item.event}\ndata: ${item.data}\n\n`).join('');
    const bytes = new TextEncoder().encode(wire); let cursor = 0;
    const source = new ReadableStream<Uint8Array>({ pull(controller) { if (cursor < bytes.length) controller.enqueue(Uint8Array.of(bytes[cursor++]!)); else controller.close(); } }, { highWaterMark: 0 });
    const parser = new SseByteParser(); const output: string[] = [];
    for await (const step of streamResponsesToMessages(source, context, options)) output.push(...parser.push(step.bytes).map(event => event.data));
    expect(output.some(value => value.includes('"text":"你好"'))).toBe(true);
    expect(JSON.parse(output.at(-1)!).type).toBe('message_stop');
  });

  it('rejects duplicate starts and invalid source sequence/context values', () => {
    const stream = session(); stream.push(created); expect(stream.push(created).terminal?.status).toBe('failed');
    expect(createResponsesToMessagesSession({ ...context, targetModel: '' }, options).ok).toBe(false);
    expect(createResponsesToMessagesSession(context, { ...options, maxBufferedBytes: 0 }).ok).toBe(false);
  });
});

describe('P-RM-S2 Responses function-call argument fragments', () => {
  const toolAdded = (sequence = 1) => frame({ type: 'response.output_item.added', output_index: 0,
    item: { type: 'function_call', id: 'item_native_call', call_id: 'call_native', name: 'lookup', arguments: '', status: 'in_progress' } }, sequence);
  const argsDelta = (delta: string, sequence: number) => frame({ type: 'response.function_call_arguments.delta', output_index: 0,
    item_id: 'item_native_call', delta }, sequence);
  const argsDone = (argumentsText: string, sequence: number) => frame({ type: 'response.function_call_arguments.done', output_index: 0,
    item_id: 'item_native_call', arguments: argumentsText, name: 'lookup' }, sequence);
  const toolDone = (argumentsText: string, sequence: number) => frame({ type: 'response.output_item.done', output_index: 0,
    item: { type: 'function_call', id: 'item_native_call', call_id: 'call_native', name: 'lookup', arguments: argumentsText, status: 'completed' } }, sequence);

  it('forwards incomplete argument fragments as Messages input_json_delta events', () => {
    const stream = session(); stream.push(created);
    const start = stream.push(toolAdded());
    expect(JSON.parse(start.events[0]!.data)).toEqual({ type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: 'call_native', name: 'lookup', input: {} } });
    expect(JSON.parse(stream.push(argsDelta('{"q":', 2)).events[0]!.data)).toEqual({ type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"q":' } });
    expect(JSON.parse(stream.push(argsDelta('"中"}', 3)).events[0]!.data).delta.partial_json).toBe('"中"}');
    stream.push(argsDone('{"q":"中"}', 4));
    const stopped = stream.push(toolDone('{"q":"中"}', 5));
    expect(JSON.parse(stopped.events[0]!.data)).toEqual({ type: 'content_block_stop', index: 0 });
    const end = stream.push(frame({ type: 'response.completed', response: { ...response('completed', [{ type: 'function_call', id: 'item_native_call', call_id: 'call_native', name: 'lookup', arguments: '{"q":"中"}', status: 'completed' }]) } }, 6));
    expect(end.terminal).toMatchObject({ status: 'completed', reason: 'tool_calls' });
    expect(JSON.parse(end.events[0]!.data).delta.stop_reason).toBe('tool_use');
  });

  it('rejects tool argument identity changes without exposing source data', () => {
    const stream = session(); stream.push(created); stream.push(toolAdded()); stream.push(argsDelta('{', 2));
    expect(stream.push(argsDone('{}', 3)).terminal?.status).toBe('failed');
  });
});

describe('P-RM-S3 interleaved Responses tools and empty text', () => {
  const tool = (outputIndex: number, id: string, callId: string, name: string, sequence: number) => frame({ type: 'response.output_item.added', output_index: outputIndex,
    item: { type: 'function_call', id, call_id: callId, name, arguments: '', status: 'in_progress' } }, sequence);
  const delta = (outputIndex: number, id: string, value: string, sequence: number) => frame({ type: 'response.function_call_arguments.delta', output_index: outputIndex,
    item_id: id, delta: value }, sequence);
  const done = (outputIndex: number, id: string, callId: string, name: string, args: string, sequence: number) => frame({ type: 'response.output_item.done', output_index: outputIndex,
    item: { type: 'function_call', id, call_id: callId, name, arguments: args, status: 'completed' } }, sequence);

  it('retains each tool block index when source arguments are interleaved', () => {
    const stream = session(); stream.push(created);
    expect(JSON.parse(stream.push(tool(0, 'item_a', 'call_a', 'first', 1)).events[0]!.data).index).toBe(0);
    expect(JSON.parse(stream.push(tool(1, 'item_b', 'call_b', 'second', 2)).events[0]!.data).index).toBe(1);
    expect(JSON.parse(stream.push(delta(1, 'item_b', '{"b":', 3)).events[0]!.data)).toMatchObject({ index: 1, delta: { partial_json: '{"b":' } });
    expect(JSON.parse(stream.push(delta(0, 'item_a', '{"a":', 4)).events[0]!.data)).toMatchObject({ index: 0, delta: { partial_json: '{"a":' } });
    stream.push(delta(1, 'item_b', '2}', 5)); stream.push(delta(0, 'item_a', '1}', 6));
    stream.push(frame({ type: 'response.function_call_arguments.done', output_index: 1, item_id: 'item_b', arguments: '{"b":2}', name: 'second' }, 7));
    stream.push(frame({ type: 'response.function_call_arguments.done', output_index: 0, item_id: 'item_a', arguments: '{"a":1}', name: 'first' }, 8));
    stream.push(done(1, 'item_b', 'call_b', 'second', '{"b":2}', 9)); stream.push(done(0, 'item_a', 'call_a', 'first', '{"a":1}', 10));
    const end = stream.push(frame({ type: 'response.completed', response: response('completed', []) }, 11));
    expect(end.terminal).toMatchObject({ status: 'completed', reason: 'tool_calls' });
    expect(end.events.map(event => JSON.parse(event.data).type)).toEqual(['message_delta', 'message_stop']);
  });

  it('keeps an explicitly empty text part as a block lifecycle without fabricating a delta', () => {
    const stream = session(); stream.push(created); stream.push(itemAdded); stream.push(partAdded);
    expect(stream.push(textDelta('', 3)).events).toEqual([]);
    expect(stream.push(textDone('', 4)).events).toEqual([]);
    expect(JSON.parse(stream.push(partDone('', 5)).events[0]!.data)).toEqual({ type: 'content_block_stop', index: 0 });
    stream.push(itemDone('', 6));
    expect(stream.push(frame({ type: 'response.completed', response: response('completed', []) }, 7)).terminal).toMatchObject({ status: 'completed' });
  });
});

describe('P-RM-S4 Responses terminal, error and cancellation boundaries', () => {
  it('maps max output truncation to Messages max_tokens while preserving incomplete state', () => {
    const stream = session(); stream.push(created);
    const result = stream.push(frame({ type: 'response.incomplete', response: { ...response('incomplete'), incomplete_details: { reason: 'max_output_tokens' } } }, 1));
    expect(result.terminal).toMatchObject({ status: 'incomplete', reason: 'length' });
    expect(result.events.map(event => JSON.parse(event.data).type)).toEqual(['message_delta', 'message_stop']);
    expect(JSON.parse(result.events[0]!.data).delta.stop_reason).toBe('max_tokens');
  });

  it('reports an unrepresentable content filter as an incomplete stream error', () => {
    const stream = session(); stream.push(created);
    const result = stream.push(frame({ type: 'response.incomplete', response: { ...response('incomplete'), incomplete_details: { reason: 'content_filter' } } }, 1));
    expect(result.terminal).toMatchObject({ status: 'incomplete', reason: 'content_filter' });
    expect(JSON.stringify(result)).not.toContain('provider');
    expect(result.events.at(-1)?.event).toBe('error');
  });

  it('sanitizes failed Responses and separates EOF, cancellation and unknown events', () => {
    const failed = session(); failed.push(created);
    const errorResult = failed.push(frame({ type: 'response.failed', response: { ...response('failed'), error: { code: 'secret', message: 'private' } } }, 1));
    expect(errorResult.terminal).toMatchObject({ status: 'failed', error: { code: 'upstream_error' } });
    expect(JSON.stringify(errorResult)).not.toContain('private');
    const eof = session(); eof.push(created); expect(eof.finish({ kind: 'eof' })).toMatchObject({ terminal: { status: 'incomplete', reason: 'unexpected_eof' } });
    const cancelled = session(); cancelled.push(created); expect(cancelled.finish({ kind: 'cancelled' })).toMatchObject({ terminal: { status: 'cancelled' }, events: [] });
    expect(session({ ...options, unknownEventPolicy: 'ignore' }).push(frame({ type: 'future.event' }, 0))).toEqual({ events: [], usageUpdates: [] });
    expect(session({ ...options, unknownEventPolicy: 'preserve' }).push(frame({ type: 'future.event' }, 0)).terminal?.status).toBe('failed');
  });
});

describe('P-RM-S5 original Responses usage evidence', () => {
  it('maps inclusive Responses input counts to Messages usage once at the final delta', () => {
    const stream = session();
    stream.push(frame({ type: 'response.created', response: response('in_progress') }, 0));
    const end = stream.push(frame({ type: 'response.completed', response: { ...response('completed'), usage: {
      input_tokens: 10, output_tokens: 4, total_tokens: 14,
      input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 },
    } } }, 1));
    expect(end.usageUpdates).toMatchObject([{ sequence: 1, final: true, mode: 'cumulative', counts: { inputTokens: 10, outputTokens: 4 } }]);
    expect(end.usage).toMatchObject({ protocol: 'responses', quality: 'complete', counts: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 2 } });
    expect(JSON.parse(end.events[0]!.data).usage).toEqual({ input_tokens: 5, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens_details: { thinking_tokens: 1 } });
    expect(JSON.parse(end.events[1]!.data).type).toBe('message_stop');
  });

  it('retains partial evidence without synthesizing missing input/output counters', () => {
    const stream = session(); stream.push(frame({ type: 'response.created', response: response('in_progress') }, 0));
    const end = stream.push(frame({ type: 'response.completed', response: { ...response('completed'), usage: { output_tokens: 2 } } }, 1));
    expect(end.usage).toMatchObject({ quality: 'partial', counts: { outputTokens: 2 } });
    expect(Object.hasOwn(JSON.parse(end.events[0]!.data), 'usage')).toBe(true);
    expect(JSON.parse(end.events[0]!.data).usage).toEqual({ output_tokens: 2 });
  });
});

describe('P-RM-S6 unsigned public reasoning and extension boundaries', () => {
  it('maps a public Responses summary to an explicitly unsigned Messages thinking block', () => {
    const stream = session(); stream.push(created);
    const itemStep = stream.push(frame({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'reasoning_native', summary: [], status: 'in_progress' } }, 1));
    expect(JSON.parse(itemStep.events[0]!.data)).toEqual({ type: 'content_block_start', index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' } });
    expect(stream.push(frame({ type: 'response.reasoning_summary_part.added', output_index: 0, item_id: 'reasoning_native', summary_index: 0,
      part: { type: 'summary_text', text: '' } }, 2)).events).toEqual([]);
    expect(JSON.parse(stream.push(frame({ type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'reasoning_native', summary_index: 0, delta: 'plan' }, 3)).events[0]!.data)).toEqual({ type: 'content_block_delta', index: 0,
      delta: { type: 'thinking_delta', thinking: 'plan' } });
    stream.push(frame({ type: 'response.reasoning_summary_text.done', output_index: 0, item_id: 'reasoning_native', summary_index: 0, text: 'plan' }, 4));
    stream.push(frame({ type: 'response.reasoning_summary_part.done', output_index: 0, item_id: 'reasoning_native', summary_index: 0, part: { type: 'summary_text', text: 'plan' } }, 5));
    const closed = stream.push(frame({ type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'reasoning_native', summary: [{ type: 'summary_text', text: 'plan' }], status: 'completed' } }, 6));
    expect(JSON.parse(closed.events[0]!.data)).toEqual({ type: 'content_block_stop', index: 0 });
    stream.push(frame({ type: 'response.completed', response: { ...response('completed', [{ type: 'reasoning', id: 'reasoning_native', summary: [{ type: 'summary_text', text: 'plan' }], status: 'completed' }]) } }, 7));
  });

  it('rejects encrypted/private reasoning instead of relabeling it as a signature', () => {
    const stream = session(); stream.push(created);
    const failed = stream.push(frame({ type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'private_reasoning', summary: [], encrypted_content: 'opaque-secret', status: 'in_progress' } }, 1));
    expect(failed.terminal?.status).toBe('failed'); expect(JSON.stringify(failed)).not.toContain('opaque-secret');
  });
});
