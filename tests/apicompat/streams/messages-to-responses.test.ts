import { describe, expect, it } from 'vitest';
import { createMessagesToResponsesSession, streamMessagesToResponses } from '../../../packages/apicompat/streams/messages-to-responses.js';
import { createResponsesStreamSession } from '../../../packages/apicompat/passthrough/responses-stream.js';
import type { ResponseContext, StreamOptions } from '../../../packages/apicompat/types/adapter.js';
import { SseByteParser } from '../../../packages/apicompat/streams/parser.js';

const context: ResponseContext = {
  targetModel: 'public-model',
  identity: { responseId: 'resp_public', upstreamResponseId: 'msg_native' },
  createdAt: 123,
  idFor: (_kind, key) => `item_${key.replaceAll(':', '_')}`,
};
const options: StreamOptions = { unknownEventPolicy: 'reject', maxBufferedBytes: 8192 };
const messageStart = { type: 'message_start', message: { id: 'msg_native', type: 'message', role: 'assistant', model: 'provider-model', content: [], stop_reason: null, stop_sequence: null } };
const source = (value: object) => ({ event: (value as { type: string }).type, data: JSON.stringify(value) });
const textStart = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
const textDelta = (text: string) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
const textStop = { type: 'content_block_stop', index: 0 };
const finalDelta = { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } };
const stop = { type: 'message_stop' };

function session(config = options) {
  const result = createMessagesToResponsesSession(context, config);
  if (!result.ok) throw new Error('Invalid test configuration');
  return result.value;
}

describe('P-MR-S1 Messages → Responses text lifecycle', () => {
  it('opens target Responses IDs and emits text item/content lifecycle directly', () => {
    const stream = session();
    const start = stream.push(source(messageStart));
    expect(start.events.map(event => event.event)).toEqual(['response.created', 'response.in_progress']);
    expect(JSON.parse(start.events[0]!.data).response).toMatchObject({ id: 'resp_public', created_at: 123, model: 'public-model', status: 'in_progress', output: [] });
    const opened = stream.push(source(textStart));
    expect(opened.events.map(event => event.event)).toEqual(['response.output_item.added', 'response.content_part.added']);
    expect(JSON.parse(opened.events[0]!.data)).toMatchObject({ output_index: 0, item: { type: 'message', id: 'item_message_0', role: 'assistant', status: 'in_progress' } });
    expect(JSON.parse(opened.events[1]!.data)).toMatchObject({ output_index: 0, content_index: 0, item_id: 'item_message_0', part: { type: 'output_text', text: '' } });
    expect(JSON.parse(stream.push(source(textDelta('你好'))).events[0]!.data)).toMatchObject({ type: 'response.output_text.delta', output_index: 0, item_id: 'item_message_0', delta: '你好' });
    const closed = stream.push(source(textStop));
    expect(closed.events.map(event => event.event)).toEqual(['response.output_text.done', 'response.content_part.done', 'response.output_item.done']);
    expect(JSON.parse(closed.events[2]!.data).item).toMatchObject({ type: 'message', id: 'item_message_0', status: 'completed', content: [{ text: '你好' }] });
    stream.push(source(finalDelta));
    const end = stream.push(source(stop));
    expect(end.terminal).toMatchObject({ status: 'completed', reason: 'stop', upstreamReason: 'end_turn' });
    expect(JSON.parse(end.events[0]!.data).response).toMatchObject({ id: 'resp_public', status: 'completed', output: [{ id: 'item_message_0' }] });
    const target = createResponsesStreamSession({ ...context, identity: { responseId: 'resp_public', upstreamResponseId: 'resp_public' } }, options);
    if (!target.ok) throw new Error('Invalid target configuration');
    for (const [i, event] of [...start.events, ...opened.events, ...closed.events, ...end.events].entries()) {
      const step = target.value.push(event);
      if (step.terminal?.status === 'failed') throw new Error(`target rejected event ${i}: ${event.event} ${event.data}`);
    }
  });

  it('keeps an empty source response empty and does not fabricate text', () => {
    const stream = session(); stream.push(source(messageStart)); stream.push(source(finalDelta));
    const end = stream.push(source(stop));
    expect(JSON.parse(end.events[0]!.data).response.output).toEqual([]);
    expect(end.terminal).toMatchObject({ status: 'completed', reason: 'stop' });
  });

  it('separates EOF and cancellation and handles byte-split source incrementally', async () => {
    const eof = session(); eof.push(source(messageStart)); expect(eof.finish({ kind: 'eof' })).toMatchObject({ terminal: { status: 'incomplete', reason: 'unexpected_eof' } });
    const cancelled = session(); cancelled.push(source(messageStart)); expect(cancelled.finish({ kind: 'cancelled' })).toMatchObject({ terminal: { status: 'cancelled' }, events: [] });
    const wire = [messageStart, textStart, textDelta('你好'), textStop, finalDelta, stop].map(value => `event: ${(value as { type: string }).type}\ndata: ${JSON.stringify(value)}\n\n`).join('');
    const bytes = new TextEncoder().encode(wire); let offset = 0;
    const input = new ReadableStream<Uint8Array>({ pull(controller) { if (offset < bytes.length) controller.enqueue(Uint8Array.of(bytes[offset++]!)); else controller.close(); } }, { highWaterMark: 0 });
    const parser = new SseByteParser(); const frames: string[] = [];
    for await (const step of streamMessagesToResponses(input, context, options)) frames.push(...parser.push(step.bytes).map(frame => frame.data));
    expect(frames.some(value => value.includes('"delta":"你好"'))).toBe(true);
    expect(JSON.parse(frames.at(-1)!).type).toBe('response.completed');
  });
});

