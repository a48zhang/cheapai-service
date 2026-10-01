import { describe, expect, it, vi } from 'vitest';
import { createMessagesStreamSession, streamMessagesPassthrough } from '../../../packages/apicompat/passthrough/messages-stream.js';
import type { MessagesStreamSession } from '../../../packages/apicompat/passthrough/messages-stream.js';
import type { ResponseContext, StreamOptions } from '../../../packages/apicompat/types/adapter.js';
import { SseByteParser } from '../../../packages/apicompat/streams/parser.js';

const context: ResponseContext = { identity: { responseId: 'msg_public', upstreamResponseId: 'msg_native' }, targetModel: 'public-model', createdAt: 0,
  idFor() { throw new Error('No ID allocation in native streaming'); } };
const options: StreamOptions = { unknownEventPolicy: 'reject', maxBufferedBytes: 32_768 };
const start = { type: 'message_start', message: { id: 'msg_native', type: 'message', role: 'assistant', model: 'provider', content: [],
  stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 2 } } };
const textStart = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
const textDelta = { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好🧭' } };
const textStop = { type: 'content_block_stop', index: 0 };
const end = { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } };
const stop = { type: 'message_stop' };
const frame = (event: { type: string }) => ({ event: event.type, data: JSON.stringify(event) });
const encoder = new TextEncoder();
const wire = (events: { type: string }[], eol = '\n') => encoder.encode(events.map(event => `event: ${event.type}${eol}data: ${JSON.stringify(event)}${eol}${eol}`).join(''));
function session(config: StreamOptions = options): MessagesStreamSession {
  const result = createMessagesStreamSession(context, config);
  if (!result.ok) throw new Error('Expected a valid session');
  return result.value;
}

