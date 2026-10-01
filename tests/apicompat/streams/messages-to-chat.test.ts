import { describe, expect, it } from 'vitest';
import { createMessagesToChatSession, streamMessagesToChat } from '../../../packages/apicompat/streams/messages-to-chat';
import { createResponseIds } from '../../../packages/apicompat/ids';
import type { ResponseContext } from '../../../packages/apicompat/types/adapter';

const options = { unknownEventPolicy: 'reject' as const, maxBufferedBytes: 16_384 };
function context(): ResponseContext {
  const ids = createResponseIds({ seed: 'test-response' }); if (!ids.ok) throw new Error('ID fixture');
  return { identity: ids.value.identity, idFor: ids.value.idFor, targetModel: 'public-model', createdAt: 123 };
}
const frame = (event: Record<string, unknown>) => ({ event: event.type as string, data: JSON.stringify(event) });
const start = () => ({ type: 'message_start', message: { id: 'msg_synthetic', type: 'message', role: 'assistant', content: [], model: 'provider-model',
  stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 1 } } });
function session(config = options) { const result = createMessagesToChatSession(context(), config); if (!result.ok) throw new Error('Fixture session'); return result.value; }

// Synthetic values in the complete official Messages event shape, including
// mandatory message envelope and cumulative message_delta. No self-parser oracle.
const textFlow = () => [start(), { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'ping' }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' 世界' } }, { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }, { type: 'message_stop' }];

describe('P-MC-S1 text and native Chat wire lifecycle', () => {
  it('emits role then incremental content before message_stop and finishes exactly once', () => {
    const stream = session(); const events = [];
    for (const event of textFlow()) {
      const step = stream.push(frame(event)); events.push(...step.events);
      if (event.type === 'content_block_delta') expect(JSON.parse(step.events[0]!.data).choices[0].delta.content).toBe(event.delta!.text);
    }
    const decoded = events.filter(event => event.data !== '[DONE]').map(event => JSON.parse(event.data));
    expect(decoded[0].choices).toEqual([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]);
    for (const value of decoded) expect(value).toMatchObject({ id: 'resp_test-response', object: 'chat.completion.chunk', created: 123, model: 'public-model' });
    expect(decoded.filter(value => value.choices.length > 0).at(-1).choices).toEqual([{ index: 0, delta: {}, finish_reason: 'stop' }]);
    expect(events.at(-1)?.data).toBe('[DONE]');
    expect(stream.push(frame({ type: 'message_stop' })).events).toEqual([]);
    expect(stream.finish({ kind: 'eof' })).toEqual({ events: [], usageUpdates: [] });
  });

  it('does not turn incomplete lifecycle or private thinking into normal text', () => {
    const stream = session(); stream.push(frame(start()));
    const failed = stream.push(frame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'private-thought', signature: 'private-signature' } }));
    expect(failed.terminal?.status).toBe('failed'); expect(JSON.stringify(failed.events)).not.toContain('private');
    const truncated = session(); truncated.push(frame(start()));
    expect(truncated.finish({ kind: 'eof' }).terminal).toEqual({ status: 'incomplete', reason: 'unexpected_eof' });
  });

  it('rejects out-of-order blocks rather than repairing the stream', () => {
    const stream = session(); stream.push(frame(start()));
    expect(stream.push(frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'late' } })).terminal?.status).toBe('failed');
  });

  it('streams fragmented UTF-8 source bytes under pull control', async () => {
    const bytes = new TextEncoder().encode(textFlow().map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(''));
    let offset = 0; let pulls = 0;
    const source = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; if (offset === bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(offset, offset + 7)); offset = Math.min(offset + 7, bytes.length); } }, { highWaterMark: 0 });
    const iterator = streamMessagesToChat(source, context(), options);
    const first = await iterator.next(); expect(new TextDecoder().decode(first.value!.bytes)).toContain('assistant');
    const readCount = pulls; await Promise.resolve(); expect(pulls).toBe(readCount);
    let output = new TextDecoder().decode(first.value!.bytes);
    for await (const part of iterator) output += new TextDecoder().decode(part.bytes);
    expect(output).toContain(' 世界'); expect(output).toMatch(/data: \[DONE\]\n\n$/);
  });
});

