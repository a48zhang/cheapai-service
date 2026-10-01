/** SPDX-License-Identifier: LGPL-3.0-only
 * Independent synthetic fixtures for the direct Chat -> Messages stream
 * adapter. Behavioral reference and fixed upstream attribution are recorded
 * in the implementation file and docs/protocol-baseline.md.
 */
import { describe, expect, it, vi } from 'vitest';
import { createChatToMessagesSession, streamChatToMessages } from '../../../packages/apicompat/streams/chat-to-messages.js';
import { createMessagesStreamSession } from '../../../packages/apicompat/passthrough/messages-stream.js';
import type { ResponseContext, StreamOptions } from '../../../packages/apicompat/types/adapter.js';
const context: ResponseContext = { targetModel: 'public', identity: { responseId: 'msg_public', upstreamResponseId: 'chat_native' }, createdAt: 0, idFor() { throw new Error('No block IDs needed'); } };
const options: StreamOptions = { unknownEventPolicy: 'reject', maxBufferedBytes: 4096 };
const frame = (delta: object, finish_reason: string | null = null, usage?: object) => ({ data: JSON.stringify({ id: 'chat_native', object: 'chat.completion.chunk', model: 'native', created: 0, choices: [{ index: 0, delta, finish_reason }], ...(usage === undefined ? {} : { usage }) }) });
function session(config = options) { const result = createChatToMessagesSession(context, config); if (!result.ok) throw new Error('Config'); return result.value; }

describe('CM-S1 incremental text lifecycle', () => {
  it('emits one native block immediately and finishes in Messages order at DONE', () => {
    const stream = session(); const frames = [];
    const first = stream.push(frame({ content: '你好' }));
    expect(first.events.map(frame => frame.event)).toEqual(['message_start', 'content_block_start', 'content_block_delta']);
    expect(first.terminal).toBeUndefined(); frames.push(...first.events);
    frames.push(...stream.push(frame({ content: '🧭' }, 'stop')).events);
    const last = stream.push({ data: '[DONE]' }); frames.push(...last.events);
    expect(last.events.map(frame => frame.event)).toEqual(['content_block_stop', 'message_delta', 'message_stop']);
    expect(last.terminal).toMatchObject({ status: 'completed' });
    const target = createMessagesStreamSession({ ...context, identity: { responseId: 'msg_public', upstreamResponseId: 'msg_public' } }, options);
    if (!target.ok) throw new Error('Target config');
    for (const value of frames) expect(target.value.push(value).terminal?.status).not.toBe('failed');
    expect(JSON.parse(first.events[0]!.data).message).toMatchObject({ id: 'msg_public', model: 'public' });
    expect(JSON.parse(first.events[0]!.data).message.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(last.usage).toEqual({ quality: 'missing', protocol: 'chat' });
    expect(stream.push({ data: '[DONE]' }).events).toEqual([]);
  });
  it('empty text does not create a phantom content block', () => {
    const stream = session(); expect(stream.push(frame({ content: '' }, 'stop')).events.map(frame => frame.event)).toEqual(['message_start']);
    expect(stream.push({ data: '[DONE]' }).events.map(frame => frame.event)).toEqual(['message_delta', 'message_stop']);
  });
  it('produces a simple text stream accepted by the native Messages lifecycle validator', () => {
    const stream = session(); const output = [];
    output.push(...stream.push(frame({ content: 'ok' })).events);
    output.push(...stream.push(frame({}, 'stop')).events);
    output.push(...stream.push({ data: '[DONE]' }).events);
    const target = createMessagesStreamSession({ ...context, identity: { responseId: 'msg_public', upstreamResponseId: 'msg_public' } }, options);
    if (!target.ok) throw new Error('Target configuration');
    for (const event of output) expect(target.value.push(event).terminal?.status).not.toBe('failed');
  });
  it('maps unsigned reasoning to an explicitly unsigned thinking block', () => {
    const first = session().push(frame({ reasoning_content: 'thought' }));
    expect(first.events.map(value => value.event)).toEqual(['message_start', 'content_block_start', 'content_block_delta']);
    expect(JSON.parse(first.events[1]!.data).content_block).toEqual({ type: 'thinking', thinking: '', signature: '' });
    expect(JSON.parse(first.events[2]!.data).delta).toEqual({ type: 'thinking_delta', thinking: 'thought' });
  });
  it('keeps refusal out of ordinary text and reports it as a refusal stop detail', () => {
    const stream = session(); stream.push(frame({ refusal: 'No' }, 'stop'));
    const done = stream.push({ data: '[DONE]' });
    expect(done.terminal).toMatchObject({ status: 'incomplete', reason: 'refusal' });
    const delta = JSON.parse(done.events.at(-2)!.data);
    expect(delta.delta).toMatchObject({ stop_reason: 'refusal', stop_details: { type: 'refusal', explanation: 'No' } });
    expect(JSON.stringify(done.events)).not.toContain('text_delta');
  });
  it('does not manufacture normal completion at transport EOF', () => {
    const stream = session(); stream.push(frame({ content: 'partial' }, 'stop'));
    const eof = stream.finish({ kind: 'eof' }); expect(eof.terminal).toEqual({ status: 'incomplete', reason: 'unexpected_eof' });
    expect(eof.events.map(frame => frame.event)).not.toContain('message_stop');
  });
  it('does not buffer the whole text or read ahead while the consumer pauses', async () => {
    let reads = 0; const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ pull(c) { reads++; c.enqueue(new TextEncoder().encode(`data: ${frame({ content: 'x' }).data}\n\n`)); }, cancel }, { highWaterMark: 0 });
    const output = streamChatToMessages(source, context, options); expect((await output.next()).value?.bytes.length).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) await Promise.resolve(); expect(reads).toBe(1);
    await output.return(); expect(cancel).toHaveBeenCalledOnce();
  });
});

