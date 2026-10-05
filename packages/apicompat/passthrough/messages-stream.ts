import { encodeErrorSseFrame } from '../errors.js';
import { normalizeFinish } from '../finish-reasons.js';
import { BoundedByteBuffer, ByteBudget, readBoundedBytes } from '../streams/buffers.js';
import { SseByteParser } from '../streams/parser.js';
import type { ResponseContext, StreamEnd, StreamOptions, StreamStep } from '../types/adapter.js';
import { parseMessagesStreamEvent } from '../types/messages.js';
import type { ConversionResult, ProtocolError, SseFrame, TerminalState, UsageSnapshot, UsageUpdate } from '../types/shared.js';
import { createMessagesUsageSession } from '../usage/messages.js';

export interface MessagesStreamStep extends StreamStep<SseFrame> {
  readonly usageUpdates: readonly UsageUpdate[];
  /** Only present on the single terminal step; never bill converted output. */
  readonly usage?: UsageSnapshot;
}
export interface MessagesStreamSession {
  push(frame: SseFrame): MessagesStreamStep;
  finish(end: StreamEnd): MessagesStreamStep;
}
export interface MessagesStreamChunk extends Omit<MessagesStreamStep, 'events'> {
  readonly bytes: Uint8Array;
}

const types = new Set(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop', 'ping', 'error']);
const encoder = new TextEncoder();
const empty = (): MessagesStreamStep => ({ events: [], usageUpdates: [] });
const error = (code: string): ProtocolError => ({ kind: 'stream_error', code, message: 'The Messages stream could not be completed safely.' });

function makeSession(context: ResponseContext, options: StreamOptions, budget: ByteBudget): ConversionResult<MessagesStreamSession> {
  if (!Number.isSafeInteger(options.maxBufferedBytes) || options.maxBufferedBytes < 1 ||
    !['ignore', 'reject', 'preserve'].includes(options.unknownEventPolicy) ||
    typeof context.targetModel !== 'string' || !context.targetModel.trim() || context.targetModel.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(context.targetModel) || typeof context.identity.responseId !== 'string' ||
    !context.identity.responseId || context.identity.responseId.length > 128 || /[\u0000-\u0020\u007f]/u.test(context.identity.responseId)) {
    return { ok: false, error: error('invalid_stream_configuration') };
  }
  const targetModel = context.targetModel;
  const maxBufferedBytes = options.maxBufferedBytes;
  const responseId = context.identity.responseId;
  const upstreamId = context.identity.upstreamResponseId;
  const unknownPolicy = options.unknownEventPolicy;
  const usage = createMessagesUsageSession();
  const argumentsBuffer = new BoundedByteBuffer(budget);
  let started = false;
  let closed = false;
  let messageDeltas = false;
  let nextIndex = 0;
  let active: { index: number; type: string } | undefined;
  let pendingTerminal: TerminalState | undefined;
  let hasArgumentDeltas = false;

  function close(terminal: TerminalState, events: readonly SseFrame[] = [], updates: readonly UsageUpdate[] = []): MessagesStreamStep {
    closed = true;
    active = undefined;
    argumentsBuffer.cancel();
    return { events, terminal, usageUpdates: updates, usage: usage.finish(terminal) };
  }
  function fail(code: string): MessagesStreamStep {
    const problem = error(code);
    return close({ status: 'failed', error: problem }, [encodeErrorSseFrame('messages', problem)]);
  }
  return { ok: true, value: {
    push(frame) {
      if (closed) return empty();
      try {
        if (typeof frame.data !== 'string' || encoder.encode(frame.data).byteLength > maxBufferedBytes) return fail('frame_limit_exceeded');
        const raw: unknown = JSON.parse(frame.data);
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_event');
        const eventType = (raw as { type?: unknown }).type;
        if (typeof eventType !== 'string' || (frame.event !== undefined && frame.event !== eventType)) return fail('event_type_mismatch');
        if (!types.has(eventType)) {
          return unknownPolicy === 'preserve' ? { events: [frame], usageUpdates: [] } : unknownPolicy === 'ignore' ? empty() : fail('unsupported_event');
        }
        const parsed = parseMessagesStreamEvent(raw, { unknownFields: 'preserve', native: true });
        if (!parsed.ok) return fail('invalid_event');
        const event = parsed.value;
        if (event.type === 'error') return fail('upstream_error');
        if (event.type === 'ping') return { events: [{ event: 'ping', data: JSON.stringify(event) }], usageUpdates: [] };
        if (event.type === 'message_start') {
          if (started || event.message.content.length !== 0 || event.message.stop_reason !== null || event.message.stop_sequence !== null ||
            (upstreamId !== undefined && upstreamId !== event.message.id)) return fail('invalid_message_start');
          started = true;
          const updates = usage.push(event);
          const message = { ...event.message, id: responseId, model: targetModel };
          return { events: [{ event: event.type, data: JSON.stringify({ ...event, message }) }], usageUpdates: updates };
        }
        if (!started) return fail('missing_message_start');
        if (event.type === 'content_block_start') {
          if (messageDeltas || active || event.index !== nextIndex) return fail('invalid_block_order');
          active = { index: event.index, type: event.content_block.type };
          hasArgumentDeltas = false;
        } else if (event.type === 'content_block_delta') {
          if (!active || active.index !== event.index || messageDeltas) return fail('invalid_block_order');
          const expected = active.type === 'tool_use' ? ['input_json_delta']
            : active.type === 'thinking' ? ['thinking_delta', 'signature_delta']
            : active.type === 'text' ? ['text_delta', 'citations_delta'] : [];
          if (expected.length > 0 && !expected.includes(event.delta.type)) return fail('invalid_block_delta');
          if (event.delta.type === 'input_json_delta') {
            argumentsBuffer.appendText(event.delta.partial_json);
            hasArgumentDeltas ||= event.delta.partial_json.length > 0;
          }
        } else if (event.type === 'content_block_stop') {
          if (!active || active.index !== event.index || messageDeltas) return fail('invalid_block_order');
          if (hasArgumentDeltas) {
            const args: unknown = JSON.parse(new TextDecoder().decode(argumentsBuffer.drain()));
            if (args === null || typeof args !== 'object' || Array.isArray(args)) return fail('invalid_tool_arguments');
          }
          argumentsBuffer.clear();
          active = undefined;
          nextIndex += 1;
        } else if (event.type === 'message_delta') {
          if (active) return fail('unclosed_block');
          messageDeltas = true;
          if (event.delta.stop_reason !== null) {
            if (pendingTerminal) return fail('duplicate_stop_reason');
            const finish = normalizeFinish({ from: 'messages', rawReason: event.delta.stop_reason });
            if (!finish.ok) return fail('invalid_stop_reason');
            pendingTerminal = finish.value.terminal;
          }
        } else if (event.type === 'message_stop') {
          if (active || !pendingTerminal) return fail('missing_terminal_delta');
          return close(pendingTerminal, [{ event: event.type, data: JSON.stringify(event) }], usage.push(event));
        }
        return { events: [{ event: event.type, data: JSON.stringify(event) }], usageUpdates: usage.push(event) };
      } catch { return fail('invalid_or_oversized_event'); }
    },
    finish(end) {
      if (closed) return empty();
      if (end.kind === 'cancelled') return close({ status: 'cancelled' });
      if (end.kind === 'error') return fail('transport_error');
      const terminal: TerminalState = { status: 'incomplete', reason: 'unexpected_eof' };
      return close(terminal, [encodeErrorSseFrame('messages', error('unexpected_eof'))]);
    },
  } };
}

export function createMessagesStreamSession(context: ResponseContext, options: StreamOptions): ConversionResult<MessagesStreamSession> {
  if (!Number.isSafeInteger(options.maxBufferedBytes) || options.maxBufferedBytes < 1) return { ok: false, error: error('invalid_stream_configuration') };
  return makeSession(context, options, new ByteBudget(options.maxBufferedBytes));
}
export const messagesStreamAdapter = Object.freeze({ from: 'messages' as const, to: 'messages' as const, create: createMessagesStreamSession });

function chunk(step: MessagesStreamStep): MessagesStreamChunk {
  const { events, ...metadata } = step;
  return { ...metadata, bytes: encoder.encode(events.map(frame => `event: ${frame.event}\ndata: ${frame.data}\n\n`).join('')) };
}

/**
 * Incremental native SSE bytes + separate usage/terminal metadata, no fetch or
 * whole-response buffering. Shares P09 budget across the currently yielded input
 * chunk, incomplete frame and current tool arguments. Slow consumers cause no
 * additional reads. Oversized source chunks also fail closed under this budget.
 * EOF discards P08's residual frame; it never fabricates message_stop/success.
 */
export async function* streamMessagesPassthrough(
  source: ReadableStream<Uint8Array>, context: ResponseContext, options: StreamOptions, signal?: AbortSignal,
): AsyncGenerator<MessagesStreamChunk, void, unknown> {
  if (!Number.isSafeInteger(options.maxBufferedBytes) || options.maxBufferedBytes < 1) throw new TypeError('Invalid Messages stream configuration');
  const budget = new ByteBudget(options.maxBufferedBytes);
  const created = makeSession(context, options, budget);
  if (!created.ok) throw new TypeError('Invalid Messages stream configuration');
  const session = created.value;
  const parser = new SseByteParser();
  const frameBuffer = new BoundedByteBuffer(budget);
  let lineHasContent = false;
  let skipLf = false;
  try {
    for await (const bytes of readBoundedBytes(source, budget, signal)) {
      let start = 0;
      for (let index = 0; index < bytes.length; index += 1) {
        if (signal?.aborted) { yield chunk(session.finish({ kind: 'cancelled' })); return; }
        const byte = bytes[index];
        if (skipLf) { skipLf = false; if (byte === 10) continue; }
        if (byte !== 10 && byte !== 13) { lineHasContent = true; continue; }
        const boundary = !lineHasContent;
        lineHasContent = false;
        skipLf = byte === 13;
        if (!boundary) continue;
        const part = bytes.subarray(start, index + 1);
        frameBuffer.append(part);
        // Retain only the current raw frame, not another partial copy in the
        // decoder. A frame is emitted as soon as its blank-line delimiter arrives.
        const frames = parser.push(frameBuffer.drain());
        start = index + 1;
        for (const frame of frames) {
          const step = session.push(frame);
          if (step.events.length || step.terminal) yield chunk(step);
          if (step.terminal) return;
        }
      }
      const tail = bytes.subarray(start);
      frameBuffer.append(tail);
    }
    parser.finish();
    yield chunk(session.finish({ kind: 'eof' }));
  } catch {
    yield chunk(session.finish(signal?.aborted ? { kind: 'cancelled' } : { kind: 'error', error: error('transport_error') }));
  } finally {
    frameBuffer.cancel();
    parser.finish();
    session.finish({ kind: 'cancelled' });
  }
}
