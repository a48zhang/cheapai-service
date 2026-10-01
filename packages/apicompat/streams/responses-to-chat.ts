import { encodeErrorSseFrame } from '../errors.js';
import { isRepresentableWireId } from '../ids.js';
import { createResponsesUsageSession } from '../usage/responses.js';
import type { ResponseContext, StreamEnd, StreamOptions, StreamSession, StreamStep } from '../types/adapter.js';
import type { ConversionResult, ProtocolError, SseFrame, TerminalState, UsageSnapshot, UsageUpdate } from '../types/shared.js';
import { BoundedByteBuffer, ByteBudget, readBoundedBytes } from './buffers.js';
import { SseByteParser } from './parser.js';

/**
 * Direct Responses → Chat Completions stream conversion. The state machine
 * consumes native Responses events and writes Chat chunks directly; it does
 * not route through another wire representation or collect the response.
 *
 * Behaviour is based on the fixed Sub2API compatibility reference listed in
 * docs/protocol-baseline.md (LGPL source commit ab99d56e9626e6cd731592dae8553c9758a0efa2).
 * The implementation and fixtures here are original TypeScript work.
 */
export interface ResponsesToChatStep extends StreamStep<SseFrame> {
  readonly usageUpdates: readonly UsageUpdate[];
  readonly usage?: UsageSnapshot;
}
export interface ResponsesToChatSession {
  push(frame: SseFrame): ResponsesToChatStep;
  finish(end: StreamEnd): ResponsesToChatStep;
}
export interface ResponsesToChatChunk extends Omit<ResponsesToChatStep, 'events'> {
  readonly bytes: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const empty = (): ResponsesToChatStep => ({ events: [], usageUpdates: [] });
const error = (code: string): ProtocolError => ({
  kind: 'stream_error', code,
  message: 'The Responses to Chat stream could not be completed safely.',
});
const safeId = (value: unknown): value is string => isRepresentableWireId(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const index = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === 'string';

const responseKeys = new Set([
  'id', 'object', 'created_at', 'model', 'status', 'output', 'usage', 'error', 'incomplete_details',
  'previous_response_id', 'completed_at', 'background', 'store', 'instructions', 'max_output_tokens',
  'max_tool_calls', 'parallel_tool_calls', 'reasoning', 'service_tier', 'temperature', 'top_p', 'text',
  'tool_choice', 'tools', 'top_logprobs', 'truncation', 'user', 'metadata', 'conversation',
  'prompt_cache_key', 'prompt_cache_retention', 'prompt_cache_options', 'safety_identifier',
]);

interface Part {
  readonly index: number;
  readonly type: 'output_text' | 'refusal';
  readonly buffer: BoundedByteBuffer;
  readonly release: () => void;
  leafDone: boolean;
  closed: boolean;
}
interface MessageItem {
  readonly outputIndex: number;
  readonly id: string;
  readonly type: 'message';
  readonly release: () => void;
  readonly parts: Map<number, Part>;
  closed: boolean;
}
interface FunctionItem {
  readonly outputIndex: number;
  readonly id: string;
  readonly type: 'function_call';
  readonly callId: string;
  readonly name: string;
  readonly args: BoundedByteBuffer;
  readonly release: () => void;
  readonly toolIndex: number;
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
  readonly release: () => void;
  readonly parts: Map<number, ReasoningPart>;
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
  if (!Object.keys(event).every(key => key === 'type' || key === 'sequence_number' || key === 'response')) return undefined;
  if (!object(event.response) || event.response.object !== 'response' || !safeId(event.response.id)
    || !text(event.response.model) || !event.response.model.trim() || !index(event.response.created_at)
    || !text(event.response.status) || !Array.isArray(event.response.output)) return undefined;
  if ([...Object.keys(event.response)].some(key => !responseKeys.has(key))) return undefined;
  const expected = responseStatusForEvent(type);
  if (expected === 'created') {
    if (event.response.status !== 'queued' && event.response.status !== 'in_progress') return undefined;
  } else if (expected !== undefined && event.response.status !== expected) return undefined;
  if ((expected === 'created' || expected === 'queued' || expected === 'in_progress') && event.response.output.length !== 0) return undefined;
  if (event.response.usage !== undefined && event.response.usage !== null && !object(event.response.usage)) return undefined;
  if (event.response.service_tier !== undefined && event.response.service_tier !== null && !text(event.response.service_tier)) return undefined;
  if (event.response.incomplete_details !== undefined && event.response.incomplete_details !== null
    && (!object(event.response.incomplete_details) || !text(event.response.incomplete_details.reason))) return undefined;
  return event.response;
}

function validMessageItem(value: unknown, requireEmpty: boolean): value is Record<string, unknown> {
  if (!object(value) || value.type !== 'message' || !safeId(value.id) || value.role !== 'assistant'
    || (value.status !== undefined && !['in_progress', 'completed', 'incomplete'].includes(String(value.status)))) return false;
  if (!Array.isArray(value.content)) return !Object.hasOwn(value, 'content') && !requireEmpty;
  if (requireEmpty && value.content.length !== 0) return false;
  return value.content.every(part => object(part) && ((part.type === 'output_text' && text(part.text) && Array.isArray(part.annotations))
    || (part.type === 'refusal' && text(part.refusal))));
}

function validReasoningItem(value: unknown, requireEmpty: boolean): value is Record<string, unknown> {
  if (!object(value) || value.type !== 'reasoning' || !safeId(value.id)
    || (value.status !== undefined && !['in_progress', 'completed', 'incomplete'].includes(String(value.status)))) return false;
  if (value.encrypted_content !== undefined && value.encrypted_content !== null && !text(value.encrypted_content)) return false;
  if (!Array.isArray(value.summary)) return !Object.hasOwn(value, 'summary') && !requireEmpty;
  if (requireEmpty && value.summary.length !== 0) return false;
  return value.summary.every(part => object(part) && part.type === 'summary_text' && text(part.text));
}

function validEventSequence(event: Record<string, unknown>, last: number): boolean {
  return index(event.sequence_number) && event.sequence_number < Number.MAX_SAFE_INTEGER && event.sequence_number > last;
}

function makeSession(context: ResponseContext, options: StreamOptions, budget: ByteBudget): ConversionResult<ResponsesToChatSession> {
  if (!Number.isSafeInteger(options.maxBufferedBytes) || options.maxBufferedBytes < 1
    || !['ignore', 'reject', 'preserve'].includes(options.unknownEventPolicy)
    || !safeId(context.identity?.responseId) || typeof context.targetModel !== 'string' || !context.targetModel.trim()
    || context.targetModel.length > 512 || /[\u0000-\u001f\u007f]/u.test(context.targetModel)
    || !Number.isSafeInteger(context.createdAt) || context.createdAt < 0 || typeof context.idFor !== 'function') {
    return { ok: false, error: error('invalid_stream_configuration') };
  }
  const id = context.identity.responseId;
  const model = context.targetModel;
  const created = context.createdAt;
  const max = options.maxBufferedBytes;
  const policy = options.unknownEventPolicy;
  const usage = createResponsesUsageSession();
  const items = new Map<number, Item>();
  const releases: (() => void)[] = [];
  const itemIds = new Set<string>();
  const callIds = new Set<string>();
  let started = false;
  let closed = false;
  let lastSequence = -1;
  let upstreamId = context.identity.upstreamResponseId;
  let nextOutputIndex = 0;
  let parsedFrame = false;
  let serviceTier: string | undefined;
  let hasTool = false;
  let hasRefusal = false;
  let nextToolIndex = 0;

  const chat = (delta: object, finishReason: string | null = null, choices = true, usageBody?: object): SseFrame => ({
    data: JSON.stringify({ id, object: 'chat.completion.chunk', created, model,
      ...(serviceTier === undefined ? {} : { service_tier: serviceTier }),
      choices: choices ? [{ index: 0, delta, finish_reason: finishReason }] : [],
      ...(usageBody === undefined ? {} : { usage: usageBody }) }),
  });

  function releaseState(): void {
    for (const item of items.values()) {
      if (item.type === 'message') for (const part of item.parts.values()) { part.buffer.cancel(); part.release(); }
      else if (item.type === 'function_call') item.args.cancel();
      else for (const part of item.parts.values()) { part.buffer.cancel(); part.release(); }
      item.release();
    }
    items.clear();
    itemIds.clear(); callIds.clear();
    for (const release of releases) release();
    releases.length = 0;
  }
  function close(terminal: TerminalState, events: SseFrame[]): ResponsesToChatStep {
    closed = true;
    releaseState();
    return { events, terminal, usageUpdates: [] };
  }
  function fail(code: string): ResponsesToChatStep {
    const problem = error(code);
    return close({ status: 'failed', error: problem }, [encodeErrorSseFrame('chat', problem)]);
  }
  function checkSourceIdentity(response: Record<string, unknown>): boolean {
    if (!safeId(response.id)) return false;
    if (upstreamId !== undefined && response.id !== upstreamId) return false;
    upstreamId ??= response.id;
    if (response.service_tier !== undefined && response.service_tier !== null) serviceTier = response.service_tier as string;
    return true;
  }
  function partText(part: Part): string {
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
  function validPartEvent(event: Record<string, unknown>, partType: string): boolean {
    return Object.keys(event).every(key => ['type', 'sequence_number', 'output_index', 'item_id', 'content_index', 'part'].includes(key))
      && index(event.output_index) && safeId(event.item_id) && index(event.content_index) && object(event.part)
      && event.part.type === partType;
  }
  function terminalFor(response: Record<string, unknown>): { terminal: TerminalState; finishReason: string } | undefined {
    const status = response.status;
    if (status === 'completed') {
      if (hasRefusal) return { terminal: { status: 'incomplete', reason: 'refusal' }, finishReason: 'stop' };
      const reason = hasTool ? 'tool_calls' : 'stop';
      return { terminal: { status: 'completed', reason }, finishReason: reason };
    }
    if (status === 'incomplete') {
      const reason = object(response.incomplete_details) ? response.incomplete_details.reason : undefined;
      if (reason === 'max_output_tokens') return { terminal: { status: 'incomplete', reason: 'length', upstreamReason: reason }, finishReason: 'length' };
      if (reason === 'content_filter') return { terminal: { status: 'incomplete', reason: 'content_filter', upstreamReason: reason }, finishReason: 'content_filter' };
      if (reason === 'refusal') return { terminal: { status: 'incomplete', reason: 'refusal', upstreamReason: reason }, finishReason: 'stop' };
      return undefined;
    }
    if (status === 'failed') return { terminal: { status: 'failed', error: error('upstream_error') }, finishReason: 'stop' };
    return undefined;
  }
  function finishResponse(response: Record<string, unknown>): ResponsesToChatStep {
    if (!checkSourceIdentity(response)) return fail('upstream_identity_mismatch');
    const mapped = terminalFor(response);
    if (!mapped) return fail('unsupported_finish_reason');
    if (mapped.terminal.status === 'failed') return close(mapped.terminal, [encodeErrorSseFrame('chat', mapped.terminal.error)]);
    if (mapped.terminal.status === 'incomplete' && mapped.terminal.reason === 'refusal' && !hasRefusal) return fail('missing_refusal_payload');
    if (mapped.terminal.status === 'completed' && [...items.values()].some(item => !item.closed)) return fail('unclosed_output_items');
    if (mapped.terminal.status === 'completed' && Array.isArray(response.output) && response.output.length !== items.size) return fail('terminal_output_mismatch');
    const events: SseFrame[] = [chat({}, mapped.finishReason), { data: '[DONE]' }];
    return close(mapped.terminal, events);
  }

  const wire: StreamSession<SseFrame, SseFrame> = {
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
          'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done', 'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done',
        ]);
        if (!known.has(type)) return policy === 'ignore' ? empty() : fail('unsupported_event');
        if (type === 'error') return fail('upstream_error');
        if (!validEventSequence(raw, lastSequence)) return fail('invalid_event_sequence');
        lastSequence = raw.sequence_number as number;
        const responseType = responseStatusForEvent(type);
        if (responseType !== undefined) {
          const response = validResponseEnvelope(raw, type);
          if (!response || !checkSourceIdentity(response)) return fail('invalid_response_envelope');
          parsedFrame = true;
          if (type === 'response.created') {
            if (started) return fail('duplicate_response_start');
            started = true;
            return { events: [chat({ role: 'assistant' })], usageUpdates: [] };
          }
          if (!started) return fail('missing_response_start');
          if (type === 'response.queued' || type === 'response.in_progress') return { events: [], usageUpdates: [] };
          return { ...finishResponse(response), usageUpdates: [] };
        }
        if (!started) return fail('missing_response_start');
        if (!index(raw.output_index)) return fail('invalid_output_index');
        const outputIndex = raw.output_index as number;
        if (type === 'response.output_item.added') {
          if (!Object.keys(raw).every(key => ['type', 'sequence_number', 'output_index', 'item'].includes(key))
            || outputIndex !== nextOutputIndex || items.has(outputIndex) || !object(raw.item) || !safeId(raw.item.id) || itemIds.has(raw.item.id)) return fail('invalid_output_item');
          const releaseIdentity = budget.reserve(128 + encoder.encode(raw.item.id as string).byteLength);
          releases.push(releaseIdentity);
          const itemRelease = budget.reserve(64);
          let item: Item;
          if (raw.item.type === 'message') {
            if (!validMessageItem(raw.item, true)) return fail('invalid_output_item');
            item = { outputIndex, id: raw.item.id as string, type: 'message', release: itemRelease, parts: new Map(), closed: false };
          } else if (raw.item.type === 'function_call') {
            if (!Object.keys(raw.item).every(key => ['type', 'id', 'call_id', 'name', 'arguments', 'status'].includes(key))
              || !safeId(raw.item.call_id) || !text(raw.item.name) || !raw.item.name || raw.item.name.length > 64
              || /[^A-Za-z0-9_-]/u.test(raw.item.name) || !text(raw.item.arguments)
              || callIds.has(raw.item.call_id) || (raw.item.status !== undefined && raw.item.status !== 'in_progress')) return fail('invalid_output_item');
            hasTool = true;
            callIds.add(raw.item.call_id as string);
            const args = new BoundedByteBuffer(budget);
            if (raw.item.arguments) args.appendText(raw.item.arguments);
            item = { outputIndex, id: raw.item.id as string, type: 'function_call', callId: raw.item.call_id as string,
              name: raw.item.name, args, release: itemRelease, toolIndex: nextToolIndex++, argsDone: false, closed: false };
          } else if (raw.item.type === 'reasoning') {
            if (!validReasoningItem(raw.item, true) || (raw.item.encrypted_content !== undefined && raw.item.encrypted_content !== null)) return fail('unsupported_private_reasoning');
            item = { outputIndex, id: raw.item.id as string, type: 'reasoning', release: itemRelease, parts: new Map(), closed: false };
          } else return fail('unsupported_output_item');
          itemIds.add(raw.item.id as string); items.set(outputIndex, item); nextOutputIndex += 1; parsedFrame = true;
          if (item.type === 'function_call') {
            const initial = raw.item.arguments as string;
            return { events: [chat({ tool_calls: [{ index: item.toolIndex, id: item.callId, type: 'function', function: { name: item.name, arguments: initial } }] })], usageUpdates: [] };
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
              || (raw.item.status !== undefined && raw.item.status === 'in_progress')) return fail('invalid_item_completion');
            const current = functionArgs(item);
            if (current && current !== raw.item.arguments) return fail('tool_arguments_mismatch');
            if (!current) item.args.appendText(raw.item.arguments);
            item.argsDone = true; item.closed = true; parsedFrame = true;
            return { events: [], usageUpdates: [] };
          }
          if (item.type === 'reasoning') {
            if (!validReasoningItem(raw.item, false) || (raw.item.encrypted_content !== undefined && raw.item.encrypted_content !== null)
              || [...item.parts.values()].some(partValue => !partValue.closed)) return fail('invalid_reasoning_completion');
            const summary = Array.isArray(raw.item.summary) ? raw.item.summary : [];
            const partIndexes = [...item.parts.keys()];
            if (summary.length !== item.parts.size || summary.some((partValue, partIndex) => !object(partValue) || partValue.type !== 'summary_text'
              || !text(partValue.text) || partIndex !== partIndexes[partIndex])) return fail('reasoning_summary_mismatch');
            item.closed = true; parsedFrame = true;
            return { events: [], usageUpdates: [] };
          }
          if (!validMessageItem(raw.item, false) || [...item.parts.values()].some(partValue => !partValue.closed)) return fail('invalid_item_completion');
          const content = Array.isArray(raw.item.content) ? raw.item.content : [];
          const partIndexes = [...item.parts.keys()];
          if (content.length !== item.parts.size || content.some((partValue, partIndex) => !object(partValue)
            || !((partValue.type === 'output_text' && text(partValue.text) && Array.isArray(partValue.annotations))
              || (partValue.type === 'refusal' && text(partValue.refusal))) || partIndex !== partIndexes[partIndex])) return fail('item_content_mismatch');
          item.closed = true; parsedFrame = true;
          return { events: [], usageUpdates: [] };
        }
        if (!item || item.closed || !safeId(raw.item_id) || raw.item_id !== item.id) return fail('invalid_item_reference');
        if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
          if (item.type !== 'function_call') return fail('invalid_tool_reference');
          const toolIndex = item.toolIndex;
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
          return { events: [chat({ tool_calls: [{ index: toolIndex, function: { arguments: fragment } }] })], usageUpdates: [] };
        }
        if (item.type === 'reasoning') {
          const summary = type.startsWith('response.reasoning_summary_');
          if (!summary || !index(raw.summary_index)) return fail('invalid_reasoning_reference');
          const summaryIndex = raw.summary_index as number;
          if (type === 'response.reasoning_summary_part.added') {
            if (!Object.keys(raw).every(key => ['type', 'sequence_number', 'output_index', 'item_id', 'summary_index', 'part'].includes(key))
              || summaryIndex !== item.parts.size || !object(raw.part) || raw.part.type !== 'summary_text' || raw.part.text !== '') return fail('invalid_reasoning_part');
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
            return { events: [chat({ reasoning_content: raw.delta })], usageUpdates: [] };
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
        if (item.type !== 'message') return fail('invalid_item_reference');
        if (type === 'response.content_part.added') {
          const partType = object(raw.part) && raw.part.type === 'refusal' ? 'refusal' : 'output_text';
          if (!validPartEvent(raw, partType) || raw.content_index !== item.parts.size || !object(raw.part)
            || (partType === 'output_text' ? raw.part.text !== '' || !Array.isArray(raw.part.annotations) : raw.part.refusal !== '')) return fail('invalid_content_part');
          const partRelease = budget.reserve(64);
          const part: Part = { index: raw.content_index as number, type: partType, buffer: new BoundedByteBuffer(budget), release: partRelease, leafDone: false, closed: false };
          item.parts.set(part.index, part); parsedFrame = true;
          return { events: [], usageUpdates: [] };
        }
        const ordinal = raw.content_index;
        if (!index(ordinal)) return fail('invalid_content_index');
        const part = item.parts.get(ordinal);
        if (!part || part.closed) return fail('invalid_content_reference');
        if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
          if ((type === 'response.output_text.delta' && part.type !== 'output_text') || (type === 'response.refusal.delta' && part.type !== 'refusal')) return fail('invalid_content_reference');
          if (!Object.keys(raw).every(key => ['type', 'sequence_number', 'output_index', 'item_id', 'content_index', 'delta'].includes(key)) || !text(raw.delta)) return fail('invalid_content_delta');
          if (!raw.delta) return { events: [], usageUpdates: [] };
          part.buffer.appendText(raw.delta);
          parsedFrame = true;
          if (part.type === 'refusal') hasRefusal = true;
          return { events: [chat(part.type === 'refusal' ? { refusal: raw.delta } : { content: raw.delta })], usageUpdates: [] };
        }
        if (type === 'response.output_text.done' || type === 'response.refusal.done') {
          if ((type === 'response.output_text.done' && part.type !== 'output_text') || (type === 'response.refusal.done' && part.type !== 'refusal')) return fail('invalid_content_reference');
          const field = type === 'response.refusal.done' ? 'refusal' : 'text';
          const value = raw[field];
          if (!Object.keys(raw).every(key => ['type', 'sequence_number', 'output_index', 'item_id', 'content_index', field].includes(key)) || !text(value)
            || partText(part) !== value) return fail('invalid_content_completion');
          if (part.type === 'refusal' && value) hasRefusal = true;
          part.leafDone = true; parsedFrame = true;
          return { events: [], usageUpdates: [] };
        }
        if (type === 'response.content_part.done') {
          if ((!validPartEvent(raw, part.type) || !part.leafDone || !object(raw.part))
            || (part.type === 'output_text' ? raw.part.text !== partText(part) || !Array.isArray(raw.part.annotations) : raw.part.refusal !== partText(part))) return fail('invalid_content_completion');
          part.closed = true; part.buffer.cancel(); part.release(); parsedFrame = true;
          return { events: [], usageUpdates: [] };
        }
        return fail('unsupported_event');
      } catch { return fail('invalid_or_oversized_event'); }
      finally { release?.(); }
    },
    finish(end) {
      if (closed) return empty();
      if (end.kind === 'cancelled') return close({ status: 'cancelled' }, []);
      if (end.kind === 'error') return fail('transport_error');
      return close({ status: 'incomplete', reason: 'unexpected_eof' }, [encodeErrorSseFrame('chat', error('unexpected_eof'))]);
    },
  };

  let usageFinished = false;
  function withUsage(step: StreamStep<SseFrame>, updates: readonly UsageUpdate[]): ResponsesToChatStep {
    if (!step.terminal) return { ...step, usageUpdates: updates };
    usageFinished = true;
    const snapshot = usage.finish(step.terminal);
    const events = [...step.events];
    if (snapshot.quality === 'complete' && step.terminal.status !== 'failed' && events.at(-1)?.data === '[DONE]') {
      const counts = snapshot.counts;
      const total = counts.totalTokens ?? counts.inputTokens + counts.outputTokens;
      const usageBody = { input_tokens: counts.inputTokens, output_tokens: counts.outputTokens, total_tokens: total,
        ...(counts.cacheReadTokens === undefined && counts.cacheWriteTokens === undefined ? {} : { prompt_tokens_details: {
          ...(counts.cacheReadTokens === undefined ? {} : { cached_tokens: counts.cacheReadTokens }),
          ...(counts.cacheWriteTokens === undefined ? {} : { cache_write_tokens: counts.cacheWriteTokens }),
        } }),
        ...(counts.reasoningTokens === undefined ? {} : { completion_tokens_details: { reasoning_tokens: counts.reasoningTokens } }) };
      if (Number.isSafeInteger(total)) events.splice(events.length - 1, 0, chat({}, null, false, usageBody));
    }
    return { ...step, events, usageUpdates: updates, usage: snapshot };
  }
  return { ok: true, value: {
    push(frame) {
      if (usageFinished) return empty();
      const step = wire.push(frame);
      return withUsage(step, parsedFrame ? usage.push(frame) : []);
    },
    finish(end) {
      if (usageFinished) return empty();
      return withUsage(wire.finish(end), []);
    },
  } };
}