describe('Messages native streaming lifecycle and usage', () => {
  it('emits each event immediately, maps root identity only, and accumulates cumulative usage once', () => {
    const stream = session();
    const first = stream.push(frame(start));
    expect(JSON.parse(first.events[0]!.data)).toMatchObject({ message: { id: 'msg_public', model: 'public-model', usage: start.message.usage } });
    expect(first.terminal).toBeUndefined();
    expect(first.usageUpdates).toHaveLength(1);
    for (const event of [textStart, textDelta, textStop]) {
      expect(stream.push(frame(event))).toMatchObject({ events: [frame(event)], usageUpdates: [] });
    }
    stream.push(frame({ type: 'message_delta', delta: { stop_reason: null, stop_sequence: null }, usage: { output_tokens: 1 } } as typeof end));
    const finalDelta = stream.push(frame(end));
    expect(finalDelta.terminal).toBeUndefined();
    expect(finalDelta.usageUpdates).toMatchObject([{ mode: 'cumulative', counts: { outputTokens: 4 }, final: true }]);
    const final = stream.push(frame(stop));
    expect(final).toMatchObject({ events: [frame(stop)], terminal: { status: 'completed', reason: 'stop' },
      usage: { quality: 'partial', counts: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 2 } } });
    expect(final.usageUpdates).toEqual([]);
    expect(stream.push(frame(stop))).toEqual({ events: [], usageUpdates: [] });
    expect(stream.finish({ kind: 'eof' })).toEqual({ events: [], usageUpdates: [] });
  });

  it('preserves thinking/signature and split tool arguments without parsing each delta', () => {
    const stream = session(); stream.push(frame(start));
    const events = [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'native thought' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque-signature' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool_original', name: 'lookup', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"中"}' } },
      { type: 'content_block_stop', index: 1 },
    ];
    for (const event of events) expect(stream.push(frame(event))).toEqual({ events: [frame(event)], usageUpdates: [] });
    stream.push(frame({ ...end, delta: { stop_reason: 'tool_use', stop_sequence: null } }));
    expect(stream.push(frame(stop)).terminal).toMatchObject({ status: 'completed', reason: 'tool_calls' });
  });

  it('preserves missing usage and nullable cache evidence without creating zeros', () => {
    const stream = session();
    const { usage: _usage, ...message } = start.message;
    const first = stream.push(frame({ type: 'message_start', message }));
    expect(JSON.parse(first.events[0]!.data).message).not.toHaveProperty('usage');
    stream.push(frame({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } }));
    expect(stream.push(frame(stop)).usage).toMatchObject({ quality: 'missing' });
    const nullable = session();
    const observed = nullable.push(frame({ ...start, message: { ...start.message, usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: null } } }));
    expect(JSON.parse(observed.events[0]!.data).message.usage.cache_read_input_tokens).toBeNull();
  });

  it('preserves redacted/cache blocks and accepts a no-argument tool with empty deltas', () => {
    const stream = session(); stream.push(frame(start));
    const events = [
      { type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'opaque-native' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '1h' } } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'empty-tool', name: 'f', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '' } },
      { type: 'content_block_stop', index: 2 },
    ];
    for (const event of events) expect(stream.push(frame(event))).toEqual({ events: [frame(event)], usageUpdates: [] });
  });

  it('only marks P14 usage complete when every required counter was actually provided', () => {
    const stream = session();
    stream.push(frame({ ...start, message: { ...start.message, usage: { ...start.message.usage, cache_creation_input_tokens: 0 } } }));
    stream.push(frame(end));
    expect(stream.push(frame(stop)).usage).toMatchObject({ quality: 'complete', counts: { outputTokens: 4, cacheWriteTokens: 0 } });
  });

  it.each(['max_tokens', 'model_context_window_exceeded', 'refusal', 'pause_turn'])('never labels %s normal completion', reason => {
    const stream = session(); stream.push(frame(start));
    stream.push(frame({ ...end, delta: { stop_reason: reason, stop_sequence: null } }));
    expect(stream.push(frame(stop)).terminal?.status).toBe('incomplete');
  });

  it.each([
    [textStart], [start, start], [start, textDelta], [start, { ...textStart, index: 2 }],
    [start, textStart, end], [start, stop], [start, end, textStart], [start, end, end],
    [start, textStart, { ...textDelta, delta: { type: 'signature_delta', signature: 'wrong block' } }],
  ].map(events => ({ events })))('rejects bad event order without fabricating message_stop %#', ({ events }) => {
    const stream = session();
    let last;
    for (const event of events) last = stream.push(frame(event));
    expect(last?.terminal?.status).toBe('failed');
    expect(last?.events[0]?.event).toBe('error');
    expect(stream.push(frame(stop)).terminal).toBeUndefined();
  });

  it('rejects invalid or oversized complete tool parameters and seals after failure', () => {
    for (const fragments of [['{"bad":'], ['x'.repeat(100), 'x'.repeat(100), 'x'.repeat(100)]]) {
      const stream = session({ ...options, maxBufferedBytes: 256 });
      stream.push(frame(start));
      stream.push(frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'f', input: {} } }));
      const steps = fragments.map(partial_json => stream.push(frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } })));
      steps.push(stream.push(frame(textStop)));
      expect(steps.some(step => step.terminal?.status === 'failed')).toBe(true);
      expect(stream.finish({ kind: 'cancelled' }).terminal).toBeUndefined();
    }
  });

  it('sanitizes upstream and transport errors and treats EOF/cancellation separately', () => {
    const stream = session(); stream.push(frame(start));
    const result = stream.push(frame({ type: 'error', error: { type: 'private', message: 'Bearer SECRET' } }));
    expect(result.terminal?.status).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('SECRET');
    const eof = session(); eof.push(frame(start)); eof.push(frame(end));
    expect(eof.finish({ kind: 'eof' }).terminal).toEqual({ status: 'incomplete', reason: 'unexpected_eof' });
    const cancelled = session(); cancelled.push(frame(start));
    expect(cancelled.finish({ kind: 'cancelled' })).toMatchObject({ events: [], terminal: { status: 'cancelled' } });
    const failed = session().finish({ kind: 'error', error: { kind: 'stream_error', code: 'SECRET', message: 'SECRET' } });
    expect(JSON.stringify(failed)).not.toContain('SECRET');
  });

  it('supports explicit unknown-event ignore, rejects unsafe preserve, and checks frame/type agreement', () => {
    expect(session({ ...options, unknownEventPolicy: 'ignore' }).push(frame({ type: 'future_event' }))).toEqual({ events: [], usageUpdates: [] });
    expect(session({ ...options, unknownEventPolicy: 'preserve' }).push(frame({ type: 'future_event' })).terminal?.status).toBe('failed');
    expect(session().push({ event: 'message_stop', data: JSON.stringify(start) }).terminal?.status).toBe('failed');
    expect(session().push(frame({ ...start, headers: { authorization: 'SECRET' } })).terminal?.status).toBe('failed');
    expect(session().push(frame({ type: 'ping' }))).toEqual({ events: [frame({ type: 'ping' })], usageUpdates: [] });
  });

  it('does not let caller mutation broaden an existing session frame limit', () => {
    const limits = { ...options, maxBufferedBytes: 256 };
    const stream = session(limits);
    limits.maxBufferedBytes = 100_000;
    expect(stream.push(frame({ type: 'ping', padding: 'x'.repeat(1000) })).terminal?.status).toBe('failed');
    expect(createMessagesStreamSession(context, { ...options, maxBufferedBytes: 0 }).ok).toBe(false);
  });
});