describe('CM-S2 single tool fragments', () => {
  it('emits argument fragments immediately and closes one valid tool block once', () => {
    const stream = session();
    const first = stream.push(frame({ tool_calls: [{ index: 4, id: 'call_lookup', function: { name: 'lookup', arguments: '{"q":' } }] }));
    expect(first.events.map(value => value.event)).toEqual(['message_start', 'content_block_start', 'content_block_delta']);
    expect(JSON.parse(first.events.at(-1)!.data).delta).toEqual({ type: 'input_json_delta', partial_json: '{"q":' });
    const second = stream.push(frame({ tool_calls: [{ index: 4, function: { arguments: '"中"}' } }] }, 'tool_calls'));
    expect(JSON.parse(second.events.at(-1)!.data).delta).toEqual({ type: 'input_json_delta', partial_json: '"中"}' });
    const done = stream.push({ data: '[DONE]' });
    expect(done.terminal).toMatchObject({ status: 'completed', reason: 'tool_calls' });
    expect(done.events.map(value => value.event)).toEqual(['content_block_stop', 'message_delta', 'message_stop']);
    expect(JSON.parse(done.events[1]!.data).delta.stop_reason).toBe('tool_use');
  });

  it('buffers fragments until a late identity is known without parsing fragments', () => {
    const stream = session();
    const pending = stream.push(frame({ tool_calls: [{ index: 0, function: { arguments: '{"x":' } }] }));
    expect(pending.events.map(value => value.event)).toEqual(['message_start']);
    const ready = stream.push(frame({ tool_calls: [{ index: 0, id: 'late_call', function: { name: 'f', arguments: '1}' } }] }, 'tool_calls'));
    expect(ready.events.map(value => value.event)).toEqual(['content_block_start', 'content_block_delta']);
    expect(JSON.parse(ready.events[1]!.data).delta.partial_json).toBe('{"x":1}');
  });
});

describe('CM-S3 parallel tool fragments and block identity', () => {
  it.each([[0, 1, 0, 1], [1, 0, 1, 0]].map(order => ({ order })))('keeps arbitrary tool interleaving associated %#', ({ order }) => {
    const stream = session(); const seen = new Set<number>(); const events = [];
    for (const index of order) {
      const first = !seen.has(index); seen.add(index);
      events.push(...stream.push(frame({ content: '', tool_calls: [{ index,
        ...(first ? { id: `call_${index}` } : {}), function: { ...(first ? { name: `f${index}` } : {}), arguments: first ? '{"v":' : `${index}}` } }] })).events);
    }
    stream.push(frame({}, 'tool_calls'));
    const done = stream.push({ data: '[DONE]' }); events.push(...done.events);
    const starts = events.filter(value => value.event === 'content_block_start').map(value => JSON.parse(value.data));
    expect(starts.map(value => value.content_block.id)).toEqual(order.filter((value, index) => order.indexOf(value) === index).map(value => `call_${value}`));
    const deltas = new Map<string, string>();
    for (const value of events.filter(item => item.event === 'content_block_delta')) {
      const parsed = JSON.parse(value.data); const block = starts.find(start => start.index === parsed.index);
      if (block) deltas.set(block.content_block.id, (deltas.get(block.content_block.id) ?? '') + parsed.delta.partial_json);
    }
    expect(deltas.get('call_0')).toBe('{"v":0}'); expect(deltas.get('call_1')).toBe('{"v":1}');
    expect(done.events.filter(value => value.event === 'content_block_stop')).toHaveLength(2);
    expect(JSON.parse(done.events.at(-2)!.data).delta.stop_reason).toBe('tool_use');
  });
});