describe('P-MC-S2 single tool argument fragments', () => {
  const toolStart = (input: object = {}) => ({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_original', name: 'lookup', input } });
  it('preserves the original call ID and forwards non-JSON fragments immediately', () => {
    const stream = session(); stream.push(frame(start()));
    const begin = stream.push(frame(toolStart()));
    expect(JSON.parse(begin.events[0]!.data).choices[0].delta.tool_calls).toEqual([{ index: 0, id: 'toolu_original', type: 'function', function: { name: 'lookup', arguments: '' } }]);
    const fragments = ['{"city":', '"上海"', '}']; const actual: string[] = [];
    for (const fragment of fragments) {
      const step = stream.push(frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: fragment } }));
      expect(step.terminal).toBeUndefined(); actual.push(JSON.parse(step.events[0]!.data).choices[0].delta.tool_calls[0].function.arguments);
    }
    expect(actual).toEqual(fragments);
    stream.push(frame({ type: 'content_block_stop', index: 0 }));
    stream.push(frame({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 8 } }));
    const end = stream.push(frame({ type: 'message_stop' }));
    expect(end.terminal).toMatchObject({ status: 'completed', reason: 'tool_calls' });
    expect(JSON.parse(end.events[0]!.data).choices[0].finish_reason).toBe('tool_calls');
  });

  it('emits an empty object only when an empty tool has no argument fragments', () => {
    const stream = session(); stream.push(frame(start())); stream.push(frame(toolStart()));
    const stopped = stream.push(frame({ type: 'content_block_stop', index: 0 }));
    expect(JSON.parse(stopped.events[0]!.data).choices[0].delta.tool_calls[0].function.arguments).toBe('{}');
  });

  it('rejects malformed completed JSON and conflicting initial input/fragments', () => {
    const stream = session(); stream.push(frame(start())); stream.push(frame(toolStart()));
    stream.push(frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"unfinished":' } }));
    expect(stream.push(frame({ type: 'content_block_stop', index: 0 })).terminal).toBeUndefined();
    stream.push(frame({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null } }));
    expect(stream.push(frame({ type: 'message_stop' })).terminal?.status).toBe('failed');
    const conflicting = session(); conflicting.push(frame(start())); conflicting.push(frame(toolStart({ complete: true })));
    expect(conflicting.push(frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } })).terminal?.status).toBe('failed');
  });
});

