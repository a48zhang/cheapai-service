/**
 * SPDX-License-Identifier: LGPL-3.0-only
 * Behavioral reference: Wei-Shaw/sub2api, commit
 * ab99d56e9626e6cd731592dae8553c9758a0efa2,
 * backend/internal/pkg/apicompat/chatcompletions_anthropic_bridge.go. This is
 * an independent TypeScript implementation with synthetic tests; it does not
 * copy upstream source or fixtures. See LICENSES/LGPL-3.0.txt and
 * docs/protocol-baseline.md.
 *
 * P-CM-S1..S6: direct Chat SSE -> Messages SSE conversion. Source accounting
 * remains an original Chat usage session, while target events are emitted as
 * deltas arrive and all retained fragments stay under the caller byte budget.
 */
import { encodeErrorSseFrame } from '../errors.js';
import { normalizeFinish, mapFinishToTarget } from '../finish-reasons.js';
import { isRepresentableWireId } from '../ids.js';
import { BoundedByteBuffer, ByteBudget, readBoundedBytes } from './buffers.js';
import { SseByteParser } from './parser.js';
import { parseChatStreamChunk } from '../types/chat.js';
import { createChatUsageSession } from '../usage/chat.js';
import type { ResponseContext, StreamEnd, StreamOptions, StreamStep } from '../types/adapter.js';
import type { ConversionResult, ProtocolError, SseFrame, TerminalState, UsageSnapshot, UsageUpdate } from '../types/shared.js';

