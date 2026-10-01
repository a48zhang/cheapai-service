/**
 * SPDX-License-Identifier: LGPL-3.0-only
 * Behavioral reference: Wei-Shaw/sub2api, commit
 * ab99d56e9626e6cd731592dae8553c9758a0efa2,
 * backend/internal/pkg/apicompat/chatcompletions_responses_bridge.go and
 * chatcompletions_responses_stream_lifecycle_test.go. This is an independent
 * TypeScript implementation with synthetic tests; it does not copy upstream
 * source or fixtures. See LICENSES/LGPL-3.0.txt and docs/protocol-baseline.md.
 *
 * P-CR-S1..S6: direct Chat SSE -> Responses SSE conversion. The adapter keeps
 * source usage separate from presentation, emits each representable target
 * event as soon as its source delta arrives, and bounds retained fragments.
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

export interface ChatToResponsesStep extends StreamStep<SseFrame> {
  readonly usageUpdates: readonly UsageUpdate[];
  readonly usage?: UsageSnapshot;
}
export interface ChatToResponsesSession {
  push(frame: SseFrame): ChatToResponsesStep;
  finish(end: StreamEnd): ChatToResponsesStep;
}
export interface ChatToResponsesChunk extends Omit<ChatToResponsesStep, 'events'> {
  readonly bytes: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const empty = (): ChatToResponsesStep => ({ events: [], usageUpdates: [] });
const error = (code: string): ProtocolError => ({
  kind: 'stream_error',
  code,
  message: 'The Chat to Responses stream could not be completed safely.',
});
const sourceEvent = (event: string | undefined): boolean => event === undefined || event === 'message';
const responseServiceTiers = new Set(['auto', 'default', 'flex', 'scale', 'priority', 'fast', 'ultrafast']);
const hasOnly = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every(key => allowed.includes(key));

/** Keep the usage extensions understood by the original Chat extractor while
 * rejecting arbitrary preserved provider fields. */
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
  itemId?: string;
  outputIndex?: number;
};
type Reasoning = {
  readonly args: BoundedByteBuffer;
  readonly release: () => void;
  itemId: string;
  outputIndex: number;
};

function validModel(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validToolName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && /^[A-Za-z0-9_-]+$/u.test(value);
}

