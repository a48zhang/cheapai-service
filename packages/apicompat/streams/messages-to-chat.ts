import { encodeErrorSseFrame } from '../errors.js';
import { isRepresentableWireId } from '../ids.js';
import { normalizeFinish, mapFinishToTarget } from '../finish-reasons.js';
import type { NormalizedFinish } from '../finish-reasons.js';
import { parseMessagesStreamEvent } from '../types/messages.js';
import type { ResponseContext, StreamEnd, StreamOptions, StreamStep, StreamSession } from '../types/adapter.js';
import type { ConversionResult, ProtocolError, SseFrame, TerminalState, UsageSnapshot, UsageUpdate } from '../types/shared.js';
import { createMessagesUsageSession } from '../usage/messages.js';
import { BoundedByteBuffer, ByteBudget, readBoundedBytes } from './buffers.js';
import { SseByteParser } from './parser.js';

/** Original direct adapter. Source flow checked against the public Messages SSE
 * contract; fixtures are synthetic, not copied provider traffic.
 * https://platform.claude.com/docs/en/build-with-claude/streaming
 */
export interface MessagesToChatStep extends StreamStep<SseFrame> { usageUpdates: readonly UsageUpdate[]; usage?: UsageSnapshot }
export interface MessagesToChatSession { push(frame: SseFrame): MessagesToChatStep; finish(end: StreamEnd): MessagesToChatStep }
export interface MessagesToChatChunk extends Omit<MessagesToChatStep, 'events'> { bytes: Uint8Array }
const encoder = new TextEncoder();
const empty = (): StreamStep<SseFrame> => ({ events: [] });
const error = (code: string): ProtocolError => ({ kind: 'stream_error', code, message: 'The Messages to Chat stream could not be completed safely.' });
const types = new Set(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop', 'ping', 'error']);

function makeSession(context: ResponseContext, options: StreamOptions, budget: ByteBudget): ConversionResult<MessagesToChatSession> {
  if (!isRepresentableWireId(context.identity?.responseId) || typeof context.targetModel !== 'string' || !context.targetModel.trim() ||
      context.targetModel.length > 512 || /[\u0000-\u001f\u007f]/.test(context.targetModel) || !Number.isSafeInteger(context.createdAt) || context.createdAt < 0 ||
      !['ignore', 'reject', 'preserve'].includes(options.unknownEventPolicy)) return { ok: false, error: error('invalid_stream_configuration') };
  const id = context.identity.responseId; const model = context.targetModel; const created = context.createdAt;
  const frameLimit = options.maxBufferedBytes; const unknownPolicy = options.unknownEventPolicy;
  let started = false; let closed = false; let messageDeltas = false; let nextBlock = 0;
  type Block = { index: number; release: () => void } & ({ type: 'text' } | { type: 'thinking'; buffer: BoundedByteBuffer } | { type: 'tool'; toolIndex: number; args: BoundedByteBuffer; hasDeltas: boolean; initialComplete: boolean });
  const blocks = new Map<number, Block>();
  const toolIds = new Set<string>();
  const identityReleases: (() => void)[] = [];
  let nextToolIndex = 0;
  let hasTool = false;
  let pendingFinish: NormalizedFinish | undefined;
  let invalidToolArguments = false;
  let sawVisibleText = false;
  let parsedFrame = false;
  const emit = (delta: object, reason: string | null = null): SseFrame => ({ data: JSON.stringify({ id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: reason }] }) });
  function close(terminal: TerminalState, events: SseFrame[]): StreamStep<SseFrame> {
    closed = true;
    for (const block of blocks.values()) { if (block.type === 'tool') block.args.cancel(); else if (block.type === 'thinking') block.buffer.cancel(); block.release(); }
    blocks.clear(); toolIds.clear(); for (const release of identityReleases) release(); identityReleases.length = 0;
    return { events, terminal };
  }
  const fail = (code: string) => close({ status: 'failed', error: error(code) }, [encodeErrorSseFrame('chat', error(code))]);
  const wire: StreamSession<SseFrame, SseFrame> = {
    push(frame) {
      parsedFrame = false;
      if (closed) return empty();
      try {
        if (typeof frame.data !== 'string' || frame.data.length > frameLimit || encoder.encode(frame.data).byteLength > frameLimit) return fail('frame_limit_exceeded');
        const raw: unknown = JSON.parse(frame.data);
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid_event');
        const type = (raw as { type?: unknown }).type;
        if (typeof type !== 'string' || (frame.event !== undefined && frame.event !== type)) return fail('event_type_mismatch');
        if (!types.has(type)) return unknownPolicy === 'ignore' ? empty() : fail('unsupported_event');
        const parsed = parseMessagesStreamEvent(raw);
        if (!parsed.ok) return fail('invalid_event');
        parsedFrame = true;
        const event = parsed.value;
        if (event.type === 'ping') return empty();
        if (event.type === 'error') return fail('upstream_error');
        if (event.type === 'message_start') {
          if (started || event.message.content.length !== 0 || event.message.stop_reason !== null || !isRepresentableWireId(event.message.id) ||
              (context.identity.upstreamResponseId !== undefined && context.identity.upstreamResponseId !== event.message.id)) return fail('invalid_message_start');
          started = true;
          return { events: [emit({ role: 'assistant', content: '' })] };
        }
        if (!started) return fail('missing_message_start');
        if (event.type === 'content_block_start') {
          if (messageDeltas || event.index !== nextBlock++) return fail('invalid_block_order');
          const block = event.content_block;
          if (block.type === 'text') {
            if (Object.keys(block).some(key => !['type', 'text'].includes(key))) return fail('unsupported_content_block');
            blocks.set(event.index, { index: event.index, type: 'text', release: budget.reserve(64) });
            if (block.text) sawVisibleText = true;
            return { events: block.text ? [emit({ content: block.text })] : [] };
          }
          if (block.type === 'thinking') {
            if (Object.keys(block).some(key => !['type', 'thinking', 'signature'].includes(key)) || block.signature !== '') return fail('unsupported_content_block');
            if (block.thinking && (sawVisibleText || hasTool)) return fail('unrepresentable_thinking_order');
            const buffer = new BoundedByteBuffer(budget);
            if (block.thinking) buffer.appendText(block.thinking);
            blocks.set(event.index, { index: event.index, type: 'thinking', buffer, release: budget.reserve(64) });
            return { events: block.thinking ? [emit({ reasoning_content: block.thinking })] : [] };
          }
          if (block.type !== 'tool_use' || Object.keys(block).some(key => !['type', 'id', 'name', 'input'].includes(key)) ||
              !isRepresentableWireId(block.id) || !/^[A-Za-z0-9_-]{1,64}$/.test(block.name) || toolIds.has(block.id)) return fail('unsupported_content_block');
          hasTool = true;
          identityReleases.push(budget.reserve(32 + encoder.encode(block.id).byteLength)); toolIds.add(block.id);
          const active: Extract<Block, { type: 'tool' }> = { index: event.index, type: 'tool', toolIndex: nextToolIndex++, release: budget.reserve(64),
            args: new BoundedByteBuffer(budget), hasDeltas: false, initialComplete: Object.keys(block.input).length > 0 };
          blocks.set(event.index, active);
          const initial = active.initialComplete ? JSON.stringify(block.input) : '';
          if (initial) active.args.appendText(initial);
          return { events: [emit({ tool_calls: [{ index: active.toolIndex, id: block.id, type: 'function', function: { name: block.name, arguments: initial } }] })] };
        }
        if (event.type === 'content_block_delta') {
          const active = blocks.get(event.index);
          if (!active || active.index !== event.index) return fail('invalid_block_delta');
          if (active.type === 'text' && event.delta.type === 'text_delta') {
            if (event.delta.text) sawVisibleText = true;
            return { events: [emit({ content: event.delta.text })] };
          }
          if (active.type === 'thinking' && event.delta.type === 'thinking_delta') {
            if (event.delta.thinking && (sawVisibleText || hasTool)) return fail('unrepresentable_thinking_order');
            active.buffer.appendText(event.delta.thinking);
            return { events: event.delta.thinking ? [emit({ reasoning_content: event.delta.thinking })] : [] };
          }
          if (active.type === 'thinking' && event.delta.type === 'signature_delta') return fail('unsupported_signed_thinking');
          if (active.type !== 'tool' || event.delta.type !== 'input_json_delta' || active.initialComplete) return fail('invalid_block_delta');
          active.hasDeltas = true; active.args.appendText(event.delta.partial_json);
          return { events: [emit({ tool_calls: [{ index: active.toolIndex, function: { arguments: event.delta.partial_json } }] })] };
        }
        if (event.type === 'content_block_stop') {
          const active = blocks.get(event.index);
          if (!active || active.index !== event.index) return fail('invalid_block_stop');
          const events: SseFrame[] = [];
          if (active.type === 'thinking') active.buffer.cancel();
          if (active.type === 'tool') {
            if (active.hasDeltas || active.initialComplete) {
              // Native stop_reason follows block_stop. Delay rejecting partial
              // JSON until we know whether the provider explicitly hit length.
              try {
                const value: unknown = JSON.parse(new TextDecoder().decode(active.args.drain()));
                if (!value || typeof value !== 'object' || Array.isArray(value)) invalidToolArguments = true;
              } catch { invalidToolArguments = true; }
            } else events.push(emit({ tool_calls: [{ index: active.toolIndex, function: { arguments: '{}' } }] }));
            active.args.cancel();
          }
          active.release(); blocks.delete(event.index); return { events };
        }
        if (event.type === 'message_delta') {
          if (blocks.size) return fail('unclosed_content_block');
          messageDeltas = true;
          if (event.delta.stop_reason !== null) {
            if (event.delta.stop_reason === 'tool_use' && !hasTool) return fail('missing_tool_call');
            if (pendingFinish && pendingFinish.rawReason !== event.delta.stop_reason) return fail('changed_finish_reason');
            const normalized = normalizeFinish({ from: 'messages', rawReason: event.delta.stop_reason, hasToolCalls: hasTool });
            if (!normalized.ok) return fail('invalid_finish_reason');
            pendingFinish = normalized.value;
          }
          return empty();
        }
        if (blocks.size || !pendingFinish) return fail('incomplete_message_stop');
        if (invalidToolArguments && pendingFinish.terminal.status === 'completed') return fail('invalid_tool_arguments');
        const target = mapFinishToTarget(pendingFinish, 'chat');
        if (!target.ok) return close(pendingFinish.terminal, [encodeErrorSseFrame('chat', target.error)]);
        if (target.value.kind === 'error') return close(pendingFinish.terminal, [encodeErrorSseFrame('chat', target.value.error)]);
        if (target.value.kind !== 'native' || target.value.to !== 'chat') return fail('unsupported_finish_reason');
        return close(pendingFinish.terminal, [emit({}, target.value.finish_reason), { data: '[DONE]' }]);
      } catch { return fail('invalid_or_oversized_event'); }
    },
    finish(end) {
      if (closed) return empty();
      if (end.kind === 'cancelled') return close({ status: 'cancelled' }, []);
      if (end.kind === 'error') return fail('transport_error');
      return close({ status: 'incomplete', reason: 'unexpected_eof' }, [encodeErrorSseFrame('chat', error('unexpected_eof'))]);
    },
  };
  const usage = createMessagesUsageSession();
  let usageFinished = false;
  function withUsage(step: StreamStep<SseFrame>, updates: readonly UsageUpdate[]): MessagesToChatStep {
    if (!step.terminal) return { ...step, usageUpdates: updates };
    usageFinished = true;
    const snapshot = usage.finish(step.terminal);
    const events = [...step.events];
    // A Chat usage-only chunk needs a known cache-inclusive prompt total. Partial evidence is
    // retained separately for billing; it never becomes invented zero counters.
    if (snapshot.quality === 'complete' && snapshot.counts.cacheReadTokens !== undefined && snapshot.counts.cacheWriteTokens !== undefined && events.at(-1)?.data === '[DONE]') {
      const counts = snapshot.counts;
      const prompt = counts.inputTokens + snapshot.counts.cacheReadTokens + snapshot.counts.cacheWriteTokens;
      const output = counts.outputTokens; const total = prompt + output;
      if (Number.isSafeInteger(prompt) && Number.isSafeInteger(total)) {
        events.splice(events.length - 1, 0, { data: JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [],
          usage: { prompt_tokens: prompt, completion_tokens: output, total_tokens: total,
            ...(counts.cacheReadTokens === undefined ? {} : { prompt_tokens_details: { cached_tokens: counts.cacheReadTokens } }),
            ...(counts.reasoningTokens === undefined ? {} : { completion_tokens_details: { reasoning_tokens: counts.reasoningTokens } }) } }) });
      }
    }
    return { ...step, events, usageUpdates: updates, usage: snapshot };
  }
  return { ok: true, value: {
    push(frame) {
      if (usageFinished) return { events: [], usageUpdates: [] };
      const step = wire.push(frame);
      const updates = parsedFrame ? usage.push(frame) : [];
      return withUsage(step, updates);
    },
    finish(end) {
      if (usageFinished) return { events: [], usageUpdates: [] };
      return withUsage(wire.finish(end), []);
    },
  } };
}