export function createResponsesToChatSession(context: ResponseContext, options: StreamOptions): ConversionResult<ResponsesToChatSession> {
  if (!Number.isSafeInteger(options.maxBufferedBytes) || options.maxBufferedBytes < 1) return { ok: false, error: error('invalid_stream_configuration') };
  return makeSession(context, options, new ByteBudget(options.maxBufferedBytes));
}
export const responsesToChatStreamAdapter = Object.freeze({ from: 'responses' as const, to: 'chat' as const, create: createResponsesToChatSession });

function chunk(step: ResponsesToChatStep): ResponsesToChatChunk {
  const { events, ...metadata } = step;
  return { ...metadata, bytes: encoder.encode(events.map(frame => `${frame.event ? `event: ${frame.event}\n` : ''}data: ${frame.data}\n\n`).join('')) };
}

/** Incremental SSE bridge with bounded UTF-8 framing, backpressure and abort propagation. */
export async function* streamResponsesToChat(
  source: ReadableStream<Uint8Array>, context: ResponseContext, options: StreamOptions, signal?: AbortSignal,
): AsyncGenerator<ResponsesToChatChunk, void, unknown> {
  if (!Number.isSafeInteger(options.maxBufferedBytes) || options.maxBufferedBytes < 1) throw new TypeError('Invalid Responses to Chat stream configuration');
  const budget = new ByteBudget(options.maxBufferedBytes);
  const created = makeSession(context, options, budget);
  if (!created.ok) throw new TypeError('Invalid Responses to Chat stream configuration');
  const session = created.value;
  const parser = new SseByteParser();
  const pending = new BoundedByteBuffer(budget);
  let lineHasContent = false;
  let skipLf = false;
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
    parser.finish();
    yield chunk(session.finish({ kind: 'eof' }));
  } catch {
    yield chunk(session.finish(signal?.aborted ? { kind: 'cancelled' } : { kind: 'error', error: error('transport_error') }));
  } finally {
    pending.cancel(); parser.finish(); session.finish({ kind: 'cancelled' });
  }
}
