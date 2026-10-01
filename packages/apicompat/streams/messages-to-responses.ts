import { encodeErrorSseFrame } from '../errors.js';
import { isRepresentableWireId } from '../ids.js';
import { normalizeFinish } from '../finish-reasons.js';
import { createMessagesUsageSession } from '../usage/messages.js';
import { parseMessagesStreamEvent } from '../types/messages.js';
import type { ResponseContext, StreamEnd, StreamOptions, StreamStep } from '../types/adapter.js';
import type { ConversionResult, ProtocolError, SseFrame, TerminalState, UsageSnapshot, UsageUpdate } from '../types/shared.js';
import { BoundedByteBuffer, ByteBudget, readBoundedBytes } from './buffers.js';
import { SseByteParser } from './parser.js';

/**
 * Direct Messages → Responses SSE conversion. Native Messages blocks are
 * translated into Responses items and content events as they arrive. No Chat
 * wire intermediary or whole-response buffer is used.
 *
 * Behavioural reference: the fixed Sub2API commit documented in
 * docs/protocol-baseline.md (ab99d56e9626e6cd731592dae8553c9758a0efa2,
 * LGPL-3.0). This implementation and its fixtures are original.
 */
export interface MessagesToResponsesStep extends StreamStep<SseFrame> {
  readonly usageUpdates: readonly UsageUpdate[];
  readonly usage?: UsageSnapshot;
}
export interface MessagesToResponsesSession {
  push(frame: SseFrame): MessagesToResponsesStep;
  finish(end: StreamEnd): MessagesToResponsesStep;
}
export interface MessagesToResponsesChunk extends Omit<MessagesToResponsesStep, 'events'> {
  readonly bytes: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const empty = (): MessagesToResponsesStep => ({ events: [], usageUpdates: [] });
const error = (code: string): ProtocolError => ({ kind: 'stream_error', code,
  message: 'The Messages to Responses stream could not be completed safely.' });
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const index = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const safeId = (value: unknown): value is string => isRepresentableWireId(value);

interface TextBlock {
  readonly kind: 'text';
  readonly sourceIndex: number;
  readonly outputIndex: number;
  readonly itemId: string;
  readonly buffer: BoundedByteBuffer;
  readonly release: () => void;
  closed: boolean;
}
interface ToolBlock {
  readonly kind: 'tool';
  readonly sourceIndex: number;
  readonly outputIndex: number;
  readonly itemId: string;
  readonly callId: string;
  readonly name: string;
  readonly buffer: BoundedByteBuffer;
  readonly release: () => void;
  closed: boolean;
}
interface ThinkingBlock {
  readonly kind: 'thinking';
  readonly sourceIndex: number;
  readonly outputIndex: number;
  readonly itemId: string;
  readonly buffer: BoundedByteBuffer;
  readonly release: () => void;
  closed: boolean;
}
type ActiveBlock = TextBlock | ToolBlock | ThinkingBlock;
interface OutputItem {
  readonly outputIndex: number;
  readonly item: Record<string, unknown>;
  closed: boolean;
}

function makeResponse(id: string, model: string, status: string, output: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { id, object: 'response', created_at: 0, model, status, output };
}

function validResponseContext(context: ResponseContext, options: StreamOptions): boolean {
  return Number.isSafeInteger(options.maxBufferedBytes) && options.maxBufferedBytes > 0
    && ['ignore', 'reject', 'preserve'].includes(options.unknownEventPolicy)
    && safeId(context.identity?.responseId) && typeof context.targetModel === 'string' && !!context.targetModel.trim()
    && context.targetModel.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(context.targetModel)
    && Number.isSafeInteger(context.createdAt) && context.createdAt >= 0 && typeof context.idFor === 'function';
}

function makeSession(context: ResponseContext, options: StreamOptions, budget: ByteBudget): ConversionResult<MessagesToResponsesSession> {
  if (!validResponseContext(context, options)) return { ok: false, error: error('invalid_stream_configuration') };
  const id = context.identity.responseId;
  const model = context.targetModel;
  const created = context.createdAt;
  const max = options.maxBufferedBytes;
  const policy = options.unknownEventPolicy;
  const usage = createMessagesUsageSession();
  const items = new Map<number, OutputItem>();
  const itemIds = new Set<string>([id]);
  const sourceBlocks = new Map<number, ActiveBlock>();
  const callIds = new Set<string>();
  const releases: (() => void)[] = [];
  let started = false;
  let closed = false;
  let sourceId = context.identity.upstreamResponseId;
  let nextSourceBlock = 0;
  let nextOutputIndex = 0;
  let sequence = 0;
  let pendingFinish: { terminal: TerminalState; status: 'completed' | 'incomplete'; reason?: string; rawReason: string } | undefined;
  let invalidToolArguments = false;
  let sawVisibleText = false;
  let parsedFrame = false;

  const emit = (type: string, fields: object = {}): SseFrame => ({ event: type,
    data: JSON.stringify({ type, sequence_number: sequence++, ...fields }) });
  const body = (status: string, output: readonly Record<string, unknown>[], extra: object = {}) => ({
    id, object: 'response', created_at: created, model, status, output, ...extra,
  });
  function close(terminal: TerminalState, events: SseFrame[]): MessagesToResponsesStep {
    closed = true;
    for (const block of sourceBlocks.values()) { block.buffer.cancel(); block.release(); }
    sourceBlocks.clear();
    for (const release of releases) release();
    releases.length = 0; itemIds.clear(); callIds.clear(); items.clear();
    return { events, terminal, usageUpdates: [], usage: usage.finish(terminal) };
  }
  function fail(code: string): MessagesToResponsesStep {
    const problem = error(code);
    return close({ status: 'failed', error: problem }, [encodeErrorSseFrame('responses', problem, sequence++)]);
  }
  function textOf(block: ActiveBlock): string {
    const bytes = block.buffer.drain();
    const value = decoder.decode(bytes);
    block.buffer.appendText(value);
    return value;
  }
  function outputItems(): Record<string, unknown>[] {
    return [...items.values()].sort((a, b) => a.outputIndex - b.outputIndex).map(entry => entry.item);
  }
  function targetUsage(snapshot: UsageSnapshot): object | undefined {
    if (snapshot.quality !== 'complete') return undefined;
    const counts = snapshot.counts;
    const input = counts.inputTokens + (counts.cacheReadTokens ?? 0) + (counts.cacheWriteTokens ?? 0);
    const total = input + counts.outputTokens;
    if (!Number.isSafeInteger(input) || !Number.isSafeInteger(total)) return undefined;
    return { input_tokens: input, output_tokens: counts.outputTokens, total_tokens: total,
      ...(counts.cacheReadTokens === undefined && counts.cacheWriteTokens === undefined ? {} : { input_tokens_details: {
        ...(counts.cacheReadTokens === undefined ? {} : { cached_tokens: counts.cacheReadTokens }),
        ...(counts.cacheWriteTokens === undefined ? {} : { cache_write_tokens: counts.cacheWriteTokens }),
      } }),
      ...(counts.reasoningTokens === undefined ? {} : { output_tokens_details: { reasoning_tokens: counts.reasoningTokens } }) };
  }
  function terminalFor(rawReason: string, hasToolCalls: boolean): { terminal: TerminalState; status: 'completed' | 'incomplete'; reason?: string } | undefined {
    const normalized = normalizeFinish({ from: 'messages', rawReason, hasToolCalls });
    if (!normalized.ok) return undefined;
    const terminal = normalized.value.terminal;
    if (terminal.status === 'completed') return { terminal, status: 'completed' };
    if (terminal.status !== 'incomplete') return undefined;
    if (terminal.reason === 'length') return { terminal, status: 'incomplete', reason: 'max_output_tokens' };
    if (terminal.reason === 'refusal') return { terminal, status: 'incomplete', reason: 'refusal' };
    return undefined;
  }
  function finishStream(): MessagesToResponsesStep {
    if (!pendingFinish) return fail('missing_source_finish');
    const terminal = pendingFinish.terminal;
    if (terminal.status === 'completed' && invalidToolArguments) return fail('invalid_tool_arguments');
    const snapshot = usage.finish(terminal);
    const wireUsage = targetUsage(snapshot);
    if (terminal.status === 'incomplete' && terminal.reason === 'unknown') return fail('unsupported_finish_reason');
    const status = pendingFinish.status;
    const extra: Record<string, unknown> = status === 'incomplete' ? { incomplete_details: { reason: pendingFinish.reason ?? 'unknown' } } : {};
    if (wireUsage !== undefined) extra.usage = wireUsage;
    const response = body(status, outputItems(), extra);
    const result = close(terminal, [emit(`response.${status}`, { response })]);
    return { ...result, usage: snapshot };
  }

  const wire: { push(frame: SseFrame): MessagesToResponsesStep; finish(end: StreamEnd): MessagesToResponsesStep } = {
    push(frame) {
      parsedFrame = false;
      if (closed) return empty();
      let release: (() => void) | undefined;
      try {
        if (!text(frame.data) || encoder.encode(frame.data).byteLength > max) return fail('frame_limit_exceeded');
        release = budget.reserve(encoder.encode(frame.data).byteLength);
        const raw: unknown = JSON.parse(frame.data);
        if (!object(raw) || !text(raw.type) || (frame.event !== undefined && frame.event !== raw.type)) return fail('invalid_event');
        const known = new Set(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop', 'ping', 'error']);
        if (!known.has(raw.type)) return policy === 'ignore' ? empty() : fail('unsupported_event');
        if (raw.type === 'ping') return { events: [], usageUpdates: [] };
        if (raw.type === 'error') return fail('upstream_error');
        const parsed = parseMessagesStreamEvent(raw);
        if (!parsed.ok) return fail('invalid_source_event');
        parsedFrame = true;
        const event = parsed.value;
        const usageUpdates = usage.push(raw);
        if (event.type === 'message_start') {
          if (started || event.message.content.length !== 0 || event.message.stop_reason !== null || !safeId(event.message.id)
            || (sourceId !== undefined && sourceId !== event.message.id)) return fail('invalid_message_start');
          sourceId ??= event.message.id; started = true;
          const response = body('in_progress', []);
          return { events: [emit('response.created', { response }), emit('response.in_progress', { response })], usageUpdates };
        }
        if (!started) return fail('missing_message_start');
        if (event.type === 'message_delta') {
          if (event.delta.stop_reason !== null) {
            if (pendingFinish && pendingFinish.rawReason !== event.delta.stop_reason) return fail('changed_finish_reason');
            const hasToolCalls = [...items.values()].some(entry => entry.item.type === 'function_call');
            const finish = terminalFor(event.delta.stop_reason, hasToolCalls);
            if (!finish) return fail('unsupported_finish_reason');
            pendingFinish = { ...finish, rawReason: event.delta.stop_reason };
          }
          return { events: [], usageUpdates };
        }
        if (event.type === 'message_stop') {
          if (sourceBlocks.size || !pendingFinish) return fail('incomplete_message_stop');
          const result = finishStream();
          return { ...result, usageUpdates };
        }
        if (event.type === 'content_block_start') {
          if (event.index !== nextSourceBlock || sourceBlocks.size) return fail('invalid_block_order');
          const block = event.content_block;
          if (block.type !== 'text' && block.type !== 'tool_use' && block.type !== 'thinking') return fail('unsupported_content_block');
          if (Object.keys(block).some(key => block.type === 'text' ? !['type', 'text'].includes(key)
            : block.type === 'tool_use' ? !['type', 'id', 'name', 'input'].includes(key) : !['type', 'thinking', 'signature'].includes(key))) return fail('unsupported_content_block');
          if (block.type === 'tool_use' && (!safeId(block.id) || !text(block.name) || !block.name || block.name.length > 64
            || /[^A-Za-z0-9_-]/u.test(block.name) || callIds.has(block.id))) return fail('unsupported_content_block');
          if (block.type === 'thinking' && block.signature !== '') return fail('unsupported_signed_thinking');
          const itemId = context.idFor('item', block.type === 'text' ? `message:${event.index}` : block.type === 'tool_use' ? `tool:${event.index}` : `reasoning:${event.index}`);
          if (!safeId(itemId) || itemIds.has(itemId)) return fail('invalid_item_identity');
          const outputIndex = nextOutputIndex++; itemIds.add(itemId);
          const item: Record<string, unknown> = block.type === 'text'
            ? { type: 'message', id: itemId, role: 'assistant', status: 'in_progress', content: [] }
            : block.type === 'tool_use'
              ? { type: 'function_call', id: itemId, call_id: block.id, name: block.name, arguments: '', status: 'in_progress' }
              : { type: 'reasoning', id: itemId, summary: [], status: 'in_progress' };
          const itemRelease = budget.reserve(64); releases.push(itemRelease);
          items.set(outputIndex, { outputIndex, item, closed: false });
          const blockRelease = budget.reserve(64);
          const active: ActiveBlock = block.type === 'text'
            ? { kind: 'text', sourceIndex: event.index, outputIndex, itemId, buffer: new BoundedByteBuffer(budget), release: blockRelease, closed: false }
            : block.type === 'tool_use'
              ? { kind: 'tool', sourceIndex: event.index, outputIndex, itemId, callId: block.id, name: block.name, buffer: new BoundedByteBuffer(budget), release: blockRelease, closed: false }
              : { kind: 'thinking', sourceIndex: event.index, outputIndex, itemId, buffer: new BoundedByteBuffer(budget), release: blockRelease, closed: false };
          if (block.type === 'tool_use') callIds.add(block.id);
          sourceBlocks.set(event.index, active); nextSourceBlock += 1;
          const events: SseFrame[] = [emit('response.output_item.added', { output_index: outputIndex, item })];
          if (block.type === 'text') {
            events.push(emit('response.content_part.added', { output_index: outputIndex, item_id: itemId, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }));
            if (block.text) { active.buffer.appendText(block.text); events.push(emit('response.output_text.delta', { output_index: outputIndex, item_id: itemId, content_index: 0, delta: block.text })); }
          } else if (block.type === 'tool_use') {
            const initial = Object.keys(block.input).length === 0 ? '' : JSON.stringify(block.input);
            if (initial) { active.buffer.appendText(initial); events.push(emit('response.function_call_arguments.delta', { output_index: outputIndex, item_id: itemId, delta: initial })); }
          } else {
            if (block.thinking) { active.buffer.appendText(block.thinking); events.push(emit('response.reasoning_summary_text.delta', { output_index: outputIndex, item_id: itemId, summary_index: 0, delta: block.thinking })); }
          }
          return { events, usageUpdates };
        }
        const sourceIndex = (event as { readonly index: number }).index;
        const active = sourceBlocks.get(sourceIndex);
        if (!active) return fail('invalid_block_reference');
        if (event.type === 'content_block_delta') {
          if (active.kind === 'text' && event.delta.type === 'text_delta') {
            if (event.delta.text) { active.buffer.appendText(event.delta.text); return { events: [emit('response.output_text.delta', { output_index: active.outputIndex,
              item_id: active.itemId, content_index: 0, delta: event.delta.text })], usageUpdates }; }
            return { events: [], usageUpdates };
          }
          if (active.kind === 'tool' && event.delta.type === 'input_json_delta') {
            if (!event.delta.partial_json) return { events: [], usageUpdates };
            active.buffer.appendText(event.delta.partial_json);
            return { events: [emit('response.function_call_arguments.delta', { output_index: active.outputIndex, item_id: active.itemId, delta: event.delta.partial_json })], usageUpdates };
          }
          if (active.kind === 'thinking' && event.delta.type === 'thinking_delta') {
            if (!event.delta.thinking) return { events: [], usageUpdates };
            if (sawVisibleText || [...items.values()].some(entry => entry.item.type === 'function_call')) return fail('unrepresentable_thinking_order');
            active.buffer.appendText(event.delta.thinking);
            return { events: [emit('response.reasoning_summary_text.delta', { output_index: active.outputIndex, item_id: active.itemId, summary_index: 0, delta: event.delta.thinking })], usageUpdates };
          }
          return fail('unsupported_content_delta');
        }
        if (event.type === 'content_block_stop') {
          const value = textOf(active); active.closed = true;
          const known = items.get(active.outputIndex); if (!known) return fail('invalid_item_reference');
          if (active.kind === 'tool') {
            const args = value || '{}';
            try {
              const parsedArgs: unknown = JSON.parse(args);
              if (!object(parsedArgs)) invalidToolArguments = true;
            } catch { invalidToolArguments = true; }
            known.item.arguments = args; known.item.status = 'completed'; known.closed = true;
            sourceBlocks.delete(sourceIndex); active.buffer.cancel(); active.release();
            return { events: [emit('response.function_call_arguments.done', { output_index: active.outputIndex, item_id: active.itemId, arguments: args, name: active.name }),
              emit('response.output_item.done', { output_index: active.outputIndex, item: known.item })], usageUpdates };
          }
          if (active.kind === 'thinking') {
            const summary = value;
            known.item.summary = [{ type: 'summary_text', text: summary }]; known.item.status = 'completed'; known.closed = true;
            sourceBlocks.delete(sourceIndex); active.buffer.cancel(); active.release();
            return { events: [emit('response.reasoning_summary_text.done', { output_index: active.outputIndex, item_id: active.itemId, summary_index: 0, text: summary }),
              emit('response.reasoning_summary_part.done', { output_index: active.outputIndex, item_id: active.itemId, summary_index: 0, part: { type: 'summary_text', text: summary } }),
              emit('response.output_item.done', { output_index: active.outputIndex, item: known.item })], usageUpdates };
          }
          sawVisibleText ||= value.length > 0;
          known.item.content = [{ type: 'output_text', text: value, annotations: [] }]; known.item.status = 'completed'; known.closed = true;
          sourceBlocks.delete(sourceIndex); active.buffer.cancel(); active.release();
          return { events: [emit('response.output_text.done', { output_index: active.outputIndex, item_id: active.itemId, content_index: 0, text: value }),
            emit('response.content_part.done', { output_index: active.outputIndex, item_id: active.itemId, content_index: 0, part: { type: 'output_text', text: value, annotations: [] } }),
            emit('response.output_item.done', { output_index: active.outputIndex, item: known.item })], usageUpdates };
        }
        return fail('unsupported_event');
      } catch { return fail('invalid_or_oversized_event'); }
      finally { release?.(); }
    },
    finish(end) {
      if (closed) return empty();
      if (end.kind === 'cancelled') return close({ status: 'cancelled' }, []);
      if (end.kind === 'error') return fail('transport_error');
      return close({ status: 'incomplete', reason: 'unexpected_eof' }, [encodeErrorSseFrame('responses', error('unexpected_eof'), sequence++)]);
    },
  };
  return { ok: true, value: {
    push(frame) {
      if (closed) return empty();
      const step = wire.push(frame);
      return step;
    },
    finish(end) { return wire.finish(end); },
  } };
}

export function createMessagesToResponsesSession(context: ResponseContext, options: StreamOptions): ConversionResult<MessagesToResponsesSession> {
  if (!Number.isSafeInteger(options.maxBufferedBytes) || options.maxBufferedBytes < 1) return { ok: false, error: error('invalid_stream_configuration') };
  return makeSession(context, options, new ByteBudget(options.maxBufferedBytes));
}
export const messagesToResponsesStreamAdapter = Object.freeze({ from: 'messages' as const, to: 'responses' as const, create: createMessagesToResponsesSession });

function chunk(step: MessagesToResponsesStep): MessagesToResponsesChunk {
  const { events, ...metadata } = step;
  return { ...metadata, bytes: encoder.encode(events.map(frame => `event: ${frame.event}\ndata: ${frame.data}\n\n`).join('')) };
}

/** Incremental Messages SSE reader with bounded bytes and abort-aware backpressure. */
export async function* streamMessagesToResponses(
  source: ReadableStream<Uint8Array>, context: ResponseContext, options: StreamOptions, signal?: AbortSignal,
): AsyncGenerator<MessagesToResponsesChunk, void, unknown> {
  if (!Number.isSafeInteger(options.maxBufferedBytes) || options.maxBufferedBytes < 1) throw new TypeError('Invalid Messages to Responses stream configuration');
  const budget = new ByteBudget(options.maxBufferedBytes);
  const created = makeSession(context, options, budget);
  if (!created.ok) throw new TypeError('Invalid Messages to Responses stream configuration');
  const session = created.value; const parser = new SseByteParser(); const pending = new BoundedByteBuffer(budget);
  let lineHasContent = false; let skipLf = false;
  try {
    for await (const bytes of readBoundedBytes(source, budget, signal)) {
      let start = 0;
      for (let cursor = 0; cursor < bytes.length; cursor += 1) {
        if (signal?.aborted) { yield chunk(session.finish({ kind: 'cancelled' })); return; }
        const byte = bytes[cursor];
        if (skipLf) { skipLf = false; if (byte === 10) continue; }
        if (byte !== 10 && byte !== 13) { lineHasContent = true; continue; }
        const boundary = !lineHasContent; lineHasContent = false; skipLf = byte === 13;
        if (!boundary) continue;
        pending.append(bytes.subarray(start, cursor + 1)); start = cursor + 1;
        for (const frame of parser.push(pending.drain())) {
          const step = session.push(frame);
          if (step.events.length || step.terminal || step.usageUpdates.length) yield chunk(step);
          if (step.terminal) return;
        }
      }
      pending.append(bytes.subarray(start));
    }
    parser.finish(); yield chunk(session.finish({ kind: 'eof' }));
  } catch {
    yield chunk(session.finish(signal?.aborted ? { kind: 'cancelled' } : { kind: 'error', error: error('transport_error') }));
  } finally { pending.cancel(); parser.finish(); session.finish({ kind: 'cancelled' }); }
}