describe('P-MR-S2 Messages tool_use argument fragments', () => {
  const toolStart = { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_native', name: 'lookup', input: {} } };
  const delta = (partial_json: string) => ({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } });
  const toolStop = { type: 'content_block_stop', index: 0 };

  it('maps tool_use to a Responses function_call and streams raw arguments', () => {
    const stream = session(); stream.push(source(messageStart));
    const opened = stream.push(source(toolStart));
    expect(opened.events.map(event => event.event)).toEqual(['response.output_item.added']);
    expect(JSON.parse(opened.events[0]!.data)).toMatchObject({ output_index: 0, item: { type: 'function_call', id: 'item_tool_0', call_id: 'call_native', name: 'lookup', arguments: '' } });
    const firstDelta = stream.push(source(delta('{"q":')));
    expect(JSON.parse(firstDelta.events[0]!.data)).toMatchObject({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'item_tool_0', delta: '{"q":' });
    expect(JSON.parse(stream.push(source(delta('"中"}'))).events[0]!.data).delta).toBe('"中"}');
    const closed = stream.push(source(toolStop));
    expect(closed.events.map(event => event.event)).toEqual(['response.function_call_arguments.done', 'response.output_item.done']);
    expect(JSON.parse(closed.events[0]!.data)).toMatchObject({ output_index: 0, item_id: 'item_tool_0', arguments: '{"q":"中"}' });
    stream.push(source({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null } }));
    const end = stream.push(source({ type: 'message_stop' }));
    expect(end.terminal).toMatchObject({ status: 'completed', reason: 'tool_calls' });
    expect(JSON.parse(end.events[0]!.data).response.output).toMatchObject([{ type: 'function_call', call_id: 'call_native', arguments: '{"q":"中"}' }]);
  });

  it('does not invent a second argument stream for an empty input placeholder', () => {
    const stream = session(); stream.push(source(messageStart));
    const opened = stream.push(source(toolStart));
    expect(opened.events.some(event => event.event === 'response.function_call_arguments.delta')).toBe(false);
    const closed = stream.push(source(toolStop));
    expect(JSON.parse(closed.events[0]!.data).arguments).toBe('{}');
  });
});