function makeSession(context: ResponseContext, options: StreamOptions, budget: ByteBudget): ConversionResult<ChatToResponsesSession> {
  if (!context || !context.identity || !isRepresentableWireId(context.identity.responseId)
    || (context.identity.upstreamResponseId !== undefined && !isRepresentableWireId(context.identity.upstreamResponseId))
    || !validModel(context.targetModel) || !Number.isSafeInteger(context.createdAt) || context.createdAt < 0
    || typeof context.idFor !== 'function' || !['ignore', 'reject', 'preserve'].includes(options.unknownEventPolicy)) {
    return { ok: false, error: error('invalid_stream_configuration') };
  }

  const id = context.identity.responseId;
  const model = context.targetModel;
  const createdAt = context.createdAt;
  const policy = options.unknownEventPolicy;
  const usage = createChatUsageSession();
  const text = new BoundedByteBuffer(budget);
  const refusal = new BoundedByteBuffer(budget);
  const tools = new Map<number, Tool>();
  const usedItemIds = new Set<string>([id]);
  const usedCallIds = new Set<string>();
  const releases: (() => void)[] = [];
  let upstreamId = context.identity.upstreamResponseId;
  let serviceTier: string | undefined;
  let sequence = 0;
  let started = false;
  let finished = false;
  let closed = false;
  let finishReason: string | undefined;
  let messageId: string | undefined;
  let messageIndex: number | undefined;
  let textIndex: number | undefined;
  let refusalIndex: number | undefined;
  let nextContentIndex = 0;
  let reasoning: Reasoning | undefined;
  let outputCount = 0;

  const emit = (type: string, fields: object = {}): SseFrame => ({
    event: type,
    data: JSON.stringify({ type, sequence_number: sequence++, ...fields }),
  });

  const body = (status: string, output: readonly object[], usageValue?: object): object => ({
    id,
    object: 'response',
    created_at: createdAt,
    model,
    status,
    output,
    ...(serviceTier === undefined ? {} : { service_tier: serviceTier }),
    ...(usageValue === undefined ? {} : { usage: usageValue }),
  });

  function close(terminal: TerminalState, events: readonly SseFrame[] = []): ChatToResponsesStep {
    closed = true;
    text.cancel();
    refusal.cancel();
    reasoning?.args.cancel();
    for (const tool of tools.values()) tool.args.cancel();
    tools.clear();
    for (const release of releases) release();
    releases.length = 0;
    return { events, terminal, usageUpdates: [], usage: usage.finish(terminal) };
  }

  function fail(code: string): ChatToResponsesStep {
    const problem: ProtocolError = {
      ...error(code),
      kind: code === 'upstream_error' ? 'upstream_error' : 'stream_error',
    };
    return close({ status: 'failed', error: problem }, [encodeErrorSseFrame('responses', problem, sequence++)]);
  }

  function nextOutputIndex(): number {
    // A separate counter keeps output indices contiguous even when a source
    // tool index is sparse or arrives after reasoning/text.
    return outputCount++;
  }

  function ensureMessage(events: SseFrame[]): void {
    if (messageId !== undefined) return;
    const itemId = context.idFor('item', 'message:0');
    if (!isRepresentableWireId(itemId) || usedItemIds.has(itemId)) throw new Error('invalid message identity');
    usedItemIds.add(itemId);
    messageId = itemId;
    messageIndex = nextOutputIndex();
    events.push(emit('response.output_item.added', {
      output_index: messageIndex,
      item: { type: 'message', id: messageId, role: 'assistant', status: 'in_progress', content: [] },
    }));
  }

  function ensureReasoning(events: SseFrame[]): Reasoning {
    if (reasoning !== undefined) return reasoning;
    const itemId = context.idFor('item', 'reasoning:0');
    if (!isRepresentableWireId(itemId) || usedItemIds.has(itemId)) throw new Error('invalid reasoning identity');
    usedItemIds.add(itemId);
    const release = budget.reserve(128 + encoder.encode(itemId).byteLength);
    releases.push(release);
    const value: Reasoning = { itemId, outputIndex: nextOutputIndex(), args: new BoundedByteBuffer(budget), release };
    reasoning = value;
    events.push(
      emit('response.output_item.added', {
        output_index: value.outputIndex,
        item: { type: 'reasoning', id: itemId, status: 'in_progress', summary: [] },
      }),
      emit('response.reasoning_summary_part.added', {
        item_id: itemId, output_index: value.outputIndex, summary_index: 0,
        part: { type: 'summary_text', text: '' },
      }),
    );
    return value;
  }

  function targetUsage(snapshot: UsageSnapshot): object | undefined {
    if (snapshot.quality !== 'complete') return undefined;
    const counts = snapshot.counts;
    const total = counts.totalTokens ?? counts.inputTokens + counts.outputTokens;
    if (!Number.isSafeInteger(total)) return undefined;
    // Chat prompt_tokens already includes any reported cache buckets. Keep the
    // target display in the same inclusive convention; billing reads the
    // original UsageSnapshot and never this presentation object.
    if (counts.cacheWriteTokens !== undefined && counts.cacheWriteTokens !== 0 && counts.cacheReadTokens === undefined) return undefined;
    return {
      input_tokens: counts.inputTokens,
      output_tokens: counts.outputTokens,
      total_tokens: total,
      ...(counts.cacheReadTokens === undefined ? {} : {
        input_tokens_details: {
          cached_tokens: counts.cacheReadTokens,
          ...(counts.cacheWriteTokens === undefined ? {} : { cache_write_tokens: counts.cacheWriteTokens }),
        },
      }),
      ...(counts.reasoningTokens === undefined ? {} : { output_tokens_details: { reasoning_tokens: counts.reasoningTokens } }),
    };
  }

  function finishDone(): ChatToResponsesStep {
    if (!started || !finished || finishReason === undefined) return fail('missing_source_finish');
    if ((finishReason === 'tool_calls' || finishReason === 'function_call') && tools.size === 0) return fail('missing_tool_call');
    const normalized = normalizeFinish({ from: 'chat', rawReason: finishReason,
      hasRefusal: refusalIndex !== undefined, hasToolCalls: tools.size > 0 });
    if (!normalized.ok) return fail('unsupported_finish_reason');
    const refusalText = refusalIndex === undefined ? undefined : decoder.decode(refusal.drain());
    const mapped = mapFinishToTarget(normalized.value, 'responses', refusalText === undefined ? {} : { refusalPayload: { refusal: refusalText } });
    if (!mapped.ok) return fail('unsupported_finish_reason');
    usage.push('[DONE]');
    if (mapped.value.kind === 'error') return close(normalized.value.terminal, [encodeErrorSseFrame('responses', mapped.value.error, sequence++)]);
    if (mapped.value.kind === 'cancelled' || mapped.value.to !== 'responses') return fail('unsupported_finish_reason');
    const refusalOutput = mapped.value.kind === 'refusal';
    const status = refusalOutput ? 'completed' : mapped.value.status;
    const output: { index: number; item: object }[] = [];
    const terminalEvents: { index: number; events: SseFrame[]; item?: object }[] = [];

    if (reasoning !== undefined) {
      const reasoningText = decoder.decode(reasoning.args.drain());
      const item = { type: 'reasoning', id: reasoning.itemId, status, summary: [{ type: 'summary_text', text: reasoningText }] };
      const events = [
        emit('response.reasoning_summary_text.done', { item_id: reasoning.itemId, output_index: reasoning.outputIndex, summary_index: 0, text: reasoningText }),
        emit('response.reasoning_summary_part.done', { item_id: reasoning.itemId, output_index: reasoning.outputIndex, summary_index: 0, part: { type: 'summary_text', text: reasoningText } }),
        emit('response.output_item.done', { output_index: reasoning.outputIndex, item }),
      ];
      terminalEvents.push({ index: reasoning.outputIndex, events, item });
    }

    if (messageId !== undefined && messageIndex !== undefined) {
      const parts: { index: number; part: object }[] = [];
      const events: SseFrame[] = [];
      if (textIndex !== undefined) {
        const value = decoder.decode(text.drain());
        const part = { type: 'output_text', text: value, annotations: [] };
        events.push(
          emit('response.output_text.done', { item_id: messageId, output_index: messageIndex, content_index: textIndex, text: value }),
          emit('response.content_part.done', { item_id: messageId, output_index: messageIndex, content_index: textIndex, part }),
        );
        parts.push({ index: textIndex, part });
      }
      if (refusalIndex !== undefined) {
        const value = refusalText ?? decoder.decode(refusal.drain());
        const part = { type: 'refusal', refusal: value };
        events.push(
          emit('response.refusal.done', { item_id: messageId, output_index: messageIndex, content_index: refusalIndex, refusal: value }),
          emit('response.content_part.done', { item_id: messageId, output_index: messageIndex, content_index: refusalIndex, part }),
        );
        parts.push({ index: refusalIndex, part });
      }
      const item = { type: 'message', id: messageId, role: 'assistant', status, content: parts.sort((a, b) => a.index - b.index).map(value => value.part) };
      events.push(emit('response.output_item.done', { output_index: messageIndex, item }));
      terminalEvents.push({ index: messageIndex, events, item });
    }

    for (const tool of tools.values()) {
      if (!tool.itemId || tool.outputIndex === undefined || !tool.id || !tool.name) return fail('incomplete_tool_identity');
      const args = decoder.decode(tool.args.drain());
      let validArgs = false;
      try {
        const parsed: unknown = JSON.parse(args);
        validArgs = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
      } catch {
        validArgs = false;
      }
      if (!validArgs && status === 'completed') return fail('invalid_tool_arguments');
      const item = { type: 'function_call', id: tool.itemId, call_id: tool.id, name: tool.name, arguments: args, status };
      const events: SseFrame[] = [];
      if (validArgs) {
        events.push(
          emit('response.function_call_arguments.done', { item_id: tool.itemId, output_index: tool.outputIndex, name: tool.name, arguments: args }),
          emit('response.output_item.done', { output_index: tool.outputIndex, item }),
        );
      }
      terminalEvents.push({ index: tool.outputIndex, events, item });
    }

    terminalEvents.sort((a, b) => a.index - b.index);
    for (const entry of terminalEvents) output.push({ index: entry.index, item: entry.item! });
    const terminal = normalized.value.terminal;
    const responseUsage = targetUsage(usage.finish(terminal));
    const incompleteDetails = status === 'incomplete' && terminal.status === 'incomplete'
      ? { reason: terminal.reason === 'content_filter' ? 'content_filter' : 'max_output_tokens' }
      : undefined;
    const finalEvents = terminalEvents.flatMap(entry => entry.events);
    const response = body(status, output.sort((a, b) => a.index - b.index).map(value => value.item), responseUsage) as Record<string, unknown>;
    if (incompleteDetails !== undefined) response.incomplete_details = incompleteDetails;
    finalEvents.push(emit(`response.${status}`, { response }));
    return close(terminal, finalEvents);
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
        // Retain original accounting before validating choice semantics. If a
        // later conversion rule fails, usage evidence is still available on the
        // terminal snapshot; it is never inferred from emitted text.
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
          events.push(emit('response.created', { response: body('in_progress', []) }), emit('response.in_progress', { response: body('in_progress', []) }));
        }

        const primaryReasoning = typeof choice.delta.reasoning_content === 'string' ? choice.delta.reasoning_content : undefined;
        const aliasReasoning = typeof choice.delta.reasoning === 'string' ? choice.delta.reasoning : undefined;
        if (primaryReasoning !== undefined && aliasReasoning !== undefined && primaryReasoning !== aliasReasoning) return fail('conflicting_reasoning_aliases');
        const reasoningDelta = primaryReasoning ?? aliasReasoning;
        if (reasoningDelta) {
          const current = ensureReasoning(events);
          current.args.appendText(reasoningDelta);
          events.push(emit('response.reasoning_summary_text.delta', { item_id: current.itemId, output_index: current.outputIndex, summary_index: 0, delta: reasoningDelta }));
        }
        if (choice.delta.content) {
          text.appendText(choice.delta.content);
          ensureMessage(events);
          if (textIndex === undefined) {
            textIndex = nextContentIndex++;
            events.push(emit('response.content_part.added', { item_id: messageId, output_index: messageIndex, content_index: textIndex, part: { type: 'output_text', text: '', annotations: [] } }));
          }
          events.push(emit('response.output_text.delta', { item_id: messageId, output_index: messageIndex, content_index: textIndex, delta: choice.delta.content }));
        }
        if (choice.delta.refusal) {
          refusal.appendText(choice.delta.refusal);
          ensureMessage(events);
          if (refusalIndex === undefined) {
            refusalIndex = nextContentIndex++;
            events.push(emit('response.content_part.added', { item_id: messageId, output_index: messageIndex, content_index: refusalIndex, part: { type: 'refusal', refusal: '' } }));
          }
          events.push(emit('response.refusal.delta', { item_id: messageId, output_index: messageIndex, content_index: refusalIndex, delta: choice.delta.refusal }));
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
              || (tool.id === undefined && (usedCallIds.has(delta.id) || usedItemIds.has(delta.id)))) return fail('tool_identity_changed');
            tool.id = delta.id;
            usedCallIds.add(delta.id);
          }
          if (delta.function?.name !== undefined) {
            if (!validToolName(delta.function.name) || (tool.name !== undefined && tool.name !== delta.function.name)) return fail('tool_name_changed');
            tool.name = delta.function.name;
          }
          const fragment = delta.function?.arguments ?? '';
          tool.args.appendText(fragment);
          if (tool.itemId === undefined && tool.id !== undefined && tool.name !== undefined) {
            const itemId = context.idFor('item', `tool:${tool.sourceIndex}`);
            if (!isRepresentableWireId(itemId) || usedItemIds.has(itemId) || usedCallIds.has(itemId)) return fail('invalid_item_identity');
            usedItemIds.add(itemId);
            tool.itemId = itemId;
            tool.outputIndex = nextOutputIndex();
            events.push(emit('response.output_item.added', {
              output_index: tool.outputIndex,
              item: { type: 'function_call', id: itemId, call_id: tool.id, name: tool.name, arguments: '', status: 'in_progress' },
            }));
            const pending = decoder.decode(tool.args.drain());
            tool.args.appendText(pending);
            if (pending) events.push(emit('response.function_call_arguments.delta', { item_id: itemId, output_index: tool.outputIndex, delta: pending }));
          } else if (tool.itemId !== undefined && tool.outputIndex !== undefined && fragment) {
            events.push(emit('response.function_call_arguments.delta', { item_id: tool.itemId, output_index: tool.outputIndex, delta: fragment }));
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
      return close({ status: 'incomplete', reason: 'unexpected_eof' }, [encodeErrorSseFrame('responses', error('unexpected_eof'), sequence++)]);
    },
  } };
}