describe('P-MC-S3 interleaved parallel tools', () => {
  it('separates block indices from tool indices and preserves arbitrary delta interleaving', () => {
    const stream = session(); stream.push(frame(start()));
    stream.push(frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    stream.push(frame({ type: 'content_block_stop', index: 0 }));
    const output = [];
    for (const [index, id] of [[1, 'toolu_a'], [2, 'toolu_b']] as const) {
      output.push(...stream.push(frame({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: 'lookup', input: {} } })).events);
    }
    for (const [index, fragment] of [[1, '{"a":'], [2, '{"b":'], [1, '1}'], [2, '2}']] as const) {
      output.push(...stream.push(frame({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: fragment } })).events);
    }
    const calls = output.map(event => JSON.parse(event.data).choices[0].delta.tool_calls[0]);
    expect(calls.map(call => call.index)).toEqual([0, 1, 0, 1, 0, 1]);
    expect(calls[0].id).toBe('toolu_a'); expect(calls[1].id).toBe('toolu_b');
    expect(calls.filter(call => call.index === 0).map(call => call.function.arguments).join('')).toBe('{"a":1}');
    expect(calls.filter(call => call.index === 1).map(call => call.function.arguments).join('')).toBe('{"b":2}');
    expect(stream.push(frame({ type: 'content_block_stop', index: 2 })).terminal).toBeUndefined();
    expect(stream.push(frame({ type: 'content_block_stop', index: 1 })).terminal).toBeUndefined();
    stream.push(frame({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 12 } }));
    const end = stream.push(frame({ type: 'message_stop' }));
    expect(end.events.filter(event => event.data === '[DONE]')).toHaveLength(1);
  });

  it('rejects reused call IDs and duplicate block completion', () => {
    const stream = session(); stream.push(frame(start()));
    stream.push(frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_same', name: 'lookup', input: {} } }));
    expect(stream.push(frame({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_same', name: 'lookup', input: {} } })).terminal?.status).toBe('failed');
    const duplicate = session(); duplicate.push(frame(start()));
    duplicate.push(frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    duplicate.push(frame({ type: 'content_block_stop', index: 0 }));
    expect(duplicate.push(frame({ type: 'content_block_stop', index: 0 })).terminal?.status).toBe('failed');
  });
});

describe('P-MC-S4 truncation, errors and cancellation', () => {
  it('preserves partial tool JSON under native max_tokens as length, not successful tool completion', () => {
    const stream = session(); stream.push(frame(start()));
    stream.push(frame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_partial', name: 'lookup', input: {} } }));
    stream.push(frame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"x":' } }));
    stream.push(frame({ type: 'content_block_stop', index: 0 }));
    stream.push(frame({ type: 'message_delta', delta: { stop_reason: 'max_tokens', stop_sequence: null }, usage: { output_tokens: 3 } }));
    const end = stream.push(frame({ type: 'message_stop' }));
    expect(end.terminal).toMatchObject({ status: 'incomplete', reason: 'length' });
    expect(JSON.parse(end.events[0]!.data).choices[0].finish_reason).toBe('length');
    expect(end.events.at(-1)?.data).toBe('[DONE]');
  });

  it.each([['refusal', 'refusal'], ['pause_turn', 'unknown']] as const)('does not turn %s into a normal stop', (reason, expected) => {
    const stream = session(); stream.push(frame(start()));
    stream.push(frame({ type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null } }));
    const end = stream.push(frame({ type: 'message_stop' }));
    expect(end.terminal).toMatchObject({ status: 'incomplete', reason: expected });
    expect(end.events.some(event => event.data === '[DONE]')).toBe(false);
    expect(JSON.parse(end.events[0]!.data)).toHaveProperty('error');
  });

  it('redacts provider errors and emits no completion marker after error/cancel', () => {
    const stream = session(); stream.push(frame(start()));
    const failed = stream.push(frame({ type: 'error', error: { type: 'overloaded_error', message: 'private sk-key upstream text' } }));
    expect(failed.terminal?.status).toBe('failed'); expect(JSON.stringify(failed.events)).not.toContain('private');
    expect(failed.events.some(event => event.data === '[DONE]')).toBe(false);
    expect(stream.finish({ kind: 'eof' })).toEqual({ events: [], usageUpdates: [] });
    const cancelled = session(); cancelled.push(frame(start()));
    expect(cancelled.finish({ kind: 'cancelled' })).toMatchObject({ events: [], terminal: { status: 'cancelled' } });
    expect(cancelled.push(frame({ type: 'message_stop' }))).toEqual({ events: [], usageUpdates: [] });
  });

  it('propagates AbortSignal to the byte reader without fabricating DONE', async () => {
    let cancelled = false; const signal = new AbortController();
    const bytes = new TextEncoder().encode(`event: message_start\ndata: ${JSON.stringify(start())}\n\n`);
    const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); }, cancel() { cancelled = true; } });
    const iterator = streamMessagesToChat(source, context(), options, signal.signal);
    await iterator.next(); signal.abort();
    const end = await iterator.next();
    expect(cancelled).toBe(true); expect(end.value!.terminal?.status).toBe('cancelled');
    expect(new TextDecoder().decode(end.value!.bytes)).not.toContain('[DONE]');
    await iterator.return();
  });
});

describe('P-MC-S5 original Messages usage and final Chat SDK shape', () => {
  it('emits one full usage-only object before DONE without adding cumulative updates', () => {
    const stream = session(); const updates = [];
    const initial = start(); Object.assign(initial.message.usage, { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    updates.push(...stream.push(frame(initial)).usageUpdates);
    updates.push(...stream.push(frame({ type: 'message_delta', delta: { stop_reason: null, stop_sequence: null }, usage: { output_tokens: 3 } })).usageUpdates);
    const final = { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } };
    updates.push(...stream.push(frame(final)).usageUpdates);
    expect(stream.push(frame(final)).usageUpdates).toEqual([]);
    const end = stream.push(frame({ type: 'message_stop' }));
    expect(end.usage).toMatchObject({ quality: 'complete', protocol: 'messages', counts: { inputTokens: 8, outputTokens: 5 } });
    expect(updates.map(update => update.sequence)).toEqual([1, 2, 3]);
    expect(updates.every(update => update.mode === 'cumulative')).toBe(true);
    expect(JSON.parse(end.events[0]!.data).choices[0].finish_reason).toBe('stop');
    expect(JSON.parse(end.events[1]!.data)).toEqual({ id: 'resp_test-response', object: 'chat.completion.chunk', created: 123, model: 'public-model', choices: [],
      usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13, prompt_tokens_details: { cached_tokens: 0 } } });
    expect(end.events[2]!.data).toBe('[DONE]');
    expect(stream.finish({ kind: 'eof' })).not.toHaveProperty('usage');
  });

  it('maps reported cache/reasoning counters without altering raw billing counts', () => {
    const stream = session();
    const first = start(); Object.assign(first.message.usage, { cache_creation_input_tokens: 2, cache_read_input_tokens: 3 });
    stream.push(frame(first));
    stream.push(frame({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5, output_tokens_details: { thinking_tokens: 2 } } }));
    const end = stream.push(frame({ type: 'message_stop' }));
    expect(end.usage).toMatchObject({ protocol: 'messages', counts: { inputTokens: 8, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 2 } });
    expect(JSON.parse(end.events[1]!.data).usage).toEqual({ prompt_tokens: 13, completion_tokens: 5, total_tokens: 18,
      prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } });
  });

  it('omits wire usage rather than inventing zero core counters', () => {
    const stream = session(); const initial = start(); delete (initial.message as { usage?: unknown }).usage;
    stream.push(frame(initial));
    stream.push(frame({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }));
    const end = stream.push(frame({ type: 'message_stop' }));
    expect(end.usage).toMatchObject({ quality: 'partial', counts: { outputTokens: 5 } });
    expect(end.events.filter(event => event.data !== '[DONE]').some(event => Object.hasOwn(JSON.parse(event.data), 'usage'))).toBe(false);
  });
});

