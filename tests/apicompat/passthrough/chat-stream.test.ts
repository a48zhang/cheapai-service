import { describe, expect, it, vi } from 'vitest';
import { createChatStreamSession, streamChatPassthrough } from '../../../packages/apicompat/passthrough/chat-stream.js';
import type { ResponseContext, StreamOptions } from '../../../packages/apicompat/types/adapter.js';
import { SseByteParser } from '../../../packages/apicompat/streams/parser.js';

const context: ResponseContext = { targetModel: 'public', identity: { responseId: 'chat_public', upstreamResponseId: 'upstream' }, createdAt: 0,
  idFor() { throw new Error('Keep native tool IDs'); } };
const options: StreamOptions = { unknownEventPolicy: 'reject', maxBufferedBytes: 8192 };
const base = { id: 'upstream', object: 'chat.completion.chunk', model: 'provider', created: 123 };
const choice = (delta: object, finish_reason: string | null = null, index = 0) => ({ index, delta, finish_reason });
const payload = (...choices: object[]) => ({ ...base, choices });
const frame = (value: unknown) => ({ data: JSON.stringify(value) });
function session(config = options) {
  const created = createChatStreamSession(context, config); if (!created.ok) throw new Error('Bad config'); return created.value;
}
const encode = (data: string) => new TextEncoder().encode(`data: ${data}\r\n\r\n`);

describe('Chat native stream session', () => {
  it('immediately maps public identity while preserving text/reasoning/refusal aliases and timestamp', () => {
    const stream = session();
    const raw = payload(choice({ role: 'assistant', reasoning_content: 'native thought', content: '你好🧭' }));
    const step = stream.push(frame(raw));
    expect(JSON.parse(step.events[0]!.data)).toEqual({ ...raw, id: 'chat_public', model: 'public' });
    expect(step.terminal).toBeUndefined();
    expect(raw.id).toBe('upstream');
  });

  it('allows final usage-only chunk after choice finish and waits for DONE before one terminal', () => {
    const stream = session(); stream.push(frame(payload(choice({ content: 'x' }))));
    expect(stream.push(frame(payload(choice({}, 'stop')))).terminal).toBeUndefined();
    const raw = { ...base, choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } };
    expect(stream.push(frame(raw))).toMatchObject({ usageUpdates: [{ mode: 'cumulative', counts: { inputTokens: 3, outputTokens: 4 }, final: true }] });
    const done = stream.push({ data: '[DONE]' });
    expect(done).toMatchObject({ events: [{ data: '[DONE]' }], terminal: { status: 'completed', reason: 'stop' }, usage: { counts: { outputTokens: 4 } } });
    expect(stream.push({ data: '[DONE]' })).toEqual({ events: [], usageUpdates: [] });
    expect(stream.finish({ kind: 'eof' }).terminal).toBeUndefined();
  });

  it('missing DONE is unexpected EOF even after final usage; missing usage is not zero', () => {
    const stream = session(); stream.push(frame(payload(choice({}, 'stop'))));
    expect(stream.finish({ kind: 'eof' })).toMatchObject({ terminal: { status: 'incomplete', reason: 'unexpected_eof' }, usage: { quality: 'missing' } });
    const onlyUsage = session(); onlyUsage.push(frame(payload(choice({}, 'stop'))));
    onlyUsage.push(frame({ ...base, choices: [], usage: { prompt_tokens: 2, completion_tokens: 5 } }));
    expect(onlyUsage.finish({ kind: 'eof' })).toMatchObject({ terminal: { status: 'incomplete', reason: 'unexpected_eof' }, usage: { counts: { outputTokens: 5 } } });
  });

  it('handles interleaved tools/choices and does not parse each argument fragment', () => {
    const stream = session();
    const first = payload(choice({ tool_calls: [{ index: 1, id: 't1', type: 'function', function: { name: 'lookup', arguments: '{"q":' } },
      { index: 0, id: 't0', type: 'function', function: { name: 'other', arguments: '{' } }] }), choice({ content: 'other answer' }, null, 1));
    expect(stream.push(frame(first)).events).toHaveLength(1);
    expect(stream.push(frame(payload(choice({ tool_calls: [{ index: 0, function: { arguments: '}' } }, { index: 1, function: { arguments: '"中"}' } }] }, 'tool_calls'),
      choice({}, 'length', 1)))).terminal).toBeUndefined();
    expect(stream.push({ data: '[DONE]' }).terminal).toMatchObject({ status: 'incomplete', reason: 'length' });
  });

  it('truncated tool JSON remains incomplete rather than fabricated completion', () => {
    const stream = session();
    stream.push(frame(payload(choice({ tool_calls: [{ index: 0, id: 't', function: { name: 'f', arguments: '{' } }] }, 'length'))));
    expect(stream.push({ data: '[DONE]' }).terminal).toMatchObject({ status: 'incomplete', reason: 'length' });
  });

  it.each([
    [frame({ ...base, choices: [], usage: { prompt_tokens: 1 } })], [{ data: '[DONE]' }],
    [frame(payload(choice({ content: 'x' }))), { data: '[DONE]' }],
    [frame(payload(choice({}, 'stop'))), frame(payload(choice({ content: 'late' })))],
    [frame(payload(choice({}, 'stop'))), frame({ ...payload(choice({})), id: 'different' })],
    [frame(payload(choice({ tool_calls: [{ index: 0, id: 't', function: { name: 'f', arguments: '{' } }] }, 'tool_calls')))],
    [frame({ ...payload(choice({})), authorization: 'SECRET' })],
  ].map(frames => ({ frames })))('rejects bad chunks/lifecycle %#', ({ frames }) => {
    const stream = session(); let step;
    for (const input of frames) step = stream.push(input);
    expect(step?.terminal?.status).toBe('failed'); expect(JSON.stringify(step)).not.toContain('SECRET');
  });

  it('bounds retained choice/tool state and keeps cancellation/errors separate', () => {
    const bounded = session({ ...options, maxBufferedBytes: 400 });
    let step;
    for (let i = 0; i < 10; i++) { step = bounded.push(frame(payload(choice({}, null, i)))); if (step.terminal) break; }
    expect(step?.terminal?.status).toBe('failed');
    expect(session().finish({ kind: 'cancelled' })).toMatchObject({ events: [], terminal: { status: 'cancelled' } });
    const failed = session().push(frame({ error: { message: 'SECRET' } }));
    expect(failed.terminal?.status).toBe('failed'); expect(JSON.stringify(failed)).not.toContain('SECRET');
    expect(session({ ...options, unknownEventPolicy: 'ignore' }).push({ event: 'vendor_ping', data: '{}' }).events).toEqual([]);
  });
});

