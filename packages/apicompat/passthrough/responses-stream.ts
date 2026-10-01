import { encodeErrorSseFrame } from '../errors.js';
import { BoundedByteBuffer, ByteBudget, readBoundedBytes } from '../streams/buffers.js';
import { SseByteParser } from '../streams/parser.js';
import type { ResponseContext, StreamEnd, StreamOptions, StreamStep } from '../types/adapter.js';
import type { ConversionResult, ProtocolError, SseFrame, TerminalState, UsageSnapshot, UsageUpdate } from '../types/shared.js';
import { createResponsesUsageSession } from '../usage/responses.js';
import { responsesResponseAdapter } from './responses.js';

export interface ResponsesStreamStep extends StreamStep<SseFrame> { readonly usageUpdates: readonly UsageUpdate[]; readonly usage?: UsageSnapshot }
export interface ResponsesStreamSession { push(frame: SseFrame): ResponsesStreamStep; finish(end: StreamEnd): ResponsesStreamStep }
export interface ResponsesStreamChunk extends Omit<ResponsesStreamStep, 'events'> { readonly bytes: Uint8Array }
const encoder = new TextEncoder();
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string';
const index = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const keys = (v: Record<string, unknown>, names: readonly string[]) => Object.keys(v).every(name => names.includes(name));
const empty = (): ResponsesStreamStep => ({ events: [], usageUpdates: [] });
const error = (code: string): ProtocolError => ({ kind: 'stream_error', code, message: 'The Responses stream could not be completed safely.' });
const envelopeTypes = new Set(['response.created', 'response.queued', 'response.in_progress', 'response.completed', 'response.incomplete', 'response.failed']);
const itemTypes = new Set(['response.output_item.added', 'response.output_item.done']);
const partTypes = new Set(['response.content_part.added', 'response.content_part.done', 'response.reasoning_summary_part.added', 'response.reasoning_summary_part.done']);
const leafTypes = new Set(['response.output_text.delta', 'response.output_text.done', 'response.refusal.delta', 'response.refusal.done',
  'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done', 'response.function_call_arguments.delta', 'response.function_call_arguments.done']);
interface Part { type: string; leafDone: boolean; closed: boolean }
interface Item { id: string; type: string; closed: boolean; parts: Map<number, Part>; args: BoundedByteBuffer; argsDone: boolean; name?: string; callId?: string }