describe('CM-S4 truncation, errors and cancellation', () => {
  it('maps a partial tool JSON length stop to max_tokens without claiming success', () => {
    const stream = session();
    stream.push(frame({ tool_calls: [{ index: 0, id: 'partial', function: { name: 'lookup', arguments: '{"x":' } }] }));
    stream.push(frame({}, 'length'));
    const done = stream.push({ data: '[DONE]' });
    expect(done.terminal).toMatchObject({ status: 'incomplete', reason: 'length' });
    expect(JSON.parse(done.events.at(-2)!.data).delta.stop_reason).toBe('max_tokens');
  });

  it('keeps content-filter, upstream error, EOF and cancellation distinct', () => {
    const filtered = session(); filtered.push(frame({ content: 'partial' }, 'content_filter'));
    const filterDone = filtered.push({ data: '[DONE]' });
    expect(filterDone.terminal).toMatchObject({ status: 'incomplete', reason: 'content_filter' });
    expect(filterDone.events.map(value => value.event)).toEqual(['error']);
    const failed = session().push({ data: JSON.stringify({ error: { message: 'private secret', type: 'server_error' } }) });
    expect(failed.terminal).toMatchObject({ status: 'failed', error: { kind: 'upstream_error' } });
    expect(JSON.stringify(failed.events)).not.toContain('private secret');
    expect(session().finish({ kind: 'eof' }).terminal).toEqual({ status: 'incomplete', reason: 'unexpected_eof' });
    const cancelled = session(); expect(cancelled.finish({ kind: 'cancelled' })).toMatchObject({ events: [], terminal: { status: 'cancelled' } });
  });

  it('propagates AbortSignal and does not fabricate message_stop', async () => {
    let cancelled = false; const controller = new AbortController();
    const bytes = new TextEncoder().encode(`data: ${frame({ content: 'x' }).data}\n\n`);
    const input = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); }, cancel() { cancelled = true; } });
    const output = streamChatToMessages(input, context, options, controller.signal);
    await output.next(); controller.abort();
    const end = await output.next();
    expect(cancelled).toBe(true); expect(end.value!.terminal?.status).toBe('cancelled');
    expect(new TextDecoder().decode(end.value!.bytes)).not.toContain('message_stop');
    await output.return();
  });
});