describe('Chat SSE bytes and pull behavior', () => {
  it('parses arbitrary UTF-8 bytes, preserves usage-only frames and emits one DONE', async () => {
    const inputs = [payload(choice({ content: '你好🧭' })), payload(choice({}, 'stop')), { ...base, choices: [], usage: { prompt_tokens: 2, completion_tokens: 4 } }];
    const all = new TextEncoder().encode(inputs.map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n');
    let at = 0; const parser = new SseByteParser(); const frames = []; const terminals = [];
    const source = new ReadableStream<Uint8Array>({ pull(c) { if (at < all.length) c.enqueue(all.subarray(at, ++at)); else c.close(); } }, { highWaterMark: 0 });
    for await (const step of streamChatPassthrough(source, context, options)) { frames.push(...parser.push(step.bytes)); if (step.terminal) terminals.push(step.terminal); }
    expect(frames.at(-1)?.data).toBe('[DONE]'); expect(frames).toHaveLength(4); expect(terminals).toHaveLength(1);
    expect(JSON.parse(frames[0]!.data).choices[0].delta.content).toBe('你好🧭');
  });

  it('does not prefetch while consumer waits and closes on cancel', async () => {
    let reads = 0; const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ pull(c) { reads++; c.enqueue(encode(JSON.stringify(payload(choice({ content: 'x' }))))); }, cancel }, { highWaterMark: 0 });
    const output = streamChatPassthrough(source, context, options); await output.next();
    for (let i = 0; i < 10; i++) await Promise.resolve(); expect(reads).toBe(1);
    await output.return(); expect(cancel).toHaveBeenCalledOnce(); expect(source.locked).toBe(false);
  });

  it('abort and a truncated DONE frame never emit a successful terminal', async () => {
    const abort = new AbortController(); const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const output = streamChatPassthrough(source, context, options, abort.signal); const pending = output.next(); abort.abort();
    expect((await pending).value).toMatchObject({ terminal: { status: 'cancelled' } }); await output.return(); expect(cancel).toHaveBeenCalledOnce();
    const incomplete = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('data: [DONE]')); c.close(); } });
    const steps = []; for await (const step of streamChatPassthrough(incomplete, context, options)) steps.push(step);
    expect(steps.at(-1)?.terminal).toEqual({ status: 'incomplete', reason: 'unexpected_eof' });
  });
});