describe('P-MC-S6 unsigned thinking and extension boundaries', () => {
  it('maps an explicitly unsigned thinking block to Chat reasoning_content', () => {
    const stream = session(); stream.push(frame(start()));
    const opened = stream.push(frame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }));
    expect(opened.events).toEqual([]);
    const delta = stream.push(frame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } }));
    expect(JSON.parse(delta.events[0]!.data).choices[0].delta).toEqual({ reasoning_content: 'plan' });
    expect(stream.push(frame({ type: 'content_block_stop', index: 0 })).events).toEqual([]);
    stream.push(frame({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } }));
    const end = stream.push(frame({ type: 'message_stop' }));
    expect(end.terminal).toMatchObject({ status: 'completed', reason: 'stop' });
    expect(end.events.at(-1)?.data).toBe('[DONE]');
  });

  it('rejects signed, redacted and reordered thinking instead of fabricating a signature or text', () => {
    const signed = session(); signed.push(frame(start()));
    const signedResult = signed.push(frame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: 'opaque-signature' } }));
    expect(signedResult.terminal?.status).toBe('failed'); expect(JSON.stringify(signedResult)).not.toContain('opaque-signature');
    const redacted = session(); redacted.push(frame(start()));
    expect(redacted.push(frame({ type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'opaque' } })).terminal?.status).toBe('failed');
    const reordered = session(); reordered.push(frame(start())); reordered.push(frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })); reordered.push(frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } })); reordered.push(frame({ type: 'content_block_stop', index: 0 }));
    expect(reordered.push(frame({ type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: 'late', signature: '' } })).terminal?.status).toBe('failed');
  });

  it('keeps thinking and extension state bounded under explicit policy', () => {
    const oversized = session(); oversized.push(frame(start()));
    expect(oversized.push(frame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'x'.repeat(20_000), signature: '' } })).terminal?.status).toBe('failed');
    expect(session({ ...options, unknownEventPolicy: 'ignore' }).push(frame({ type: 'vendor.future_event' }))).toEqual({ events: [], usageUpdates: [] });
    expect(session({ ...options, unknownEventPolicy: 'preserve' }).push(frame({ type: 'vendor.future_event' })).terminal?.status).toBe('failed');
  });
});