export function createChatToResponsesSession(context: ResponseContext, options: StreamOptions): ConversionResult<ChatToResponsesSession> {
  if (!Number.isSafeInteger(options.maxBufferedBytes) || options.maxBufferedBytes < 1) return { ok: false, error: error('invalid_stream_configuration') };
  return makeSession(context, options, new ByteBudget(options.maxBufferedBytes));
}

export const chatToResponsesStreamAdapter = Object.freeze({ from: 'chat' as const, to: 'responses' as const, create: createChatToResponsesSession });

function chunk(step: ChatToResponsesStep): ChatToResponsesChunk {
  const { events, ...metadata } = step;
  return { ...metadata, bytes: encoder.encode(events.map(frame => `event: ${frame.event}\ndata: ${frame.data}\n\n`).join('')) };
}

/** Incremental SSE conversion with one bounded source frame at a time. */
export async function* streamChatToResponses(
  source: ReadableStream<Uint8Array>, context: ResponseContext, options: StreamOptions, signal?: AbortSignal,
): AsyncGenerator<ChatToResponsesChunk, void, unknown> {
  if (!Number.isSafeInteger(options.maxBufferedBytes) || options.maxBufferedBytes < 1) throw new TypeError('Invalid ChatToResponses stream configuration');
  const budget = new ByteBudget(options.maxBufferedBytes);
  const created = makeSession(context, options, budget);
  if (!created.ok) throw new TypeError('Invalid ChatToResponses stream configuration');
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