describe('P-MR-S3 parallel tool blocks and empty text', () => {
  const toolStart = (index: number, id: string, name: string) => ({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } });
  const delta = (index: number, partial_json: string) => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } });
  const stopBlock = (index: number) => ({ type: 'content_block_stop', index });

  it('keeps two tool call IDs and output indexes independent', () => {
    const stream = session(); stream.push(source(messageStart));
    const first = stream.push(source(toolStart(0, 'call_a', 'first')));
    expect(JSON.parse(first.events[0]!.data)).toMatchObject({ output_index: 0, item: { call_id: 'call_a' } });
    stream.push(source(delta(0, '{"a":1}'))); stream.push(source(stopBlock(0)));
    const second = stream.push(source(toolStart(1, 'call_b', 'second')));
    expect(JSON.parse(second.events[0]!.data)).toMatchObject({ output_index: 1, item: { call_id: 'call_b' } });
    stream.push(source(delta(1, '{"b":2}'))); stream.push(source(stopBlock(1)));
    stream.push(source({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null } }));
    const end = stream.push(source(stop));
    expect(end.terminal).toMatchObject({ status: 'completed', reason: 'tool_calls' });
    expect(JSON.parse(end.events[0]!.data).response.output).toEqual([
      { type: 'function_call', id: 'item_tool_0', call_id: 'call_a', name: 'first', arguments: '{"a":1}', status: 'completed' },
      { type: 'function_call', id: 'item_tool_1', call_id: 'call_b', name: 'second', arguments: '{"b":2}', status: 'completed' },
    ]);
  });

  it('preserves an explicitly empty text block through Responses done events', () => {
    const stream = session(); stream.push(source(messageStart)); stream.push(source(textStart));
    const endBlock = stream.push(source(textStop));
    expect(JSON.parse(endBlock.events[0]!.data)).toMatchObject({ type: 'response.output_text.done', text: '' });
    stream.push(source(finalDelta));
    const end = stream.push(source(stop));
    expect(JSON.parse(end.events[0]!.data).response.output[0].content).toEqual([{ type: 'output_text', text: '', annotations: [] }]);
  });
});