export function createMessagesToChatSession(context: ResponseContext, options: StreamOptions): ConversionResult<MessagesToChatSession> {
  if (!Number.isSafeInteger(options.maxBufferedBytes) || options.maxBufferedBytes < 1) return { ok: false, error: error('invalid_stream_configuration') };
  return makeSession(context, options, new ByteBudget(options.maxBufferedBytes));
}
export const messagesToChatStreamAdapter = Object.freeze({ from: 'messages' as const, to: 'chat' as const, create: createMessagesToChatSession });
function chunk(step: MessagesToChatStep): MessagesToChatChunk {
  const { events, ...metadata } = step;
  return { ...metadata, bytes: encoder.encode(events.map(frame =>
    `${frame.event ? `event: ${frame.event}\n` : ''}${frame.data.split('\n').map(line => `data: ${line}\n`).join('')}\n`).join('')) };
}

/** One raw frame at a time; no full-stream collection or background prefetch. */
export async function* streamMessagesToChat(source: ReadableStream<Uint8Array>, context: ResponseContext, options: StreamOptions,
  signal?: AbortSignal): AsyncGenerator<MessagesToChatChunk, void, unknown> {
  if (!Number.isSafeInteger(options.maxBufferedBytes) || options.maxBufferedBytes < 1) throw new TypeError('Invalid stream byte budget');
  const budget = new ByteBudget(options.maxBufferedBytes);
  const created = makeSession(context, options, budget);
  if (!created.ok) throw new TypeError('Invalid stream configuration');
  const session = created.value; const parser = new SseByteParser(); const pending = new BoundedByteBuffer(budget);
  let lineHasContent = false; let skipLf = false;
  try {
    for await (const bytes of readBoundedBytes(source, budget, signal)) {
      let start = 0;
      for (let index = 0; index < bytes.length; index++) {
        if (signal?.aborted) { yield chunk(session.finish({ kind: 'cancelled' })); return; }
        const byte = bytes[index];
        if (skipLf) { skipLf = false; if (byte === 10) continue; }
        if (byte !== 10 && byte !== 13) { lineHasContent = true; continue; }
        const boundary = !lineHasContent; lineHasContent = false; skipLf = byte === 13;
        if (!boundary) continue;
        pending.append(bytes.subarray(start, index + 1)); start = index + 1;
        for (const frame of parser.push(pending.drain())) {
          const step = session.push(frame);
          if (step.events.length || step.terminal || step.usageUpdates.length) yield chunk(step);
          if (step.terminal) return;
        }
      }
      pending.append(bytes.subarray(start));
    }
    parser.finish(); yield chunk(session.finish({ kind: 'eof' }));
  } catch { yield chunk(session.finish(signal?.aborted ? { kind: 'cancelled' } : { kind: 'error', error: error('transport_error') })); }
  finally { pending.cancel(); parser.finish(); session.finish({ kind: 'cancelled' }); }
}
