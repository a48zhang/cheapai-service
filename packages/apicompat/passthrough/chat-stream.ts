import { encodeErrorSseFrame } from '../errors.js';
import { normalizeFinish } from '../finish-reasons.js';
import { BoundedByteBuffer, ByteBudget, readBoundedBytes } from '../streams/buffers.js';
import { SseByteParser } from '../streams/parser.js';
import type { ResponseContext, StreamEnd, StreamOptions, StreamStep } from '../types/adapter.js';
import { parseChatStreamChunk } from '../types/chat.js';
import type { ConversionResult, ProtocolError, SseFrame, TerminalState, UsageSnapshot, UsageUpdate } from '../types/shared.js';
import { createChatUsageSession } from '../usage/chat.js';

export interface ChatStreamStep extends StreamStep<SseFrame> {
  readonly usageUpdates: readonly UsageUpdate[];
  readonly usage?: UsageSnapshot;
}
export interface ChatStreamSession { push(frame: SseFrame): ChatStreamStep; finish(end: StreamEnd): ChatStreamStep }
export interface ChatStreamChunk extends Omit<ChatStreamStep, 'events'> { readonly bytes: Uint8Array }
const encoder = new TextEncoder();
const empty = (): ChatStreamStep => ({ events: [], usageUpdates: [] });
const error = (code: string): ProtocolError => ({ kind: 'stream_error', code, message: 'The Chat stream could not be completed safely.' });
interface Tool { id?: string; name: BoundedByteBuffer; args: BoundedByteBuffer }
interface Choice { tools: Map<number, Tool>; refusal: boolean; terminal?: TerminalState }

function makeSession(context: ResponseContext, options: StreamOptions, budget: ByteBudget): ConversionResult<ChatStreamSession> {
  const max = options.maxBufferedBytes;
  if (!Number.isSafeInteger(max) || max < 1 || !['ignore', 'reject', 'preserve'].includes(options.unknownEventPolicy) ||
    typeof context.targetModel !== 'string' || !context.targetModel.trim() || context.targetModel.length > 512 || /[\u0000-\u001f\u007f]/u.test(context.targetModel) ||
    typeof context.identity.responseId !== 'string' || !context.identity.responseId || context.identity.responseId.length > 128 || /[\u0000-\u0020\u007f]/u.test(context.identity.responseId)) {
    return { ok: false, error: error('invalid_stream_configuration') };
  }
  const model = context.targetModel; const id = context.identity.responseId;
  let nativeId = context.identity.upstreamResponseId;
  const policy = options.unknownEventPolicy;
  const usage = createChatUsageSession();
  const choices = new Map<number, Choice>();
  const releases: (() => void)[] = [];
  let closed = false;
  function close(terminal: TerminalState, events: readonly SseFrame[] = []): ChatStreamStep {
    closed = true;
    for (const choice of choices.values()) for (const tool of choice.tools.values()) { tool.name.cancel(); tool.args.cancel(); }
    choices.clear(); for (const release of releases) release(); releases.length = 0;
    return { events, terminal, usageUpdates: [], usage: usage.finish(terminal) };
  }
  function fail(code: string): ChatStreamStep {
    const problem = error(code);
    return close({ status: 'failed', error: problem }, [encodeErrorSseFrame('chat', problem)]);
  }
  return { ok: true, value: {
    push(frame) {
      if (closed) return empty();
      try {
        if (typeof frame.data !== 'string' || encoder.encode(frame.data).byteLength > max) return fail('frame_limit_exceeded');
        if (frame.event === 'error') return fail('upstream_error');
        if (frame.event !== undefined && frame.event !== 'message') return policy === 'ignore' ? empty() : fail('unsupported_event');
        if (frame.data === '[DONE]') {
          if (choices.size === 0 || [...choices.values()].some(choice => !choice.terminal)) return fail('missing_choice_finish');
          const terminals = [...choices.values()].map(choice => choice.terminal!);
          const terminal = terminals.find(value => value.status !== 'completed')
            ?? terminals.find(value => value.status === 'completed' && value.reason === 'tool_calls') ?? terminals[0]!;
          usage.push('[DONE]');
          return close(terminal, [{ data: '[DONE]' }]);
        }
        const raw: unknown = JSON.parse(frame.data);
        if (raw && typeof raw === 'object' && Object.hasOwn(raw, 'error')) return fail('upstream_error');
        const parsed = parseChatStreamChunk(raw);
        if (!parsed.ok) return fail('invalid_chunk');
        const value = parsed.value;
        if (nativeId !== undefined && nativeId !== value.id) return fail('upstream_identity_mismatch');
        if (nativeId === undefined) { releases.push(budget.reserve(encoder.encode(value.id).byteLength)); nativeId = value.id; }
        if (value.choices.length === 0 && (value.usage == null || choices.size === 0 || [...choices.values()].some(choice => !choice.terminal))) {
          return fail('invalid_usage_only_chunk');
        }
        const seen = new Set<number>();
        for (const update of value.choices) {
          if (seen.has(update.index)) return fail('duplicate_choice_index');
          seen.add(update.index);
          let choice = choices.get(update.index);
          if (!choice) { releases.push(budget.reserve(64)); choice = { tools: new Map(), refusal: false }; choices.set(update.index, choice); }
          if (choice.terminal) return fail('choice_already_finished');
          if (update.delta.refusal) choice.refusal = true;
          const toolIndices = new Set<number>();
          for (const delta of update.delta.tool_calls ?? []) {
            if (toolIndices.has(delta.index)) return fail('duplicate_tool_index');
            toolIndices.add(delta.index);
            let tool = choice.tools.get(delta.index);
            if (!tool) {
              releases.push(budget.reserve(64));
              tool = { name: new BoundedByteBuffer(budget), args: new BoundedByteBuffer(budget) };
              choice.tools.set(delta.index, tool);
            }
            if (delta.id !== undefined) {
              if (tool.id !== undefined && tool.id !== delta.id) return fail('tool_identity_changed');
              if (tool.id === undefined) { releases.push(budget.reserve(encoder.encode(delta.id).byteLength)); tool.id = delta.id; }
            }
            if (delta.function?.name !== undefined) tool.name.appendText(delta.function.name);
            if (delta.function?.arguments !== undefined) tool.args.appendText(delta.function.arguments);
          }
          if (update.finish_reason !== null) {
            const finish = normalizeFinish({ from: 'chat', rawReason: update.finish_reason, hasRefusal: choice.refusal, hasToolCalls: choice.tools.size > 0 });
            if (!finish.ok) return fail('invalid_finish_reason');
            for (const tool of choice.tools.values()) {
              if (finish.value.terminal.status === 'completed') {
                if (!tool.id || !new TextDecoder().decode(tool.name.drain()).trim()) return fail('incomplete_tool_identity');
                if (tool.args.byteLength) {
                  const args: unknown = JSON.parse(new TextDecoder().decode(tool.args.drain()));
                  if (args === null || typeof args !== 'object' || Array.isArray(args)) return fail('invalid_tool_arguments');
                }
              }
              tool.name.clear(); tool.args.clear();
            }
            choice.terminal = finish.value.terminal;
          }
        }
        return { events: [{ data: JSON.stringify({ ...value, id, model }) }], usageUpdates: usage.push(value) };
      } catch { return fail('invalid_or_oversized_chunk'); }
    },
    finish(end) {
      if (closed) return empty();
      if (end.kind === 'cancelled') return close({ status: 'cancelled' });
      if (end.kind === 'error') return fail('transport_error');
      return close({ status: 'incomplete', reason: 'unexpected_eof' }, [encodeErrorSseFrame('chat', error('unexpected_eof'))]);
    },
  } };
}

