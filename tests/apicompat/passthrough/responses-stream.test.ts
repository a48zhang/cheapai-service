import { describe, expect, it, vi } from 'vitest';
import { createResponsesStreamSession, streamResponsesPassthrough } from '../../../packages/apicompat/passthrough/responses-stream.js';
import type { ResponseContext, StreamOptions } from '../../../packages/apicompat/types/adapter.js';
import { SseByteParser } from '../../../packages/apicompat/streams/parser.js';

const context: ResponseContext = { targetModel: 'public', identity: { responseId: 'resp_public', upstreamResponseId: 'resp_native' }, createdAt: 0,
  idFor() { throw new Error('G13, not this adapter, resolves history references'); } };
const options: StreamOptions = { unknownEventPolicy: 'reject', maxBufferedBytes: 16384 };
const response = { id: 'resp_native', object: 'response', created_at: 123, model: 'provider', status: 'in_progress', output: [], previous_response_id: 'original_channel_reference', usage: null };
const created = { type: 'response.created', response };
const part = { type: 'output_text', text: '', annotations: [] };
const message = { type: 'message', id: 'msg_native', role: 'assistant', status: 'in_progress', content: [] };
const finalPart = { ...part, text: '你好🧭' };
const finalMessage = { ...message, status: 'completed', content: [finalPart] };
const usage = { input_tokens: 3, output_tokens: 4, total_tokens: 7, input_tokens_details: { cached_tokens: 2 } };
const completed = { type: 'response.completed', response: { ...response, status: 'completed', output: [finalMessage], usage } };
const textEvents = [created,
  { type: 'response.output_item.added', output_index: 0, item: message },
  { type: 'response.content_part.added', output_index: 0, item_id: message.id, content_index: 0, part },
  { type: 'response.output_text.delta', output_index: 0, item_id: message.id, content_index: 0, delta: '你好🧭' },
  { type: 'response.output_text.done', output_index: 0, item_id: message.id, content_index: 0, text: '你好🧭' },
  { type: 'response.content_part.done', output_index: 0, item_id: message.id, content_index: 0, part: finalPart },
  { type: 'response.output_item.done', output_index: 0, item: finalMessage }, completed];
const frame = (event: { type: string }, sequence_number: number) => ({ event: event.type, data: JSON.stringify({ ...event, sequence_number }) });
function session(config = options) { const result = createResponsesStreamSession(context, config); if (!result.ok) throw new Error('Invalid test config'); return result.value; }