describe('CM-S5 original Chat usage evidence and target display', () => {
  const usageOnly = (usage: object) => ({ data: JSON.stringify({ id: 'chat_native', object: 'chat.completion.chunk', model: 'native', created: 0, choices: [], usage }) });

  it('keeps cumulative updates separate and maps exact final counters to Messages fields', () => {
    const stream = session();
    const first = stream.push(frame({ content: 'x' }, null, { prompt_tokens: 10, completion_tokens: 1 }));
    expect(first.usageUpdates[0]).toMatchObject({ mode: 'cumulative', counts: { inputTokens: 10, outputTokens: 1 }, final: false });
    stream.push(frame({}, 'stop'));
    const finalUsage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 1 } };
    const observed = stream.push(usageOnly(finalUsage));
    expect(observed.events).toEqual([]); expect(observed.usageUpdates).toMatchObject([{ final: true, counts: { inputTokens: 10, outputTokens: 3 } }]);
    const done = stream.push({ data: '[DONE]' });
    
    expect(done.usage).toMatchObject({ quality: 'complete', protocol: 'chat', counts: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 3 } });
    expect(JSON.parse(done.events[1]!.data).usage).toEqual({ output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens_details: { thinking_tokens: 1 }, input_tokens: 5 });
  });

  it('keeps the known inclusive input aggregate when cache details are absent', () => {
    const stream = session(); stream.push(frame({ content: 'x' }, 'stop')); stream.push(usageOnly({ prompt_tokens: 10, completion_tokens: 3 }));
    const done = stream.push({ data: '[DONE]' });
    expect(JSON.parse(done.events[1]!.data).usage).toEqual({ output_tokens: 3, input_tokens: 10 });
    expect(JSON.parse(done.events[1]!.data).usage).not.toHaveProperty('cache_read_input_tokens');
    expect(JSON.parse(done.events[1]!.data).usage).toMatchObject({ input_tokens: 10 });
  });

  it('keeps the official Messages SDK merge shape: start usage plus top-level delta usage', () => {
    const stream = session();
    const first = stream.push(frame({ content: 'x' }));
    stream.push(frame({}, 'stop'));
    stream.push(usageOnly({ prompt_tokens: 4, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }));
    const done = stream.push({ data: '[DONE]' });
    const startMessage = JSON.parse(first.events[0]!.data).message;
    const deltaEvent = JSON.parse(done.events[1]!.data);
    expect(startMessage).toHaveProperty('usage');
    expect(deltaEvent).toHaveProperty('usage');
    expect(deltaEvent.delta).not.toHaveProperty('usage');
    // Anthropic's MessageStream accumulator treats message_delta.usage as a
    // top-level cumulative update; this independent merge models that public
    // SDK contract and verifies no nested usage is emitted.
    const accumulated = { ...startMessage.usage, ...deltaEvent.usage };
    expect(accumulated).toMatchObject({ input_tokens: 4, output_tokens: 2 });
  });

  it('keeps a genuine zero-output completion monotonic through the wire placeholder', () => {
    const stream = session();
    const first = stream.push(frame({ content: '' }));
    stream.push(frame({}, 'stop'));
    stream.push(usageOnly({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }));
    const done = stream.push({ data: '[DONE]' });
    const startUsage = JSON.parse(first.events[0]!.data).message.usage;
    const finalUsage = JSON.parse(done.events.find(value => value.event === 'message_delta')!.data).usage;
    expect(startUsage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(finalUsage).toMatchObject({ input_tokens: 0, output_tokens: 0 });
    expect(done.usage).toMatchObject({ quality: 'complete', counts: { inputTokens: 0, outputTokens: 0 } });
  });

  it('shows the real Chat input total when cached_tokens is explicitly zero and write is absent', () => {
    const stream = session(); stream.push(frame({ content: 'x' })); stream.push(frame({}, 'stop'));
    stream.push(usageOnly({ prompt_tokens: 7, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } }));
    const done = stream.push({ data: '[DONE]' });
    const usage = JSON.parse(done.events.find(value => value.event === 'message_delta')!.data).usage;
    expect(usage).toEqual({ input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 0 });
  });
});

describe('CM-S6 thinking aliases and unknown extensions', () => {
  it('keeps equal reasoning aliases as thinking deltas without fabricating a signature', () => {
    const stream = session();
    const first = stream.push(frame({ reasoning_content: 'a', reasoning: 'a' }));
    const second = stream.push(frame({ reasoning: 'b' }, 'stop'));
    const thinking = [...first.events, ...second.events];
    expect(thinking.filter(value => value.event === 'content_block_start')).toHaveLength(1);
    expect(thinking.filter(value => value.event === 'content_block_delta').map(value => JSON.parse(value.data).delta.thinking).join('')).toBe('ab');
    expect(JSON.parse(thinking.find(value => value.event === 'content_block_start')!.data).content_block.signature).toBe('');
    const done = stream.push({ data: '[DONE]' }); expect(done.terminal).toMatchObject({ status: 'completed' });
  });

  it('rejects conflicting aliases and cannot preserve an unknown source event', () => {
    const conflict = session().push(frame({ reasoning_content: 'a', reasoning: 'b' }));
    expect(conflict.terminal).toMatchObject({ status: 'failed' });
    const ignored = session({ ...options, unknownEventPolicy: 'ignore' });
    expect(ignored.push({ event: 'ping', data: 'keep-alive' })).toEqual({ events: [], usageUpdates: [] });
    const rejected = session({ ...options, unknownEventPolicy: 'preserve' }).push({ event: 'ping', data: 'keep-alive' });
    expect(rejected.terminal).toMatchObject({ status: 'failed' });
  });
});