function makeSession(context: ResponseContext, options: StreamOptions, budget: ByteBudget): ConversionResult<ResponsesStreamSession> {
  const max = options.maxBufferedBytes;
  if (!Number.isSafeInteger(max) || max < 1 || !['ignore', 'reject', 'preserve'].includes(options.unknownEventPolicy) ||
    !text(context.targetModel) || !context.targetModel.trim() || context.targetModel.length > 512 || /[\u0000-\u001f\u007f]/u.test(context.targetModel) ||
    !text(context.identity.responseId) || !context.identity.responseId || context.identity.responseId.length > 128 || /[\u0000-\u0020\u007f]/u.test(context.identity.responseId)) {
    return { ok: false, error: error('invalid_stream_configuration') };
  }
  const publicContext: ResponseContext = { ...context, identity: { ...context.identity } };
  const policy = options.unknownEventPolicy;
  const usage = createResponsesUsageSession();
  const items = new Map<number, Item>();
  const releases: (() => void)[] = [];
  let started = false; let closed = false; let lastSequence = -1;
  let nativeId = context.identity.upstreamResponseId;
  function close(terminal: TerminalState, events: readonly SseFrame[] = [], usageUpdates: readonly UsageUpdate[] = []): ResponsesStreamStep {
    closed = true; for (const item of items.values()) item.args.cancel(); items.clear();
    for (const release of releases) release(); releases.length = 0;
    return { events, terminal, usageUpdates, usage: usage.finish(terminal) };
  }
  function fail(code: string): ResponsesStreamStep {
    const problem = error(code);
    return close({ status: 'failed', error: problem }, [encodeErrorSseFrame('responses', problem, lastSequence + 1)]);
  }
  function validItem(value: unknown): value is Record<string, unknown> {
    if (!object(value) || !text(value.id) || !value.id) return false;
    // Reuse P16's strict native item validator, not a permissive wire cast. This
    // temporary envelope is validation only and is never emitted as completion.
    return responsesResponseAdapter.convert({ id: nativeId, object: 'response', model: 'validation', created_at: 0,
      status: 'completed', output: [value] }, publicContext).ok;
  }
  function validPart(value: unknown, summary: boolean): value is Record<string, unknown> {
    if (!object(value)) return false;
    if (summary) return value.type === 'summary_text' && text(value.text) && keys(value, ['type', 'text']);
    return validItem({ type: 'message', id: 'validation_item', role: 'assistant', status: 'in_progress', content: [value] });
  }
  return { ok: true, value: {
    push(frame) {
      if (closed) return empty();
      try {
        if (!text(frame.data) || encoder.encode(frame.data).byteLength > max) return fail('frame_limit_exceeded');
        const event: unknown = JSON.parse(frame.data);
        if (!object(event) || !text(event.type) || (frame.event !== undefined && frame.event !== event.type)) return fail('invalid_event');
        const type = event.type;
        if (type === 'error') return fail('upstream_error');
        if (!envelopeTypes.has(type) && !itemTypes.has(type) && !partTypes.has(type) && !leafTypes.has(type)) {
          return policy === 'ignore' ? empty() : fail('unsupported_event');
        }
        if (!index(event.sequence_number) || event.sequence_number >= Number.MAX_SAFE_INTEGER || event.sequence_number <= lastSequence) return fail('invalid_event_sequence');
        lastSequence = event.sequence_number;
        if (envelopeTypes.has(type)) {
          if (!keys(event, ['type', 'sequence_number', 'response']) || !object(event.response)) return fail('invalid_response_envelope');
          const value = event.response;
          const status = type.slice('response.'.length);
          const terminal = ['completed', 'incomplete', 'failed'].includes(status);
          if ((status === 'created' ? value.status !== 'in_progress' && value.status !== 'queued' : value.status !== status) ||
            (!started && status !== 'created') || (started && status === 'created')) return fail('invalid_response_order');
          if (!text(value.id) || (nativeId !== undefined && value.id !== nativeId)) return fail('upstream_identity_mismatch');
          if (nativeId === undefined) { releases.push(budget.reserve(encoder.encode(value.id).byteLength)); nativeId = value.id; }
          const checked = responsesResponseAdapter.convert(terminal ? value : { ...value, status: 'completed' }, publicContext);
          if (!checked.ok) return fail('invalid_response_envelope');
          if (!terminal && checked.value.body.output.length !== 0) return fail('unannounced_output');
          started = true;
          if (terminal) {
            if (status === 'completed' && ([...items.values()].some(item => !item.closed) || checked.value.body.output.length !== items.size)) return fail('unclosed_output_items');
            for (const [position, output] of checked.value.body.output.entries()) {
              const known = items.get(position);
              if (!known || known.id !== output.id || known.type !== output.type ||
                (status === 'completed' && output.status !== undefined && output.status !== 'completed')) return fail('terminal_item_mismatch');
            }
          }
          const body = terminal ? checked.value.body : { ...checked.value.body, status: value.status };
          const output = { event: type, data: JSON.stringify({ ...event, response: body }) };
          const updates = usage.push(event);
          return terminal ? close(checked.value.terminal, [output], updates) : { events: [output], usageUpdates: updates };
        }
        if (!started || !index(event.output_index)) return fail('missing_response_start');
        let item = items.get(event.output_index);
        if (itemTypes.has(type)) {
          if (!keys(event, ['type', 'sequence_number', 'output_index', 'item']) || !validItem(event.item)) return fail('invalid_output_item');
          const value = event.item;
          if (type.endsWith('.added')) {
            if (item || event.output_index !== items.size || [...items.values()].some(known => known.id === value.id)) return fail('duplicate_output_item');
            releases.push(budget.reserve(128 + encoder.encode(JSON.stringify([value.id, value.name ?? '', value.call_id ?? ''])).byteLength));
            item = { id: value.id as string, type: value.type as string, closed: false, parts: new Map(), args: new BoundedByteBuffer(budget), argsDone: false,
              ...(text(value.name) ? { name: value.name } : {}), ...(text(value.call_id) ? { callId: value.call_id } : {}) };
            if (value.status !== undefined && value.status !== 'in_progress') return fail('invalid_item_start');
            if (Array.isArray(value.content) && value.content.length || Array.isArray(value.summary) && value.summary.length) return fail('unannounced_content_parts');
            items.set(event.output_index, item);
          } else {
            if (!item || item.closed || item.id !== value.id || item.type !== value.type || value.status === 'in_progress' ||
              [...item.parts.values()].some(part => !part.closed)) return fail('invalid_item_completion');
            if (item.type === 'function_call' && (!item.argsDone || item.name !== value.name || item.callId !== value.call_id)) return fail('incomplete_tool');
            if (item.type === 'function_call' && new TextDecoder().decode(item.args.drain()) !== value.arguments) return fail('tool_arguments_mismatch');
            const parts = item.type === 'message' ? value.content : item.type === 'reasoning' ? value.summary : undefined;
            if (Array.isArray(parts) && (parts.length !== item.parts.size || parts.some((part, i) => !object(part) || item!.parts.get(i)?.type !== part.type))) return fail('item_content_mismatch');
            item.closed = true; item.args.clear();
          }
        } else {
          if (!item || item.closed || event.item_id !== item.id) return fail('invalid_item_reference');
          const toolEvent = type.startsWith('response.function_call_arguments.');
          if (toolEvent) {
            if (item.type !== 'function_call' || item.argsDone) return fail('invalid_tool_order');
            const done = type.endsWith('.done');
            if (!keys(event, ['type', 'sequence_number', 'output_index', 'item_id', done ? 'arguments' : 'delta', ...(done ? ['name'] : [])]) ||
              !text(done ? event.arguments : event.delta)) return fail('invalid_tool_event');
            if (done) {
              if (event.name !== undefined && event.name !== item.name) return fail('tool_name_mismatch');
              const args = event.arguments as string;
              if (item.args.byteLength && new TextDecoder().decode(item.args.drain()) !== args) return fail('tool_arguments_mismatch');
              const parsed: unknown = JSON.parse(args);
              if (!object(parsed)) return fail('invalid_tool_arguments');
              item.args.appendText(args); // Bounded until output_item.done confirms the same arguments.
              item.argsDone = true;
            } else item.args.appendText(event.delta as string);
          } else {
            const summary = type.startsWith('response.reasoning_summary_');
            const ordinal = summary ? event.summary_index : event.content_index;
            if (!index(ordinal) || (summary ? item.type !== 'reasoning' : item.type !== 'message')) return fail('invalid_content_reference');
            let part = item.parts.get(ordinal);
            const baseKeys = ['type', 'sequence_number', 'output_index', 'item_id', summary ? 'summary_index' : 'content_index'];
            if (partTypes.has(type)) {
              if (!keys(event, [...baseKeys, 'part']) || !validPart(event.part, summary)) return fail('invalid_content_part');
              if (type.endsWith('.added')) {
                if (part || ordinal !== item.parts.size) return fail('duplicate_content_part');
                releases.push(budget.reserve(64));
                part = { type: event.part.type as string, leafDone: false, closed: false }; item.parts.set(ordinal, part);
              } else {
                if (!part || part.closed || !part.leafDone || part.type !== event.part.type) return fail('invalid_part_completion');
                part.closed = true;
              }
            } else {
              const done = type.endsWith('.done');
              const refusal = type.startsWith('response.refusal.');
              const field = done ? refusal ? 'refusal' : 'text' : 'delta';
              if (!keys(event, [...baseKeys, field]) || !text(event[field]) || !part || part.closed || part.leafDone ||
                part.type !== (summary ? 'summary_text' : refusal ? 'refusal' : 'output_text')) return fail('invalid_content_delta');
              if (done) part.leafDone = true;
            }
          }
        }
        return { events: [{ event: type, data: JSON.stringify(event) }], usageUpdates: [] };
      } catch { return fail('invalid_or_oversized_event'); }
    },
    finish(end) {
      if (closed) return empty();
      if (end.kind === 'cancelled') return close({ status: 'cancelled' });
      if (end.kind === 'error') return fail('transport_error');
      return close({ status: 'incomplete', reason: 'unexpected_eof' }, [encodeErrorSseFrame('responses', error('unexpected_eof'), lastSequence + 1)]);
    },
  } };
}