describe('incremental Messages SSE byte output', () => {
  function source(chunks: Uint8Array[], cancel = vi.fn()) {
    let reads = 0;
    return { cancel, get reads() { return reads; }, stream: new ReadableStream<Uint8Array>({
      pull(controller) { reads += 1; const next = chunks.shift(); if (next) controller.enqueue(next); else controller.close(); }, cancel,
    }, { highWaterMark: 0 }) };
  }

  it('handles UTF-8/CRLF byte splits and yields parseable native SSE in original order', async () => {
    const events = [start, textStart, textDelta, textStop, end, stop];
    const bytes = wire(events, '\r\n');
    const input = source([...bytes].map(byte => Uint8Array.of(byte)));
    const parser = new SseByteParser();
    const decoded = []; const terminals = [];
    for await (const result of streamMessagesPassthrough(input.stream, context, options)) {
      decoded.push(...parser.push(result.bytes).map(item => JSON.parse(item.data)));
      if (result.terminal) terminals.push(result.terminal);
    }
    expect(decoded).toEqual([{ ...start, message: { ...start.message, id: 'msg_public', model: 'public-model' } }, ...events.slice(1)]);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ status: 'completed' });
  });

  it('does not read ahead under slow consumption and cancels on early return', async () => {
    const input = source([wire([start]), wire([textStart]), wire([textDelta]), wire([textStop, end, stop])]);
    const output = streamMessagesPassthrough(input.stream, context, options);
    const first = await output.next();
    expect(new TextDecoder().decode(first.value!.bytes)).toContain('message_start');
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(input.reads).toBe(1);
    await output.return();
    expect(input.cancel).toHaveBeenCalledOnce();
    expect(input.stream.locked).toBe(false);
  });

  it('handles multiple frames, comments and multiline data in one source chunk', async () => {
    const prefix = encoder.encode('\ufeff: heartbeat\r\r event-ignored: x\n\nevent: ping\ndata: {\ndata: "type":"ping"\ndata: }\n\n');
    const body = wire([start, end, stop]);
    const combined = new Uint8Array(prefix.length + body.length); combined.set(prefix); combined.set(body, prefix.length);
    const input = source([combined]); const parser = new SseByteParser(); const types: string[] = [];
    for await (const output of streamMessagesPassthrough(input.stream, context, options)) {
      types.push(...parser.push(output.bytes).map(item => JSON.parse(item.data).type));
    }
    expect(types).toEqual(['ping', 'message_start', 'message_delta', 'message_stop']);
  });

  it('cancellation interrupts pending reads with no completion wire event', async () => {
    const abort = new AbortController(); const cancel = vi.fn();
    const input = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const output = streamMessagesPassthrough(input, context, options, abort.signal);
    const pending = output.next(); abort.abort();
    const step = (await pending).value!;
    expect(step.bytes.byteLength).toBe(0);
    expect(step.terminal).toEqual({ status: 'cancelled' });
    await output.return();
    expect(cancel).toHaveBeenCalledOnce();
    expect(input.locked).toBe(false);
  });

  it('enforces a bounded incomplete frame and never dispatches an EOF residual as success', async () => {
    const incomplete = source([wire([start]), encoder.encode('event: message_stop\ndata: {"type":"message_stop"}')]);
    const steps = [];
    for await (const step of streamMessagesPassthrough(incomplete.stream, context, options)) steps.push(step);
    expect(steps.at(-1)?.terminal).toEqual({ status: 'incomplete', reason: 'unexpected_eof' });
    expect(new TextDecoder().decode(steps.at(-1)!.bytes)).not.toContain('event: message_stop');
    const oversized = source([encoder.encode('data: ' + 'x'.repeat(100)), encoder.encode('x'.repeat(100))]);
    const failed = [];
    for await (const step of streamMessagesPassthrough(oversized.stream, context, { ...options, maxBufferedBytes: 150 })) failed.push(step);
    expect(failed.at(-1)?.terminal?.status).toBe('failed');
    expect(oversized.cancel).toHaveBeenCalledOnce();
  });
});