describe('P-MR-S4 Messages terminal, error and cancellation boundaries', () => {
  it.each([
    ['max_tokens', 'incomplete', 'max_output_tokens'],
    ['refusal', 'incomplete', 'refusal'],
  ] as const)('maps Messages %s to a non-success Responses terminal', (stopReason, status, detail) => {
    const stream = session(); stream.push(source(messageStart));
    stream.push(source({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null } }));
    const end = stream.push(source(stop));
    expect(end.terminal).toMatchObject({ status: 'incomplete' });
    expect(JSON.parse(end.events[0]!.data)).toMatchObject({ type: 'response.incomplete', response: { status, incomplete_details: { reason: detail } } });
  });

  it('fails malformed completed tool arguments without fabricating response.completed', () => {
    const stream = session(); stream.push(source(messageStart));
    stream.push(source({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_native', name: 'lookup', input: {} } }));
    stream.push(source({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{' } }));
    stream.push(source({ type: 'content_block_stop', index: 0 }));
    stream.push(source({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null } }));
    const end = stream.push(source(stop));
    expect(end.terminal?.status).toBe('failed');
    expect(end.events.at(-1)?.event).toBe('error');
    expect(end.events.some(event => event.event === 'response.completed')).toBe(false);
  });

  it('sanitizes upstream errors and distinguishes EOF/cancel/unknown policy', () => {
    const failed = session(); failed.push(source(messageStart));
    const errorResult = failed.push(source({ type: 'error', error: { type: 'overloaded_error', message: 'private secret' } }));
    expect(errorResult.terminal).toMatchObject({ status: 'failed' }); expect(JSON.stringify(errorResult)).not.toContain('private');
    const eof = session(); eof.push(source(messageStart)); expect(eof.finish({ kind: 'eof' })).toMatchObject({ terminal: { status: 'incomplete', reason: 'unexpected_eof' } });
    const cancelled = session(); cancelled.push(source(messageStart)); expect(cancelled.finish({ kind: 'cancelled' })).toMatchObject({ terminal: { status: 'cancelled' }, events: [] });
    expect(session({ ...options, unknownEventPolicy: 'ignore' }).push(source({ type: 'future_event' }))).toEqual({ events: [], usageUpdates: [] });
    expect(session({ ...options, unknownEventPolicy: 'preserve' }).push(source({ type: 'future_event' })).terminal?.status).toBe('failed');
  });
});

describe('P-MR-S5 original Messages usage evidence', () => {
  it('maps Messages usage once into the final Responses envelope without double counting cache buckets', () => {
    const stream = session();
    const start = { ...messageStart, message: { ...messageStart.message, usage: { input_tokens: 8, output_tokens: 0, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } } };
    expect(stream.push(source(start)).usageUpdates).toMatchObject([{ sequence: 1, mode: 'cumulative', counts: { inputTokens: 8 } }]);
    const delta = stream.push(source({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: {
      output_tokens: 4, output_tokens_details: { thinking_tokens: 1 }, cache_read_input_tokens: 2, cache_creation_input_tokens: 1,
    } }));
    expect(delta.usageUpdates).toMatchObject([{ sequence: 2, final: true, counts: { outputTokens: 4 } }]);
    const end = stream.push(source(stop));
    expect(end.usage).toMatchObject({ protocol: 'messages', quality: 'complete', counts: { inputTokens: 8, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 } });
    expect(JSON.parse(end.events[0]!.data).response.usage).toEqual({ input_tokens: 11, output_tokens: 4, total_tokens: 15,
      input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 }, output_tokens_details: { reasoning_tokens: 1 } });
  });

  it('retains partial source usage while omitting a made-up complete Responses usage', () => {
    const stream = session(); stream.push(source(messageStart));
    stream.push(source({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }));
    const end = stream.push(source(stop));
    expect(end.usage).toMatchObject({ quality: 'partial', counts: { outputTokens: 2 } });
    expect(JSON.parse(end.events[0]!.data).response).not.toHaveProperty('usage');
  });
});

describe('P-MR-S6 unsigned thinking and safe extension boundaries', () => {
  const thinkingStart = { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } };
  it('maps an explicitly unsigned Messages thinking block to Responses reasoning summary events', () => {
    const stream = session(); stream.push(source(messageStart));
    const opened = stream.push(source(thinkingStart));
    expect(opened.events.map(event => event.event)).toEqual(['response.output_item.added']);
    expect(JSON.parse(opened.events[0]!.data)).toMatchObject({ output_index: 0, item: { type: 'reasoning', id: 'item_reasoning_0', summary: [] } });
    const delta = stream.push(source({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } }));
    expect(JSON.parse(delta.events[0]!.data)).toMatchObject({ type: 'response.reasoning_summary_text.delta', delta: 'plan' });
    const closed = stream.push(source({ type: 'content_block_stop', index: 0 }));
    expect(closed.events.map(event => event.event)).toEqual(['response.reasoning_summary_text.done', 'response.reasoning_summary_part.done', 'response.output_item.done']);
    stream.push(source(finalDelta));
    const end = stream.push(source(stop));
    expect(end.terminal).toMatchObject({ status: 'completed', reason: 'stop' });
    expect(JSON.parse(end.events[0]!.data).response.output[0]).toMatchObject({ type: 'reasoning', summary: [{ text: 'plan' }] });
  });

  it('rejects signed or redacted thinking instead of dropping authenticity data', () => {
    const signed = session(); signed.push(source(messageStart));
    expect(signed.push(source({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: 'signed' } })).terminal?.status).toBe('failed');
    const redacted = session(); redacted.push(source(messageStart));
    expect(redacted.push(source({ type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'opaque' } })).terminal?.status).toBe('failed');
  });
});