export function createResponsesStreamSession(context: ResponseContext, options: StreamOptions): ConversionResult<ResponsesStreamSession> {
  if (!Number.isSafeInteger(options.maxBufferedBytes) || options.maxBufferedBytes < 1) return { ok: false, error: error('invalid_stream_configuration') };
  return makeSession(context, options, new ByteBudget(options.maxBufferedBytes));
}
export const responsesStreamAdapter = Object.freeze({ from: 'responses' as const, to: 'responses' as const, create: createResponsesStreamSession });

function chunk(step: ResponsesStreamStep): ResponsesStreamChunk {
  const { events, ...metadata } = step;
  return { ...metadata, bytes: encoder.encode(events.map(frame => `event: ${frame.event}\ndata: ${frame.data}\n\n`).join('')) };
}

/**
 * Incremental native SSE bytes + separate usage/terminal metadata, no fetch or
 * whole-response buffering. Shares P09 budget across the currently yielded input
 * chunk, incomplete frame and current tool arguments. Slow consumers cause no
 * additional reads. Oversized source chunks also fail closed under this budget.
 * EOF discards P08's residual frame; it never fabricates response.completed/success.
 */
export async function* streamResponsesPassthrough(
  source: ReadableStream<Uint8Array>, context: ResponseContext, options: StreamOptions, signal?: AbortSignal,
): AsyncGenerator<ResponsesStreamChunk, void, unknown> {
  if (!Number.isSafeInteger(options.maxBufferedBytes) || options.maxBufferedBytes < 1) throw new TypeError('Invalid Responses stream configuration');
  const budget = new ByteBudget(options.maxBufferedBytes);
  const created = makeSession(context, options, budget);
  if (!created.ok) throw new TypeError('Invalid Responses stream configuration');
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
