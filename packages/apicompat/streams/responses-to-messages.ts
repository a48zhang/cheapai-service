import { encodeErrorSseFrame } from '../errors.js';
import { isRepresentableWireId } from '../ids.js';
import { createResponsesUsageSession } from '../usage/responses.js';
import type { ResponseContext, StreamEnd, StreamOptions, StreamSession, StreamStep } from '../types/adapter.js';
import type { ConversionResult, ProtocolError, SseFrame, TerminalState, UsageSnapshot, UsageUpdate } from '../types/shared.js';
import { BoundedByteBuffer, ByteBudget, readBoundedBytes } from './buffers.js';
import { SseByteParser } from './parser.js';

/**
 * Direct Responses → Messages (Anthropic) SSE conversion. This adapter keeps
 * the source item/content state and writes Messages blocks directly; it does
 * not pass through Chat or buffer a complete response.
 *
 * The fixed Sub2API compatibility reference is recorded in
 * docs/protocol-baseline.md (LGPL commit ab99d56e9626e6cd731592dae8553c9758a0efa2).
 * This TypeScript implementation and its fixtures are original.
 */
export interface ResponsesToMessagesStep extends StreamStep<SseFrame> {
  readonly usageUpdates: readonly UsageUpdate[];
  readonly usage?: UsageSnapshot;
}
export interface ResponsesToMessagesSession {
  push(frame: SseFrame): ResponsesToMessagesStep;
  finish(end: StreamEnd): ResponsesToMessagesStep;
}
export interface ResponsesToMessagesChunk extends Omit<ResponsesToMessagesStep, 'events'> {
  readonly bytes: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const empty = (): ResponsesToMessagesStep => ({ events: [], usageUpdates: [] });
const error = (code: string): ProtocolError => ({ kind: 'stream_error', code,
  message: 'The Responses to Messages stream could not be completed safely.' });
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const index = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const safeId = (value: unknown): value is string => isRepresentableWireId(value);
const responseKeys = new Set([
  'id', 'object', 'created_at', 'model', 'status', 'output', 'usage', 'error', 'incomplete_details',
  'previous_response_id', 'completed_at', 'background', 'store', 'instructions', 'max_output_tokens',
  'max_tool_calls', 'parallel_tool_calls', 'reasoning', 'service_tier', 'temperature', 'top_p', 'text',
  'tool_choice', 'tools', 'top_logprobs', 'truncation', 'user', 'metadata', 'conversation',
  'prompt_cache_key', 'prompt_cache_retention', 'prompt_cache_options', 'safety_identifier',
]);

interface TextPart {
  readonly index: number;
  readonly blockIndex: number;
  readonly buffer: BoundedByteBuffer;
  readonly release: () => void;
  leafDone: boolean;
  closed: boolean;
}
interface MessageItem {
  readonly outputIndex: number;
  readonly id: string;
  readonly type: 'message';
  readonly parts: Map<number, TextPart>;
  readonly release: () => void;
  closed: boolean;
}
interface FunctionItem {
  readonly outputIndex: number;
  readonly id: string;
  readonly type: 'function_call';
  readonly callId: string;
  readonly name: string;
  readonly args: BoundedByteBuffer;
  readonly blockIndex: number;
  readonly release: () => void;
  argsDone: boolean;
  closed: boolean;
}
interface ReasoningPart {
  readonly index: number;
  readonly buffer: BoundedByteBuffer;
  readonly release: () => void;
  leafDone: boolean;
  closed: boolean;
}
interface ReasoningItem {
  readonly outputIndex: number;
  readonly id: string;
  readonly type: 'reasoning';
  readonly blockIndex: number;
  readonly parts: Map<number, ReasoningPart>;
  readonly release: () => void;
  closed: boolean;
}
type Item = MessageItem | FunctionItem | ReasoningItem;

function responseStatusForEvent(type: string): string | undefined {
  switch (type) {
    case 'response.created': return 'created';
    case 'response.queued': return 'queued';
    case 'response.in_progress': return 'in_progress';
    case 'response.completed': return 'completed';
    case 'response.incomplete': return 'incomplete';
    case 'response.failed': return 'failed';
    default: return undefined;
  }
}

function validResponseEnvelope(event: Record<string, unknown>, type: string): Record<string, unknown> | undefined {
  if (!Object.keys(event).every(key => key === 'type' || key === 'sequence_number' || key === 'response') || !object(event.response)) return undefined;
  const response = event.response;
  if (response.object !== 'response' || !safeId(response.id) || !text(response.model) || !response.model.trim()
    || !index(response.created_at) || !text(response.status) || !Array.isArray(response.output)
    || [...Object.keys(response)].some(key => !responseKeys.has(key))) return undefined;
  const expected = responseStatusForEvent(type);
  if (expected === 'created') {
    if (response.status !== 'queued' && response.status !== 'in_progress') return undefined;
  } else if (expected !== undefined && response.status !== expected) return undefined;
  if ((expected === 'created' || expected === 'queued' || expected === 'in_progress') && response.output.length !== 0) return undefined;
  if (response.usage !== undefined && response.usage !== null && !object(response.usage)) return undefined;
  if (response.incomplete_details !== undefined && response.incomplete_details !== null
    && (!object(response.incomplete_details) || !text(response.incomplete_details.reason))) return undefined;
  return response;
}

function validMessageItem(value: unknown, requireEmpty: boolean): value is Record<string, unknown> {
  if (!object(value) || value.type !== 'message' || !safeId(value.id) || value.role !== 'assistant'
    || (value.status !== undefined && !['in_progress', 'completed', 'incomplete'].includes(String(value.status)))) return false;
  if (!Array.isArray(value.content)) return !Object.hasOwn(value, 'content') && !requireEmpty;
  if (requireEmpty && value.content.length !== 0) return false;
  return value.content.every(part => object(part) && part.type === 'output_text' && text(part.text) && Array.isArray(part.annotations));
}

function validReasoningItem(value: unknown, requireEmpty: boolean): value is Record<string, unknown> {
  if (!object(value) || value.type !== 'reasoning' || !safeId(value.id)
    || (value.status !== undefined && !['in_progress', 'completed', 'incomplete'].includes(String(value.status)))) return false;
  if (value.encrypted_content !== undefined && value.encrypted_content !== null && value.encrypted_content !== '') return false;
  if (!Array.isArray(value.summary)) return !Object.hasOwn(value, 'summary') && !requireEmpty;
  if (requireEmpty && value.summary.length !== 0) return false;
  return value.summary.every(part => object(part) && part.type === 'summary_text' && text(part.text));
}

function validSequence(event: Record<string, unknown>, last: number): boolean {
  return index(event.sequence_number) && event.sequence_number < Number.MAX_SAFE_INTEGER && event.sequence_number > last;
}

function makeSession(context: ResponseContext, options: StreamOptions, budget: ByteBudget): ConversionResult<ResponsesToMessagesSession> {
  if (!Number.isSafeInteger(options.maxBufferedBytes) || options.maxBufferedBytes < 1
    || !['ignore', 'reject', 'preserve'].includes(options.unknownEventPolicy)
    || !safeId(context.identity?.responseId) || typeof context.targetModel !== 'string' || !context.targetModel.trim()
    || context.targetModel.length > 512 || /[\u0000-\u001f\u007f]/u.test(context.targetModel)
    || !Number.isSafeInteger(context.createdAt) || context.createdAt < 0 || typeof context.idFor !== 'function') {
    return { ok: false, error: error('invalid_stream_configuration') };
  }
  const id = context.identity.responseId;
  const model = context.targetModel;
  const max = options.maxBufferedBytes;
  const policy = options.unknownEventPolicy;
  const usage = createResponsesUsageSession();
  const items = new Map<number, Item>();
  const itemIds = new Set<string>();
  const callIds = new Set<string>();
  const releases: (() => void)[] = [];
  let started = false;
  let closed = false;
  let lastSequence = -1;
  let upstreamId = context.identity.upstreamResponseId;
  let nextOutputIndex = 0;
  let nextBlockIndex = 0;
  let hasTool = false;
  let parsedFrame = false;

  const emit = (type: string, fields: object = {}): SseFrame => ({ event: type, data: JSON.stringify({ type, ...fields }) });
  const messageStart = (): SseFrame => emit('message_start', { message: { id, type: 'message', role: 'assistant', model,
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  function releaseState(): void {
    for (const item of items.values()) {
      if (item.type === 'message') for (const part of item.parts.values()) { part.buffer.cancel(); part.release(); }
      else if (item.type === 'function_call') item.args.cancel();
      else for (const part of item.parts.values()) { part.buffer.cancel(); part.release(); }
      item.release();
    }
    items.clear(); itemIds.clear(); callIds.clear();
    for (const release of releases) release();
    releases.length = 0;
  }
  function close(terminal: TerminalState, events: SseFrame[]): ResponsesToMessagesStep {
    closed = true; releaseState();
    return { events, terminal, usageUpdates: [] };
  }
  function fail(code: string): ResponsesToMessagesStep {
    const problem = error(code);
    return close({ status: 'failed', error: problem }, [encodeErrorSseFrame('messages', problem)]);
  }
  function sourceIdentity(response: Record<string, unknown>): boolean {
    if (!safeId(response.id) || (upstreamId !== undefined && response.id !== upstreamId)) return false;
    upstreamId ??= response.id;
    return true;
  }
  function partText(part: TextPart): string {
    const bytes = part.buffer.drain();
    const value = decoder.decode(bytes);
    part.buffer.appendText(value);
    return value;
  }
  function reasoningText(part: ReasoningPart): string {
    const bytes = part.buffer.drain();
    const value = decoder.decode(bytes);
    part.buffer.appendText(value);
    return value;
  }
  function functionArgs(item: FunctionItem): string {
    const bytes = item.args.drain();
    const value = decoder.decode(bytes);
    item.args.appendText(value);
    return value;
  }
  function targetUsage(snapshot: UsageSnapshot): object | undefined {
    if (snapshot.quality === 'missing' || snapshot.quality === 'invalid' || snapshot.counts.outputTokens === undefined) return undefined;
    const counts = snapshot.counts;
    let input = counts.inputTokens;
    if (input !== undefined) {
      const cache = (counts.cacheReadTokens ?? 0) + (counts.cacheWriteTokens ?? 0);
      input -= cache;
      if (!Number.isSafeInteger(input) || input < 0) return undefined;
    }
    return { ...(input === undefined ? {} : { input_tokens: input }), output_tokens: counts.outputTokens,
      ...(counts.cacheReadTokens === undefined ? {} : { cache_read_input_tokens: counts.cacheReadTokens }),
      ...(counts.cacheWriteTokens === undefined ? {} : { cache_creation_input_tokens: counts.cacheWriteTokens }),
      ...(counts.reasoningTokens === undefined ? {} : { output_tokens_details: { thinking_tokens: counts.reasoningTokens } }) };
  }
  function terminalFor(response: Record<string, unknown>): { terminal: TerminalState; stopReason: string } | undefined {
    if (response.status === 'completed') return { terminal: { status: 'completed', reason: hasTool ? 'tool_calls' : 'stop' }, stopReason: hasTool ? 'tool_use' : 'end_turn' };
    if (response.status === 'incomplete') {
      const reason = object(response.incomplete_details) ? response.incomplete_details.reason : undefined;
      if (reason === 'max_output_tokens') return { terminal: { status: 'incomplete', reason: 'length', upstreamReason: reason }, stopReason: 'max_tokens' };
      if (reason === 'content_filter') return { terminal: { status: 'incomplete', reason: 'content_filter', upstreamReason: reason }, stopReason: 'end_turn' };
      if (reason === 'refusal') return { terminal: { status: 'incomplete', reason: 'refusal', upstreamReason: reason }, stopReason: 'refusal' };
      return undefined;
    }
    if (response.status === 'failed') return { terminal: { status: 'failed', error: error('upstream_error') }, stopReason: 'end_turn' };
    return undefined;
  }
  function finishResponse(response: Record<string, unknown>): ResponsesToMessagesStep {
    const mapped = terminalFor(response);
    if (!mapped) return fail('unsupported_finish_reason');
    if (mapped.terminal.status === 'failed') return close(mapped.terminal, [encodeErrorSseFrame('messages', mapped.terminal.error)]);
    if (mapped.terminal.status === 'incomplete' && mapped.terminal.reason === 'content_filter') {
      return close(mapped.terminal, [encodeErrorSseFrame('messages', error('unrepresentable_content_filter'))]);
    }
    if (mapped.terminal.status === 'completed' && [...items.values()].some(item => !item.closed)) return fail('unclosed_output_items');
    const updates: SseFrame[] = [];
    if (mapped.terminal.status === 'incomplete') {
      for (const item of items.values()) {
        if (item.type === 'function_call') {
          if (!item.closed) { updates.push(emit('content_block_stop', { index: item.blockIndex })); item.closed = true; }
        } else if (item.type === 'message') {
          for (const part of item.parts.values()) {
            if (!part.closed) { updates.push(emit('content_block_stop', { index: part.blockIndex })); part.closed = true; }
          }
        } else if (!item.closed) { updates.push(emit('content_block_stop', { index: item.blockIndex })); item.closed = true; }
        }
      }
    const snapshot = usage.finish(mapped.terminal);
    const wireUsage = targetUsage(snapshot);
    updates.push(emit('message_delta', { delta: { stop_reason: mapped.stopReason, stop_sequence: null }, ...(wireUsage === undefined ? {} : { usage: wireUsage }) }), emit('message_stop'));
    return close(mapped.terminal, updates);
  }

  const wire: { push(frame: SseFrame): ResponsesToMessagesStep; finish(end: StreamEnd): ResponsesToMessagesStep } = {
    push(frame) {
      parsedFrame = false;
      if (closed) return empty();
      let release: (() => void) | undefined;
      try {
        if (!text(frame.data) || encoder.encode(frame.data).byteLength > max) return fail('frame_limit_exceeded');
        release = budget.reserve(encoder.encode(frame.data).byteLength);
        if (frame.data === '[DONE]') return fail('unexpected_done_marker');
        const raw: unknown = JSON.parse(frame.data);
        if (!object(raw) || !text(raw.type) || (frame.event !== undefined && frame.event !== raw.type)) return fail('invalid_event');
        const type = raw.type;
        const known = new Set([
          'response.created', 'response.queued', 'response.in_progress', 'response.completed', 'response.incomplete', 'response.failed', 'error',
          'response.output_item.added', 'response.output_item.done', 'response.content_part.added', 'response.content_part.done',
          'response.output_text.delta', 'response.output_text.done', 'response.refusal.delta', 'response.refusal.done',
          'response.function_call_arguments.delta', 'response.function_call_arguments.done',
          'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done', 'response.reasoning_summary_text.delta',
          'response.reasoning_summary_text.done',
        ]);
        if (!known.has(type)) return policy === 'ignore' ? empty() : fail('unsupported_event');
        if (type === 'error') return fail('upstream_error');
        if (!validSequence(raw, lastSequence)) return fail('invalid_event_sequence');
        lastSequence = raw.sequence_number as number;
        const responseType = responseStatusForEvent(type);
        if (responseType !== undefined) {
          const response = validResponseEnvelope(raw, type);
          if (!response || !sourceIdentity(response)) return fail('invalid_response_envelope');
          parsedFrame = true;
          if (type === 'response.created') {
            if (started) return fail('duplicate_response_start');
            started = true;
            return { events: [messageStart()], usageUpdates: [] };
          }
          if (!started) return fail('missing_response_start');
          if (type === 'response.queued' || type === 'response.in_progress') return { events: [], usageUpdates: [] };
          const terminalUpdates = usage.push(raw);
          return { ...finishResponse(response), usageUpdates: terminalUpdates };
        }
        if (!started || !index(raw.output_index)) return fail('missing_response_start');
        const outputIndex = raw.output_index as number;
        if (type === 'response.output_item.added') {
          if (!Object.keys(raw).every(key => ['type', 'sequence_number', 'output_index', 'item'].includes(key))
            || outputIndex !== nextOutputIndex || items.has(outputIndex) || !object(raw.item) || !safeId(raw.item.id) || itemIds.has(raw.item.id)) return fail('invalid_output_item');
          const itemRelease = budget.reserve(64);
          const identityRelease = budget.reserve(128 + encoder.encode(raw.item.id as string).byteLength);
          releases.push(identityRelease);
          let item: Item;
          if (raw.item.type === 'message') {
            if (!validMessageItem(raw.item, true)) return fail('invalid_output_item');
            item = { outputIndex, id: raw.item.id as string, type: 'message', parts: new Map(), release: itemRelease, closed: false };
          } else if (raw.item.type === 'function_call') {
            if (!Object.keys(raw.item).every(key => ['type', 'id', 'call_id', 'name', 'arguments', 'status'].includes(key))
              || !safeId(raw.item.call_id) || callIds.has(raw.item.call_id) || !text(raw.item.name) || !raw.item.name || raw.item.name.length > 64
              || /[^A-Za-z0-9_-]/u.test(raw.item.name) || !text(raw.item.arguments)
              || (raw.item.status !== undefined && raw.item.status !== 'in_progress')) return fail('invalid_output_item');
            hasTool = true; callIds.add(raw.item.call_id as string);
            const args = new BoundedByteBuffer(budget);
            if (raw.item.arguments) args.appendText(raw.item.arguments);
            item = { outputIndex, id: raw.item.id as string, type: 'function_call', callId: raw.item.call_id as string,
              name: raw.item.name, args, blockIndex: nextBlockIndex++, release: itemRelease, argsDone: false, closed: false };
          } else if (raw.item.type === 'reasoning') {
            if (!validReasoningItem(raw.item, true)) return fail('unsupported_private_reasoning');
            item = { outputIndex, id: raw.item.id as string, type: 'reasoning', blockIndex: nextBlockIndex++, parts: new Map(), release: itemRelease, closed: false };
          } else return fail('unsupported_output_item');
          itemIds.add(raw.item.id as string); items.set(outputIndex, item); nextOutputIndex += 1; parsedFrame = true;
          if (item.type === 'function_call') {
            return { events: [emit('content_block_start', { index: item.blockIndex, content_block: { type: 'tool_use', id: item.callId, name: item.name, input: {} } })], usageUpdates: [] };
          }
          if (item.type === 'reasoning') {
            return { events: [emit('content_block_start', { index: item.blockIndex, content_block: { type: 'thinking', thinking: '', signature: '' } })], usageUpdates: [] };
          }
          return { events: [], usageUpdates: [] };
        }
        const item = items.get(outputIndex);
        if (type === 'response.output_item.done') {
          if (!item || item.closed || !Object.keys(raw).every(key => ['type', 'sequence_number', 'output_index', 'item'].includes(key)) || !object(raw.item)
            || raw.item.id !== item.id || raw.item.type !== item.type) return fail('invalid_item_completion');
          if (item.type === 'function_call') {
            if (!Object.keys(raw.item).every(key => ['type', 'id', 'call_id', 'name', 'arguments', 'status'].includes(key))
              || raw.item.call_id !== item.callId || raw.item.name !== item.name || !text(raw.item.arguments)
              || raw.item.status === 'in_progress') return fail('invalid_item_completion');
            const current = functionArgs(item);
            if (current && current !== raw.item.arguments) return fail('tool_arguments_mismatch');
            if (!current) item.args.appendText(raw.item.arguments);
            item.argsDone = true; item.closed = true; parsedFrame = true;
            return { events: [emit('content_block_stop', { index: item.blockIndex })], usageUpdates: [] };
          }
          if (item.type === 'reasoning') {
            if (!validReasoningItem(raw.item, false) || !Array.isArray(raw.item.summary)
              || (raw.item.encrypted_content !== undefined && raw.item.encrypted_content !== null && raw.item.encrypted_content !== '')
              || [...item.parts.values()].some(part => !part.closed)) return fail('invalid_reasoning_completion');
            const summary = raw.item.summary;
            const partIndexes = [...item.parts.keys()];
            if (summary.length !== item.parts.size || summary.some((part, partIndex) => !object(part) || part.type !== 'summary_text'
              || !text(part.text) || partIndex !== partIndexes[partIndex])) return fail('reasoning_summary_mismatch');
            item.closed = true; parsedFrame = true;
            return { events: [emit('content_block_stop', { index: item.blockIndex })], usageUpdates: [] };
          }
          if (!validMessageItem(raw.item, false) || [...item.parts.values()].some(part => !part.closed)) return fail('invalid_item_completion');
          const content = Array.isArray(raw.item.content) ? raw.item.content : [];
          const partIndexes = [...item.parts.keys()];
          if (content.length !== item.parts.size || content.some((part, partIndex) => !object(part) || part.type !== 'output_text' || !text(part.text)
            || !Array.isArray(part.annotations) || partIndex !== partIndexes[partIndex])) return fail('item_content_mismatch');
          item.closed = true; parsedFrame = true;
          return { events: [], usageUpdates: [] };
        }
        if (!item || item.closed || !safeId(raw.item_id) || raw.item_id !== item.id) return fail('invalid_item_reference');
        if (item.type === 'reasoning') {
          if (!type.startsWith('response.reasoning_summary_') || !index(raw.summary_index)) return fail('invalid_reasoning_reference');
          const summaryIndex = raw.summary_index as number;
          if (type === 'response.reasoning_summary_part.added') {
            if (summaryIndex !== item.parts.size || !Object.keys(raw).every(key => ['type', 'sequence_number', 'output_index', 'item_id', 'summary_index', 'part'].includes(key))
              || !object(raw.part) || raw.part.type !== 'summary_text' || raw.part.text !== '') return fail('invalid_reasoning_part');
            const partRelease = budget.reserve(64);
            item.parts.set(summaryIndex, { index: summaryIndex, buffer: new BoundedByteBuffer(budget), release: partRelease, leafDone: false, closed: false });
            parsedFrame = true; return { events: [], usageUpdates: [] };
          }
          const part = item.parts.get(summaryIndex);
          if (!part || part.closed) return fail('invalid_reasoning_reference');
          if (type === 'response.reasoning_summary_text.delta') {
            if (!Object.keys(raw).every(key => ['type', 'sequence_number', 'output_index', 'item_id', 'summary_index', 'delta'].includes(key)) || !text(raw.delta)) return fail('invalid_reasoning_delta');
            if (!raw.delta) { parsedFrame = true; return { events: [], usageUpdates: [] }; }
            part.buffer.appendText(raw.delta); parsedFrame = true;
            return { events: [emit('content_block_delta', { index: item.blockIndex, delta: { type: 'thinking_delta', thinking: raw.delta } })], usageUpdates: [] };
          }
          if (type === 'response.reasoning_summary_text.done') {
            if (!Object.keys(raw).every(key => ['type', 'sequence_number', 'output_index', 'item_id', 'summary_index', 'text'].includes(key)) || !text(raw.text)
              || reasoningText(part) !== raw.text) return fail('invalid_reasoning_completion');
            part.leafDone = true; parsedFrame = true; return { events: [], usageUpdates: [] };
          }
          if (type === 'response.reasoning_summary_part.done') {
            if (!Object.keys(raw).every(key => ['type', 'sequence_number', 'output_index', 'item_id', 'summary_index', 'part'].includes(key))
              || !object(raw.part) || raw.part.type !== 'summary_text' || !text(raw.part.text) || !part.leafDone || reasoningText(part) !== raw.part.text) return fail('invalid_reasoning_completion');
            part.closed = true; part.buffer.cancel(); part.release(); parsedFrame = true; return { events: [], usageUpdates: [] };
          }
          return fail('unsupported_reasoning_event');
        }
        if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
          if (item.type !== 'function_call') return fail('invalid_tool_reference');
          const done = type.endsWith('.done');
          if (!Object.keys(raw).every(key => ['type', 'sequence_number', 'output_index', 'item_id', done ? 'arguments' : 'delta', ...(done ? ['name'] : [])].includes(key))
            || !text(done ? raw.arguments : raw.delta)) return fail('invalid_tool_event');
          if (done) {
            if (raw.name !== undefined && raw.name !== item.name) return fail('tool_name_mismatch');
            const current = functionArgs(item);
            if (current && current !== raw.arguments) return fail('tool_arguments_mismatch');
            if (!current) item.args.appendText(raw.arguments as string);
            item.argsDone = true; parsedFrame = true;
            return { events: [], usageUpdates: [] };
          }
          const fragment = raw.delta as string;
          if (!fragment) { parsedFrame = true; return { events: [], usageUpdates: [] }; }
          item.args.appendText(fragment); parsedFrame = true;
          return { events: [emit('content_block_delta', { index: item.blockIndex, delta: { type: 'input_json_delta', partial_json: fragment } })], usageUpdates: [] };
        }
        if (item.type !== 'message') return fail('invalid_item_reference');
        if (type === 'response.content_part.added') {
          if (!Object.keys(raw).every(key => ['type', 'sequence_number', 'output_index', 'item_id', 'content_index', 'part'].includes(key))
            || !index(raw.content_index) || raw.content_index !== item.parts.size || !object(raw.part) || raw.part.type !== 'output_text'
            || raw.part.text !== '' || !Array.isArray(raw.part.annotations)) return fail('invalid_content_part');
          const blockIndex = nextBlockIndex++; const partRelease = budget.reserve(64);
          const part: TextPart = { index: raw.content_index as number, blockIndex, buffer: new BoundedByteBuffer(budget), release: partRelease, leafDone: false, closed: false };
          item.parts.set(part.index, part); parsedFrame = true;
          return { events: [emit('content_block_start', { index: blockIndex, content_block: { type: 'text', text: '' } })], usageUpdates: [] };
        }
        if (!index(raw.content_index)) return fail('invalid_content_index');
        const part = item.parts.get(raw.content_index);
        if (!part || part.closed) return fail('invalid_content_reference');
        if (type === 'response.output_text.delta') {
          if (!Object.keys(raw).every(key => ['type', 'sequence_number', 'output_index', 'item_id', 'content_index', 'delta'].includes(key)) || !text(raw.delta)) return fail('invalid_content_delta');
          if (!raw.delta) { parsedFrame = true; return { events: [], usageUpdates: [] }; }
          part.buffer.appendText(raw.delta); parsedFrame = true;
          return { events: [emit('content_block_delta', { index: part.blockIndex, delta: { type: 'text_delta', text: raw.delta } })], usageUpdates: [] };
        }
        if (type === 'response.output_text.done') {
          if (!Object.keys(raw).every(key => ['type', 'sequence_number', 'output_index', 'item_id', 'content_index', 'text'].includes(key)) || !text(raw.text)
            || partText(part) !== raw.text) return fail('invalid_content_completion');
          part.leafDone = true; parsedFrame = true;
          return { events: [], usageUpdates: [] };
        }
        if (type === 'response.content_part.done') {
          if (!Object.keys(raw).every(key => ['type', 'sequence_number', 'output_index', 'item_id', 'content_index', 'part'].includes(key))
            || !object(raw.part) || raw.part.type !== 'output_text' || !text(raw.part.text) || !Array.isArray(raw.part.annotations)
            || !part.leafDone || partText(part) !== raw.part.text) return fail('invalid_content_completion');
          part.closed = true; part.buffer.cancel(); part.release(); parsedFrame = true;
          return { events: [emit('content_block_stop', { index: part.blockIndex })], usageUpdates: [] };
        }
        return fail('unsupported_event');
      } catch { return fail('invalid_or_oversized_event'); }
      finally { release?.(); }
    },
    finish(end) {
      if (closed) return empty();
      if (end.kind === 'cancelled') return close({ status: 'cancelled' }, []);
      if (end.kind === 'error') return fail('transport_error');
      return close({ status: 'incomplete', reason: 'unexpected_eof' }, [encodeErrorSseFrame('messages', error('unexpected_eof'))]);
    },
  };

  let usageFinished = false;
  function withUsage(step: StreamStep<SseFrame>, updates: readonly UsageUpdate[]): ResponsesToMessagesStep {
    if (!step.terminal) return { ...step, usageUpdates: updates };
    usageFinished = true;
    return { ...step, usageUpdates: updates, usage: usage.finish(step.terminal) };
  }
  return { ok: true, value: {
    push(frame) {
      if (usageFinished) return empty();
      const step = wire.push(frame);
      return withUsage(step, step.usageUpdates.length ? step.usageUpdates : parsedFrame ? usage.push(frame) : []);
    },
    finish(end) {
      if (usageFinished) return empty();
      return withUsage(wire.finish(end), []);
    },
  } };
}

export function createResponsesToMessagesSession(context: ResponseContext, options: StreamOptions): ConversionResult<ResponsesToMessagesSession> {
  if (!Number.isSafeInteger(options.maxBufferedBytes) || options.maxBufferedBytes < 1) return { ok: false, error: error('invalid_stream_configuration') };
  return makeSession(context, options, new ByteBudget(options.maxBufferedBytes));
}
export const responsesToMessagesStreamAdapter = Object.freeze({ from: 'responses' as const, to: 'messages' as const, create: createResponsesToMessagesSession });

function chunk(step: ResponsesToMessagesStep): ResponsesToMessagesChunk {
  const { events, ...metadata } = step;
  return { ...metadata, bytes: encoder.encode(events.map(frame => `${frame.event ? `event: ${frame.event}\n` : ''}data: ${frame.data}\n\n`).join('')) };
}

/** Incremental SSE bridge with bounded framing, backpressure and cancellation. */
export async function* streamResponsesToMessages(
  source: ReadableStream<Uint8Array>, context: ResponseContext, options: StreamOptions, signal?: AbortSignal,
): AsyncGenerator<ResponsesToMessagesChunk, void, unknown> {
  if (!Number.isSafeInteger(options.maxBufferedBytes) || options.maxBufferedBytes < 1) throw new TypeError('Invalid Responses to Messages stream configuration');
  const budget = new ByteBudget(options.maxBufferedBytes);
  const created = makeSession(context, options, budget);
  if (!created.ok) throw new TypeError('Invalid Responses to Messages stream configuration');
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