describe('Responses same-protocol streaming lifecycle', () => {
  it('emits text/item events immediately with root public identity and unchanged native references', () => {
    const stream = session();
    for (const [i, event] of textEvents.entries()) {
      const step = stream.push(frame(event, i));
      expect(step.events).toHaveLength(1);
      const actual = JSON.parse(step.events[0]!.data);
      expect(actual.sequence_number).toBe(i);
      if ('response' in event) expect(actual.response).toEqual({ ...event.response, id: 'resp_public', model: 'public' });
      else expect(actual).toEqual({ ...event, sequence_number: i });
      if (i < textEvents.length - 1) expect(step.terminal).toBeUndefined();
      else expect(step).toMatchObject({ terminal: { status: 'completed', reason: 'stop' }, usageUpdates: [{ final: true, mode: 'cumulative' }],
        usage: { quality: 'complete', counts: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 2 } } });
    }
    expect(stream.push(frame(completed, 999))).toEqual({ events: [], usageUpdates: [] });
    expect(stream.finish({ kind: 'eof' }).terminal).toBeUndefined();
  });

  it('preserves interleaved reasoning summary, encrypted reasoning and function-call identity/arguments', () => {
    const reasoning = { type: 'reasoning', id: 'rs_native', summary: [], status: 'in_progress' };
    const tool = { type: 'function_call', id: 'fc_native', call_id: 'call_native', name: 'lookup', arguments: '', status: 'in_progress' };
    const summary = { type: 'summary_text', text: '' };
    const finalReasoning = { ...reasoning, status: 'completed', summary: [{ ...summary, text: 'Summary' }], encrypted_content: 'opaque-native' };
    const finalTool = { ...tool, status: 'completed', arguments: '{"x":1}' };
    const events = [created,
      { type: 'response.output_item.added', output_index: 0, item: reasoning }, { type: 'response.output_item.added', output_index: 1, item: tool },
      { type: 'response.reasoning_summary_part.added', output_index: 0, item_id: reasoning.id, summary_index: 0, part: summary },
      { type: 'response.function_call_arguments.delta', output_index: 1, item_id: tool.id, delta: '{"x":' },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: reasoning.id, summary_index: 0, delta: 'Summary' },
      { type: 'response.function_call_arguments.delta', output_index: 1, item_id: tool.id, delta: '1}' },
      { type: 'response.function_call_arguments.done', output_index: 1, item_id: tool.id, arguments: '{"x":1}', name: 'lookup' },
      { type: 'response.output_item.done', output_index: 1, item: finalTool },
      { type: 'response.reasoning_summary_text.done', output_index: 0, item_id: reasoning.id, summary_index: 0, text: 'Summary' },
      { type: 'response.reasoning_summary_part.done', output_index: 0, item_id: reasoning.id, summary_index: 0, part: { ...summary, text: 'Summary' } },
      { type: 'response.output_item.done', output_index: 0, item: finalReasoning },
      { type: 'response.completed', response: { ...response, status: 'completed', output: [finalReasoning, finalTool], usage } },
    ];
    const stream = session();
    for (const [i, event] of events.entries()) {
      const step = stream.push(frame(event, i));
      expect(step.events[0]!.event).toBe(event.type);
      if (!('response' in event)) expect(JSON.parse(step.events[0]!.data)).toEqual({ ...event, sequence_number: i });
      if (i === events.length - 1) expect(step.terminal).toMatchObject({ status: 'completed', reason: 'tool_calls' });
    }
  });

  it('preserves refusal blocks while terminal metadata remains refusal', () => {
    const stream = session(); const refusal = { type: 'refusal', refusal: 'No' };
    const final = { ...message, status: 'completed', content: [refusal] };
    const events = [created, { type: 'response.output_item.added', output_index: 0, item: message },
      { type: 'response.content_part.added', output_index: 0, item_id: message.id, content_index: 0, part: { type: 'refusal', refusal: '' } },
      { type: 'response.refusal.delta', output_index: 0, item_id: message.id, content_index: 0, delta: 'No' },
      { type: 'response.refusal.done', output_index: 0, item_id: message.id, content_index: 0, refusal: 'No' },
      { type: 'response.content_part.done', output_index: 0, item_id: message.id, content_index: 0, part: refusal },
      { type: 'response.output_item.done', output_index: 0, item: final },
      { type: 'response.completed', response: { ...response, status: 'completed', output: [final] } }];
    let last; for (const [i, event] of events.entries()) last = stream.push(frame(event, i));
    expect(last?.terminal).toMatchObject({ status: 'incomplete', reason: 'refusal' });
    expect(last?.usage).toMatchObject({ quality: 'missing' });
  });

  it('accepts native incomplete/failed endings with open items and sanitizes failure bodies', () => {
    for (const status of ['incomplete', 'failed']) {
      const stream = session(); stream.push(frame(created, 0)); stream.push(frame(textEvents[1]!, 1));
      const ending = { ...response, status, output: [{ ...message, status: 'incomplete' }], usage,
        ...(status === 'failed' ? { error: { code: 'SECRET', message: 'Bearer SECRET' } } : { incomplete_details: { reason: 'max_output_tokens' } }) };
      const step = stream.push(frame({ type: `response.${status}`, response: ending } as typeof completed, 2));
      expect(step.terminal?.status).toBe(status);
      expect(step.usage).toMatchObject({ counts: { outputTokens: 4 } });
      expect(JSON.stringify(step)).not.toContain('SECRET');
    }
  });

  it.each([
    [textEvents[1]!], [created, created], [created, textEvents[3]!], [created, textEvents[1]!, completed],
    [created, { ...textEvents[1]!, output_index: 3 }],
    [created, textEvents[1]!, textEvents[2]!, textEvents[5]!],
    [created, textEvents[1]!, { ...textEvents[2]!, item_id: 'wrong' }],
    [created, completed],
  ].map(events => ({ events })))('rejects bad item/content order or duplicate start %#', ({ events }) => {
    const stream = session(); let failed = false;
    for (const [i, event] of events.entries()) {
      const step = stream.push(frame(event, i)); if (step.terminal?.status === 'failed') failed = true;
    }
    expect(failed).toBe(true);
  });

  it('does not accept a completed root response that still contains an incomplete item', () => {
    const stream = session();
    for (const [i, event] of textEvents.slice(0, -1).entries()) stream.push(frame(event, i));
    expect(stream.push(frame({ ...completed, response: { ...completed.response, output: [{ ...finalMessage, status: 'incomplete' }] } }, 99)).terminal?.status).toBe('failed');
  });

  it('rejects regressed sequence numbers, terminal mismatches and preserves extension fields', () => {
    const repeated = session(); repeated.push(frame(created, 2)); expect(repeated.push(frame(textEvents[1]!, 2)).terminal?.status).toBe('failed');
    const mismatched = session(); mismatched.push(frame(created, 0));
    expect(mismatched.push(frame({ ...completed, response: { ...completed.response, id: 'other' } }, 1)).terminal?.status).toBe('failed');
    expect(session().push(frame({ ...created, headers: { authorization: 'SECRET' } }, 0)).terminal).toBeUndefined();
    expect(session({ ...options, unknownEventPolicy: 'ignore' }).push(frame({ type: 'vendor.event' }, 0))).toEqual({ events: [], usageUpdates: [] });
    expect(session({ ...options, unknownEventPolicy: 'preserve' }).push(frame({ type: 'vendor.event' }, 0)).terminal).toBeUndefined();
  });

  it('bounds retained item state and never treats DONE or EOF as native completion', () => {
    const stream = session({ ...options, maxBufferedBytes: 400 }); stream.push(frame(created, 0));
    let step; for (let i = 0; i < 8; i++) {
      step = stream.push(frame({ type: 'response.output_item.added', output_index: i, item: { ...message, id: `item_${i}` } }, i + 1));
      if (step.terminal) break;
    }
    expect(step?.terminal?.status).toBe('failed');
    const eof = session(); eof.push(frame(created, 0)); expect(eof.finish({ kind: 'eof' }).terminal).toEqual({ status: 'incomplete', reason: 'unexpected_eof' });
    expect(session().push({ data: '[DONE]' }).terminal?.status).toBe('failed');
    expect(session().finish({ kind: 'cancelled' })).toMatchObject({ events: [], terminal: { status: 'cancelled' } });
  });
});