export interface ChatToMessagesStep extends StreamStep<SseFrame> {
  readonly usageUpdates: readonly UsageUpdate[];
  readonly usage?: UsageSnapshot;
}
export interface ChatToMessagesSession {
  push(frame: SseFrame): ChatToMessagesStep;
  finish(end: StreamEnd): ChatToMessagesStep;
}
export interface ChatToMessagesChunk extends Omit<ChatToMessagesStep, 'events'> {
  readonly bytes: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const empty = (): ChatToMessagesStep => ({ events: [], usageUpdates: [] });
const error = (code: string): ProtocolError => ({
  kind: 'stream_error',
  code,
  message: 'The Chat to Messages stream could not be completed safely.',
});
const sourceEvent = (event: string | undefined): boolean => event === undefined || event === 'message';
const responseServiceTiers = new Set(['auto', 'default', 'flex', 'scale', 'priority', 'fast', 'ultrafast']);
const hasOnly = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every(key => allowed.includes(key));

/** Preserve only reviewed Chat usage extensions (cache write is used by the
 * usage extractor); arbitrary provider fields still fail closed. */
function reviewedChunkShape(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const chunk = value as Record<string, unknown>;
  if (!hasOnly(chunk, ['id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint', 'service_tier'])) return false;
  if (chunk.usage !== undefined && chunk.usage !== null) {
    if (typeof chunk.usage !== 'object' || Array.isArray(chunk.usage)) return false;
    const usage = chunk.usage as Record<string, unknown>;
    if (!hasOnly(usage, ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_tokens_details', 'completion_tokens_details'])) return false;
    for (const key of ['prompt_tokens_details', 'completion_tokens_details']) {
      const details = usage[key];
      if (details === undefined) continue;
      if (details === null || typeof details !== 'object' || Array.isArray(details)) return false;
      const allowed = key === 'prompt_tokens_details'
        ? ['cached_tokens', 'cache_write_tokens', 'audio_tokens']
        : ['reasoning_tokens', 'audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens'];
      if (!hasOnly(details as Record<string, unknown>, allowed)) return false;
      const zeroOnly = key === 'prompt_tokens_details'
        ? ['audio_tokens']
        : ['audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens'];
      if (zeroOnly.some(field => (details as Record<string, unknown>)[field] !== undefined
        && (details as Record<string, unknown>)[field] !== 0)) return false;
    }
  }
  if (!Array.isArray(chunk.choices)) return false;
  for (const choiceValue of chunk.choices) {
    if (choiceValue === null || typeof choiceValue !== 'object' || Array.isArray(choiceValue)) return false;
    const choice = choiceValue as Record<string, unknown>;
    if (!hasOnly(choice, ['index', 'delta', 'finish_reason', 'logprobs']) || choice.delta === null || typeof choice.delta !== 'object' || Array.isArray(choice.delta)) return false;
    const delta = choice.delta as Record<string, unknown>;
    if (!hasOnly(delta, ['role', 'content', 'refusal', 'reasoning_content', 'reasoning', 'tool_calls'])) return false;
    if (delta.tool_calls === undefined) continue;
    if (!Array.isArray(delta.tool_calls)) return false;
    for (const callValue of delta.tool_calls) {
      if (callValue === null || typeof callValue !== 'object' || Array.isArray(callValue)) return false;
      const call = callValue as Record<string, unknown>;
      if (!hasOnly(call, ['index', 'id', 'type', 'function'])) return false;
      if (call.function === undefined) continue;
      if (call.function === null || typeof call.function !== 'object' || Array.isArray(call.function)
        || !hasOnly(call.function as Record<string, unknown>, ['name', 'arguments'])) return false;
    }
  }
  return true;
}

type Tool = {
  readonly sourceIndex: number;
  readonly args: BoundedByteBuffer;
  readonly release: () => void;
  id?: string;
  name?: string;
  blockIndex?: number;
};

function validModel(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validToolName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && /^[A-Za-z0-9_-]+$/u.test(value);
}

function makeSession(context: ResponseContext, options: StreamOptions, budget: ByteBudget): ConversionResult<ChatToMessagesSession> {
  if (!context || !context.identity || !isRepresentableWireId(context.identity.responseId)
    || (context.identity.upstreamResponseId !== undefined && !isRepresentableWireId(context.identity.upstreamResponseId))
    || !validModel(context.targetModel) || !Number.isSafeInteger(context.createdAt) || context.createdAt < 0
    || typeof context.idFor !== 'function' || !['ignore', 'reject', 'preserve'].includes(options.unknownEventPolicy)) {
    return { ok: false, error: error('invalid_stream_configuration') };
  }

  const id = context.identity.responseId;
  const model = context.targetModel;
  const policy = options.unknownEventPolicy;
  const usage = createChatUsageSession();
  // Native Messages requires an initial usage object. These wire-only pending
  // placeholders match the SDK's initial envelope shape; zero avoids a fake
  // one-token regression when the measured response is empty. The original
  // Chat usage session below never consumes or bills these placeholders.
  const initialWireUsage = Object.freeze({ input_tokens: 0, output_tokens: 0 });
  const refusal = new BoundedByteBuffer(budget);
  const tools = new Map<number, Tool>();
  const usedBlockIds = new Set<string>([id]);
  const usedCallIds = new Set<string>();
  const releases: (() => void)[] = [];
  let upstreamId = context.identity.upstreamResponseId;
  let serviceTier: string | undefined;
  let blockIndex = 0;
  let started = false;
  let finished = false;
  let closed = false;
  let finishReason: string | undefined;
  let textBlockIndex: number | undefined;
  let thinkingBlockIndex: number | undefined;
  let refusalSeen = false;

  const emit = (type: string, fields: object = {}): SseFrame => ({ event: type, data: JSON.stringify({ type, ...fields }) });

  function close(terminal: TerminalState, events: readonly SseFrame[] = []): ChatToMessagesStep {
    closed = true;
    refusal.cancel();
    for (const tool of tools.values()) tool.args.cancel();
    tools.clear();
    for (const release of releases) release();
    releases.length = 0;
    return { events, terminal, usageUpdates: [], usage: usage.finish(terminal) };
  }

  function fail(code: string): ChatToMessagesStep {
    const problem: ProtocolError = { ...error(code), kind: code === 'upstream_error' ? 'upstream_error' : 'stream_error' };
    return close({ status: 'failed', error: problem }, [encodeErrorSseFrame('messages', problem)]);
  }

  function targetUsage(snapshot: UsageSnapshot): object | undefined {
    // A final Chat usage-only chunk is the only evidence suitable for target
    // presentation. Partial/invalid observations remain in usageUpdates and
    // the terminal UsageSnapshot, never as a guessed complete object.
    if (snapshot.quality !== 'complete') return undefined;
    const counts = snapshot.counts;
    if (counts.outputTokens === undefined) return undefined;
    const result: Record<string, unknown> = { output_tokens: counts.outputTokens };
    if (counts.cacheReadTokens !== undefined) result.cache_read_input_tokens = counts.cacheReadTokens;
    if (counts.cacheWriteTokens !== undefined) result.cache_creation_input_tokens = counts.cacheWriteTokens;
    if (counts.reasoningTokens !== undefined) result.output_tokens_details = { thinking_tokens: counts.reasoningTokens };
    // Chat prompt_tokens includes any reported cache buckets. Messages exposes
    // the residual aggregate after subtracting buckets that are explicitly
    // known; an absent detail stays folded into input_tokens and is never
    // emitted as a fabricated cache zero. Billing keeps the original Chat
    // evidence and does not consume this presentation aggregate.
    if (counts.inputTokens !== undefined) {
      const input = counts.inputTokens - (counts.cacheReadTokens ?? 0) - (counts.cacheWriteTokens ?? 0);
      if (Number.isSafeInteger(input) && input >= 0) result.input_tokens = input;
    }
    return result;
  }

  function ensureText(events: SseFrame[]): number {
    if (textBlockIndex !== undefined) return textBlockIndex;
    const index = blockIndex++;
    textBlockIndex = index;
    events.push(emit('content_block_start', { index, content_block: { type: 'text', text: '' } }));
    return index;
  }

  function ensureThinking(events: SseFrame[]): number {
    if (thinkingBlockIndex !== undefined) return thinkingBlockIndex;
    const index = blockIndex++;
    thinkingBlockIndex = index;
    // Chat reasoning has no provider signature. An explicitly empty signature
    // preserves the thinking block shape without claiming or fabricating one.
    events.push(emit('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } }));
    return index;
  }

  function finishDone(): ChatToMessagesStep {
    if (!started || !finished || finishReason === undefined) return fail('missing_source_finish');
    if (finishReason === 'stop' && tools.size > 0) return fail('inconsistent_finish_reason');
    if ((finishReason === 'tool_calls' || finishReason === 'function_call') && tools.size === 0) return fail('missing_tool_call');
    const normalized = normalizeFinish({ from: 'chat', rawReason: finishReason,
      hasToolCalls: tools.size > 0, hasRefusal: refusalSeen });
    if (!normalized.ok) return fail('unsupported_finish_reason');
    // Messages has a refusal stop detail but no refusal content block. Do not
    // silently drop a refusal when the source ended for another reason.
    if (refusalSeen && !(normalized.value.terminal.status === 'incomplete' && normalized.value.terminal.reason === 'refusal')) {
      return fail('unrepresentable_refusal');
    }
    const mapped = mapFinishToTarget(normalized.value, 'messages');
    if (!mapped.ok) return fail('unsupported_finish_reason');
    usage.push('[DONE]');
    if (mapped.value.kind === 'error') return close(normalized.value.terminal, [encodeErrorSseFrame('messages', mapped.value.error)]);
    if (mapped.value.kind === 'cancelled' || mapped.value.kind !== 'native' || mapped.value.to !== 'messages') return fail('unsupported_finish_reason');

    const terminal = normalized.value.terminal;
    const events: SseFrame[] = [];
    const blocks = [
      ...(textBlockIndex === undefined ? [] : [{ index: textBlockIndex, kind: 'text' as const }]),
      ...(thinkingBlockIndex === undefined ? [] : [{ index: thinkingBlockIndex, kind: 'thinking' as const }]),
      ...[...tools.values()].filter(tool => tool.blockIndex !== undefined).map(tool => ({ index: tool.blockIndex!, kind: 'tool' as const, tool })),
    ].sort((a, b) => a.index - b.index);
    for (const block of blocks) {
      if (block.kind !== 'tool') {
        events.push(emit('content_block_stop', { index: block.index }));
        continue;
      }
      const tool = block.tool;
      if (!tool.id || !tool.name || tool.blockIndex === undefined) return fail('incomplete_tool_identity');
      if (tool.args.byteLength === 0) events.push(emit('content_block_delta', { index: tool.blockIndex, delta: { type: 'input_json_delta', partial_json: '{}' } }));
      const args = decoder.decode(tool.args.drain());
      if (terminal.status === 'completed') {
        let valid = false;
        try {
          const parsed: unknown = JSON.parse(args || '{}');
          valid = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
        } catch {
          valid = false;
        }
        if (!valid) return fail('invalid_tool_arguments');
      }
      events.push(emit('content_block_stop', { index: block.index }));
    }
    const snapshot = usage.finish(terminal);
    const delta: Record<string, unknown> = { stop_reason: mapped.value.stop_reason, stop_sequence: null };
    if (terminal.status === 'incomplete' && terminal.reason === 'refusal' && refusalSeen) {
      delta.stop_details = { type: 'refusal', category: null, explanation: decoder.decode(refusal.drain()) };
    }
    const displayedUsage = targetUsage(snapshot);
    events.push(emit('message_delta', { delta, ...(displayedUsage === undefined ? {} : { usage: displayedUsage }) }), emit('message_stop'));
    return close(terminal, events);
  }

  return { ok: true, value: {
    push(frame) {
      if (closed) return empty();
      let release: (() => void) | undefined;
      try {
        if (typeof frame.data !== 'string') return fail('invalid_frame');
        const encoded = encoder.encode(frame.data);
        if (encoded.byteLength > budget.maxBytes) return fail('frame_limit_exceeded');
        release = budget.reserve(encoded.byteLength);
        if (frame.event === 'error') return fail('upstream_error');
        if (!sourceEvent(frame.event)) return policy === 'ignore' ? empty() : fail('unsupported_source_event');
        if (frame.data === '[DONE]') return finishDone();

        const raw: unknown = JSON.parse(frame.data);
        if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && Object.hasOwn(raw, 'error')) return fail('upstream_error');
        if (!reviewedChunkShape(raw)) return fail('invalid_source_chunk');
        const parsed = parseChatStreamChunk(raw, { unknownFields: 'preserve' });
        if (!parsed.ok) return fail('invalid_source_chunk');
        const value = parsed.value;
        if (!isRepresentableWireId(value.id)) return fail('invalid_upstream_identity');
        if (upstreamId !== undefined && value.id !== upstreamId) return fail('upstream_identity_mismatch');
        upstreamId ??= value.id;
        if (value.service_tier !== undefined && value.service_tier !== null) {
          if (!responseServiceTiers.has(value.service_tier)) return fail('unsupported_source_feature');
          if (serviceTier !== undefined && serviceTier !== value.service_tier) return fail('source_metadata_changed');
          serviceTier = value.service_tier;
        }
        // Preserve original usage evidence before semantic conversion checks;
        // a failed stream still exposes what the provider actually reported.
        const usageUpdates = usage.push(value);
        if (value.choices.length === 0) {
          if (!started || !finished || value.usage == null) return fail('invalid_usage_only_chunk');
          return { events: [], usageUpdates };
        }
        if (value.choices.length !== 1 || value.choices[0]?.index !== 0) return fail('unsupported_multiple_choices');
        const choice = value.choices[0]!;
        if (finished || choice.logprobs != null) return fail('unsupported_source_feature');
        const events: SseFrame[] = [];
        if (!started) {
          started = true;
          events.push(emit('message_start', { message: { id, model, type: 'message', role: 'assistant', content: [], stop_reason: null, stop_sequence: null, usage: initialWireUsage } }));
        }

        const primaryReasoning = typeof choice.delta.reasoning_content === 'string' ? choice.delta.reasoning_content : undefined;
        const aliasReasoning = typeof choice.delta.reasoning === 'string' ? choice.delta.reasoning : undefined;
        if (primaryReasoning !== undefined && aliasReasoning !== undefined && primaryReasoning !== aliasReasoning) return fail('conflicting_reasoning_aliases');
        const reasoningDelta = primaryReasoning ?? aliasReasoning;
        if (reasoningDelta) {
          const index = ensureThinking(events);
          events.push(emit('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: reasoningDelta } }));
        }
        if (choice.delta.content) {
          const index = ensureText(events);
          events.push(emit('content_block_delta', { index, delta: { type: 'text_delta', text: choice.delta.content } }));
        }
        if (typeof choice.delta.refusal === 'string') {
          refusalSeen = true;
          refusal.appendText(choice.delta.refusal);
        }
        const seenToolIndices = new Set<number>();
        for (const delta of choice.delta.tool_calls ?? []) {
          if (!Number.isSafeInteger(delta.index) || delta.index < 0 || seenToolIndices.has(delta.index)) return fail('duplicate_tool_index');
          seenToolIndices.add(delta.index);
          if (delta.type !== undefined && delta.type !== 'function') return fail('unsupported_source_feature');
          let tool = tools.get(delta.index);
          if (tool === undefined) {
            const releaseTool = budget.reserve(128);
            releases.push(releaseTool);
            tool = { sourceIndex: delta.index, args: new BoundedByteBuffer(budget), release: releaseTool };
            tools.set(delta.index, tool);
          }
          if (delta.id !== undefined) {
            if (!isRepresentableWireId(delta.id) || (tool.id !== undefined && tool.id !== delta.id)
              || (tool.id === undefined && (usedCallIds.has(delta.id) || usedBlockIds.has(delta.id)))) return fail('tool_identity_changed');
            tool.id = delta.id;
            usedCallIds.add(delta.id);
            usedBlockIds.add(delta.id);
          }
          if (delta.function?.name !== undefined) {
            if (!validToolName(delta.function.name) || (tool.name !== undefined && tool.name !== delta.function.name)) return fail('tool_name_changed');
            tool.name = delta.function.name;
          }
          const fragment = delta.function?.arguments ?? '';
          tool.args.appendText(fragment);
          if (tool.blockIndex === undefined && tool.id !== undefined && tool.name !== undefined) {
            tool.blockIndex = blockIndex++;
            events.push(emit('content_block_start', { index: tool.blockIndex, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } }));
            const pending = decoder.decode(tool.args.drain());
            tool.args.appendText(pending);
            if (pending) events.push(emit('content_block_delta', { index: tool.blockIndex, delta: { type: 'input_json_delta', partial_json: pending } }));
          } else if (tool.blockIndex !== undefined && fragment) {
            events.push(emit('content_block_delta', { index: tool.blockIndex, delta: { type: 'input_json_delta', partial_json: fragment } }));
          }
        }
        finished = choice.finish_reason !== null;
        if (choice.finish_reason !== null) finishReason = choice.finish_reason;
        return { events, usageUpdates };
      } catch {
        return fail('invalid_or_oversized_source');
      } finally {
        release?.();
      }
    },
    finish(end) {
      if (closed) return empty();
      if (end.kind === 'cancelled') return close({ status: 'cancelled' });
      if (end.kind === 'error') return fail('transport_error');
      return close({ status: 'incomplete', reason: 'unexpected_eof' }, [encodeErrorSseFrame('messages', error('unexpected_eof'))]);
    },
  } };
}

export function createChatToMessagesSession(context: ResponseContext, options: StreamOptions): ConversionResult<ChatToMessagesSession> {
  if (!Number.isSafeInteger(options.maxBufferedBytes) || options.maxBufferedBytes < 1) return { ok: false, error: error('invalid_stream_configuration') };
  return makeSession(context, options, new ByteBudget(options.maxBufferedBytes));
}

export const chatToMessagesStreamAdapter = Object.freeze({ from: 'chat' as const, to: 'messages' as const, create: createChatToMessagesSession });

function chunk(step: ChatToMessagesStep): ChatToMessagesChunk {
  const { events, ...metadata } = step;
  return { ...metadata, bytes: encoder.encode(events.map(frame => `event: ${frame.event}\ndata: ${frame.data}\n\n`).join('')) };
}

/** Incremental SSE conversion with one bounded source frame at a time. */
export async function* streamChatToMessages(
  source: ReadableStream<Uint8Array>, context: ResponseContext, options: StreamOptions, signal?: AbortSignal,
): AsyncGenerator<ChatToMessagesChunk, void, unknown> {
  if (!Number.isSafeInteger(options.maxBufferedBytes) || options.maxBufferedBytes < 1) throw new TypeError('Invalid ChatToMessages stream configuration');
  const budget = new ByteBudget(options.maxBufferedBytes);
  const created = makeSession(context, options, budget);
  if (!created.ok) throw new TypeError('Invalid ChatToMessages stream configuration');
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
        frameBuffer.append(bytes.subarray(start, index + 1));
        const frames = parser.push(frameBuffer.drain());
        start = index + 1;
        for (const frame of frames) {
          const step = session.push(frame);
          if (step.events.length || step.terminal || step.usageUpdates.length) yield chunk(step);
          if (step.terminal) return;
        }
      }
      frameBuffer.append(bytes.subarray(start));
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