export function createChatStreamSession(context: ResponseContext, options: StreamOptions): ConversionResult<ChatStreamSession> {
  if (!Number.isSafeInteger(options.maxBufferedBytes) || options.maxBufferedBytes < 1) return { ok: false, error: error('invalid_stream_configuration') };
  return makeSession(context, options, new ByteBudget(options.maxBufferedBytes));
}
export const chatStreamAdapter = Object.freeze({ from: 'chat' as const, to: 'chat' as const, create: createChatStreamSession });

function chunk(step: ChatStreamStep): ChatStreamChunk {
  const { events, ...metadata } = step;
  return { ...metadata, bytes: encoder.encode(events.map(frame => `${frame.event ? `event: ${frame.event}\n` : ""}data: ${frame.data}\n\n`).join('')) };
}

/**
 * Incremental native SSE bytes + separate usage/terminal metadata, no fetch or
 * whole-response buffering. Shares P09 budget across the currently yielded input
 * chunk, incomplete frame and current tool arguments. Slow consumers cause no
 * additional reads. Oversized source chunks also fail closed under this budget.
 * EOF discards P08's residual frame; it never fabricates [DONE]/success.
 */
export async function* streamChatPassthrough(
  source: ReadableStream<Uint8Array>, context: ResponseContext, options: StreamOptions, signal?: AbortSignal,
): AsyncGenerator<ChatStreamChunk, void, unknown> {
  if (!Number.isSafeInteger(options.maxBufferedBytes) || options.maxBufferedBytes < 1) throw new TypeError('Invalid Chat stream configuration');
  const budget = new ByteBudget(options.maxBufferedBytes);
  const created = makeSession(context, options, budget);
  if (!created.ok) throw new TypeError('Invalid Chat stream configuration');
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