describe('Responses incremental SSE bytes', () => {
  const encode = (event: { type: string }, sequence: number) => new TextEncoder().encode(`event: ${event.type}\r\ndata: ${frame(event, sequence).data}\r\n\r\n`);
  it('outputs valid SSE on single-byte splits with stable item IDs and a single terminal', async () => {
    const data = textEvents.flatMap((event, i) => [...encode(event, i)]); let at = 0;
    const source = new ReadableStream<Uint8Array>({ pull(c) { if (at < data.length) c.enqueue(Uint8Array.of(data[at++]!)); else c.close(); } }, { highWaterMark: 0 });
    const parser = new SseByteParser(); const frames = []; const terminals = [];
    for await (const step of streamResponsesPassthrough(source, context, options)) { frames.push(...parser.push(step.bytes)); if (step.terminal) terminals.push(step.terminal); }
    expect(frames).toHaveLength(textEvents.length); expect(terminals).toHaveLength(1);
    expect(JSON.parse(frames[3]!.data).delta).toBe('你好🧭');
    expect(JSON.parse(frames.at(-1)!.data).response.previous_response_id).toBe('original_channel_reference');
  });

  it('does not prefetch during a slow consumer and closes its source on early return', async () => {
    let reads = 0; const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ pull(c) { reads++; c.enqueue(encode(created, 0)); }, cancel }, { highWaterMark: 0 });
    const output = streamResponsesPassthrough(source, context, options); await output.next();
    for (let i = 0; i < 10; i++) await Promise.resolve(); expect(reads).toBe(1);
    await output.return(); expect(cancel).toHaveBeenCalledOnce(); expect(source.locked).toBe(false);
  });

  it('cancels a pending read without completion and treats a partial final frame as EOF', async () => {
    const abort = new AbortController(); const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const output = streamResponsesPassthrough(source, context, options, abort.signal); const pending = output.next(); abort.abort();
    expect((await pending).value).toMatchObject({ terminal: { status: 'cancelled' } }); await output.return(); expect(cancel).toHaveBeenCalledOnce();
    const partial = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('event: response.completed\ndata: {')); c.close(); } });
    const steps = []; for await (const step of streamResponsesPassthrough(partial, context, options)) steps.push(step);
    expect(steps.at(-1)?.terminal).toEqual({ status: 'incomplete', reason: 'unexpected_eof' });
  });
});
