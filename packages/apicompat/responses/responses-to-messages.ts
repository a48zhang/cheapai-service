/**
 * SPDX-License-Identifier: LGPL-3.0-only
 * Behavioral adaptation of Wei-Shaw/sub2api, commit
 * ab99d56e9626e6cd731592dae8553c9758a0efa2,
 * backend/internal/pkg/apicompat/responses_to_anthropic.go,
 * ResponsesToAnthropic.
 * Full texts: LICENSES/LGPL-3.0.txt and LICENSES/GPL-3.0.txt.
 *
 * P-RM-J1: direct Responses -> Messages mapping with caller-owned stable
 * identity/model/time. Output items are inspected in place; this adapter never
 * pivots through another wire protocol.
 * P-RM-J2: ordered function_call items become Messages tool_use blocks with
 * complete JSON object arguments and preserved call IDs; unsupported ordering
 * and malformed calls fail closed.
 * P-RM-J3: Responses terminal status/incomplete details map through P11 to
 * Messages stop reasons; failed responses use a sanitized target error.
 * P-RM-J3-E: standalone native Responses errors use the same safe Messages
 * error envelope and failed terminal without reflecting provider diagnostics.
 * P-RM-J3-T: public reasoning summaries become unsigned compatible thinking
 * blocks; encrypted/private reasoning is rejected without being downgraded.
 * P-RM-J4: original Responses usage is projected to Messages' cache-exclusive
 * counters once; incomplete evidence is omitted rather than zero-filled.
 */
import { isRepresentableWireId } from '../ids.js';
import { normalizeFinish, mapFinishToTarget } from '../finish-reasons.js';
import { encodeMessagesError } from '../errors.js';
import { extractResponsesUsage } from '../usage/responses.js';
import type { JsonResponseAdapter, JsonResponseOutput, ResponseContext } from '../types/adapter.js';
import type { MessagesError, MessagesResponse, MessagesOutputBlock, MessagesUsage } from '../types/messages.js';
import type { ConversionResult, JsonObject, ProtocolError } from '../types/shared.js';

export type ResponsesToMessagesBody = MessagesResponse | MessagesError;
type Output = JsonResponseOutput<ResponsesToMessagesBody>;

const RESPONSE_METADATA_KEYS = [
  'previous_response_id', 'completed_at', 'background', 'store', 'parallel_tool_calls',
  'temperature', 'top_p', 'top_logprobs', 'max_output_tokens', 'max_tool_calls',
  'service_tier', 'instructions', 'metadata', 'text', 'tools', 'tool_choice',
  'reasoning', 'truncation', 'user', 'safety_identifier', 'prompt_cache_key',
  'prompt_cache_retention', 'prompt_cache_options', 'prompt_cache_diagnostics',
  'prompt', 'conversation', 'context_management', 'output_text',
] as const;

class Fault extends Error {
  constructor(readonly error: ProtocolError) { super(error.code); }
}

function invalid(param: string, code = 'invalid_responses_response'): never {
  throw new Fault({ kind: 'invalid_response', code, message: 'The Responses response cannot be represented as a Messages response.', param });
}
function unsupported(param: string, code = 'unsupported_responses_to_messages_response'): never {
  throw new Fault({ kind: 'unsupported_feature', code, message: 'This Responses response feature cannot be represented as Messages.', param });
}

function record(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(path);
  for (const key of required) if (!Object.hasOwn(value, key)) invalid(`${path}.${key}`);
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) unsupported(`${path}.${key}`);
  return value as Record<string, unknown>;
}

/** Read decoded JSON data without invoking accessors or retaining arbitrary objects. */
function jsonBoundary(value: unknown): void {
  const pending = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 100_000 || item.depth > 64) invalid('$');
    const current = item.value;
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue;
    if (typeof current === 'number') { if (!Number.isFinite(current)) invalid('$'); continue; }
    if (!current || typeof current !== 'object' || seen.has(current)) invalid('$');
    seen.add(current);
    const keys = Object.keys(current);
    if (keys.length + pending.length > 100_000 || (Array.isArray(current) && keys.length !== current.length)) invalid('$');
    for (const key of keys) {
      pending.push({ value: (current as Record<string, unknown>)[key], depth: item.depth + 1 });
    }
  }
}

function contextIdentity(context: ResponseContext, upstreamId?: unknown): void {
  if (!context || !isRepresentableWireId(context.identity?.responseId)
    || (upstreamId !== undefined && !isRepresentableWireId(upstreamId))
    || typeof context.targetModel !== 'string' || !context.targetModel.trim()
    || typeof context.idFor !== 'function' || !Number.isSafeInteger(context.createdAt) || context.createdAt < 0
    || (context.identity.upstreamResponseId !== undefined
      && (!isRepresentableWireId(context.identity.upstreamResponseId)
        || (upstreamId !== undefined && context.identity.upstreamResponseId !== upstreamId)))) {
    invalid('context', 'invalid_response_context');
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Standard Responses echoes are metadata and must not become assistant text. */
function responseMetadata(source: Record<string, unknown>): void {
  for (const key of RESPONSE_METADATA_KEYS) {
    const value = source[key];
    const path = `$.${key}`;
    if (value === undefined) continue;
    if (value === null) {
      if (['parallel_tool_calls', 'tools', 'tool_choice', 'text', 'prompt_cache_options', 'output_text'].includes(key)) invalid(path);
      continue;
    }
    if (['background', 'store', 'parallel_tool_calls'].includes(key)) {
      if (typeof value !== 'boolean') invalid(path);
    } else if (['completed_at', 'top_logprobs', 'max_output_tokens', 'max_tool_calls'].includes(key)) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || (key === 'top_logprobs' && value > 20)) invalid(path);
    } else if (key === 'temperature' || key === 'top_p') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > (key === 'temperature' ? 2 : 1)) invalid(path);
    } else if (key === 'previous_response_id' || key === 'conversation') {
      if (key === 'previous_response_id') { if (!isRepresentableWireId(value)) invalid(path); }
      else {
        const conversation = record(value, path, ['id']);
        if (!isRepresentableWireId(conversation.id)) invalid(`${path}.id`);
      }
    } else if (key === 'metadata') {
      if (!object(value) || Object.keys(value).length > 16 || Object.entries(value).some(([name, entry]) => name.length > 64 || typeof entry !== 'string' || entry.length > 512)) invalid(path);
    } else if (key === 'tools') {
      if (!Array.isArray(value)) invalid(path);
      for (const [index, tool] of value.entries()) {
        const item = record(tool, `${path}[${index}]`, ['type', 'name'], ['description', 'parameters', 'strict']);
        if (item.type !== 'function' || typeof item.name !== 'string' || !item.name.trim()) invalid(`${path}[${index}]`);
        if (item.description !== undefined && typeof item.description !== 'string') invalid(`${path}[${index}].description`);
        if (item.parameters !== undefined && item.parameters !== null && !object(item.parameters)) invalid(`${path}[${index}].parameters`);
        if (item.strict !== undefined && item.strict !== null && typeof item.strict !== 'boolean') invalid(`${path}[${index}].strict`);
      }
    } else if (key === 'tool_choice') {
      if (typeof value === 'string') { if (!['auto', 'none', 'required'].includes(value)) invalid(path); }
      else {
        const choice = record(value, path, ['type', 'name']);
        if (choice.type !== 'function' || typeof choice.name !== 'string' || !choice.name.trim()) invalid(path);
      }
    } else if (key === 'reasoning') {
      const config = record(value, path, [], ['effort', 'summary', 'generate_summary', 'context', 'mode']);
      for (const [name, entry] of Object.entries(config)) {
        const accepted = name === 'effort' ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
          : name === 'context' ? ['auto'] : name === 'mode' ? ['standard'] : ['auto', 'concise', 'detailed'];
        if (entry !== null && (typeof entry !== 'string' || !accepted.includes(entry))) invalid(`${path}.${name}`);
      }
    } else if (key === 'text') {
      const config = record(value, path, [], ['format', 'verbosity']);
      if (config.verbosity !== undefined && config.verbosity !== null && (typeof config.verbosity !== 'string' || !['low', 'medium', 'high'].includes(config.verbosity))) invalid(`${path}.verbosity`);
      if (config.format !== undefined) {
        const format = record(config.format, `${path}.format`, ['type'], ['name', 'schema', 'strict', 'description']);
        if (typeof format.type !== 'string' || !['text', 'json_object', 'json_schema'].includes(format.type)) unsupported(`${path}.format.type`);
        if (format.type === 'json_schema' && (typeof format.name !== 'string' || !format.name.trim() || !object(format.schema))) invalid(`${path}.format`);
        if (format.strict !== undefined && format.strict !== null && typeof format.strict !== 'boolean') invalid(`${path}.format.strict`);
        if (format.description !== undefined && typeof format.description !== 'string') invalid(`${path}.format.description`);
      }
    } else if (key === 'truncation') {
      if (typeof value !== 'string' || !['auto', 'disabled'].includes(value)) invalid(path);
    } else if (key === 'service_tier') {
      if (typeof value !== 'string' || !['auto', 'default', 'flex', 'scale', 'priority', 'fast', 'ultrafast'].includes(value)) invalid(path);
    } else if (key === 'user' || key === 'safety_identifier' || key === 'prompt_cache_key') {
      if (typeof value !== 'string') invalid(path);
    } else if (key === 'prompt_cache_retention') {
      if (typeof value !== 'string' || !['in_memory', '24h'].includes(value)) invalid(path);
    } else if (key === 'prompt_cache_options') {
      const config = record(value, path, ['mode', 'ttl'], ['comparison_response_id']);
      if (!['implicit', 'explicit'].includes(String(config.mode)) || config.ttl !== '30m'
        || (config.comparison_response_id !== undefined && !isRepresentableWireId(config.comparison_response_id))) invalid(path);
    } else if (key === 'instructions') {
      if (typeof value !== 'string' && !Array.isArray(value)) invalid(path);
    } else if (key === 'context_management') {
      if (!Array.isArray(value) || value.some(entry => !object(entry))) invalid(path);
    } else if (key === 'prompt' || key === 'prompt_cache_diagnostics') {
      if (!object(value)) invalid(path);
    } else if (key === 'output_text') {
      if (typeof value !== 'string') invalid(path);
    }
  }
}

function parseToolArguments(value: string): JsonObject | undefined {
  if (value.length > 1_048_576) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const pending: { value: unknown; depth: number }[] = [{ value: parsed, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++nodes > 100_000 || current.depth > 64) return undefined;
    const value = current.value;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) return undefined;
      continue;
    }
    if (typeof value !== 'object' || seen.has(value)) return undefined;
    seen.add(value);
    for (const key of Object.keys(value)) {
      pending.push({ value: (value as Record<string, unknown>)[key], depth: current.depth + 1 });
    }
  }
  return parsed as JsonObject;
}

function displayUsage(source: Record<string, unknown>): ConversionResult<MessagesUsage | undefined> {
  const raw = source.usage;
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!object(raw)) return { ok: true, value: undefined };
  const topExtra = Object.keys(raw).find(key => !['input_tokens', 'output_tokens', 'total_tokens', 'input_tokens_details', 'output_tokens_details'].includes(key));
  if (topExtra) return unsupported(`$.usage.${topExtra}`);
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens'] as const) {
    const value = raw[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) invalid(`$.usage.${key}`);
  }
  for (const [field, allowed] of [['input_tokens_details', ['cached_tokens', 'cache_write_tokens']], ['output_tokens_details', ['reasoning_tokens']]] as const) {
    const details = raw[field];
    if (details === undefined) continue;
    const value = record(details, `$.usage.${field}`, [], allowed);
    for (const key of Object.keys(value)) {
      const count = value[key];
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) invalid(`$.usage.${field}.${key}`);
    }
  }
  const observed = extractResponsesUsage(source);
  if (observed.quality !== 'complete' || observed.semantics.cacheRead !== 'included_in_input'
    || observed.semantics.cacheWrite !== 'included_in_input' || observed.semantics.reasoning !== 'included_in_output') return { ok: true, value: undefined };
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens } = observed.counts;
  if (inputTokens === undefined || outputTokens === undefined) return { ok: true, value: undefined };
  // Responses input_tokens includes any reported cache buckets. Subtract only
  // buckets that are present and retain the residual aggregate when another
  // subdivision is absent; this is presentation of remaining input, never a
  // claim that the target count is a precisely measured cache-exclusive total.
  const input = inputTokens - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0);
  if (!Number.isSafeInteger(input) || input < 0) return { ok: true, value: undefined };
  return { ok: true, value: {
    input_tokens: input, output_tokens: outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cache_read_input_tokens: cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cache_creation_input_tokens: cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { output_tokens_details: { thinking_tokens: reasoningTokens } }),
  } };
}

function ownData(value: object, key: string): unknown {
  return (value as Record<string, unknown>)[key];
}

function nativeError(input: unknown, context: ResponseContext): ConversionResult<Output> | undefined {
  if (!input || typeof input !== 'object' || !Object.hasOwn(input, 'error')) return undefined;
  // A normal failed Responses response carries id/object/status/output beside
  // its error field; that path is handled by the terminal mapper below.
  if (Object.hasOwn(input, 'id') || Object.hasOwn(input, 'object') || Object.hasOwn(input, 'status') || Object.hasOwn(input, 'output')) return undefined;
  if (Object.keys(input).some(key => key !== 'error')) return { ok: false, error: { kind: 'invalid_response', code: 'invalid_responses_error', message: 'The Responses error envelope is invalid.' } };
  const error = ownData(input, 'error');
  if (!error || typeof error !== 'object' || Array.isArray(error) || typeof ownData(error, 'message') !== 'string'
    || (ownData(error, 'type') !== undefined && typeof ownData(error, 'type') !== 'string')) {
    return { ok: false, error: { kind: 'invalid_response', code: 'invalid_responses_error', message: 'The Responses error envelope is invalid.' } };
  }
  try { contextIdentity(context); }
  catch (fault) { return { ok: false, error: fault instanceof Fault ? fault.error : { kind: 'invalid_response', code: 'invalid_response_context', message: 'Invalid response context.' } }; }
  const safe: ProtocolError = { kind: 'upstream_error', code: 'upstream_error', message: 'The upstream Responses request failed.' };
  const finish = normalizeFinish({ from: 'responses', rawReason: 'failed', error: safe });
  if (!finish.ok) return finish;
  return { ok: true, value: { body: encodeMessagesError(safe), identity: { ...context.identity }, terminal: finish.value.terminal } };
}

function convert(input: unknown, context: ResponseContext): ConversionResult<Output> {
  jsonBoundary(input);
  const failed = nativeError(input, context);
  if (failed !== undefined) return failed;
  const source = record(input, '$', ['id', 'object', 'created_at', 'model', 'status', 'output'], [
    'usage', 'error', 'incomplete_details', ...RESPONSE_METADATA_KEYS,
  ]);
  if (source.object !== 'response' || !isRepresentableWireId(source.id) || typeof source.model !== 'string' || !source.model.trim()
    || typeof source.created_at !== 'number' || !Number.isSafeInteger(source.created_at) || source.created_at < 0 || !Array.isArray(source.output)) invalid('$');
  contextIdentity(context, source.id);
  if (typeof source.status !== 'string' || !['completed', 'incomplete', 'failed'].includes(source.status)) unsupported('$.status');
  responseMetadata(source);
  if (source.error !== undefined && source.error !== null) {
    const error = record(source.error, '$.error', ['code', 'message']);
    if (typeof error.code !== 'string' || typeof error.message !== 'string') invalid('$.error');
    if (source.status !== 'failed') invalid('$.error');
  }
  if (source.status === 'failed' && source.output.length > 0) unsupported('$.output');
  let incompleteReason: string | undefined;
  if (source.incomplete_details !== undefined && source.incomplete_details !== null) {
    if (source.status !== 'incomplete') invalid('$.incomplete_details');
    const details = record(source.incomplete_details, '$.incomplete_details', ['reason']);
    if (typeof details.reason !== 'string') invalid('$.incomplete_details.reason');
    incompleteReason = details.reason;
  }

  const safeError: ProtocolError = { kind: 'upstream_error', code: 'upstream_error', message: 'The upstream Responses request failed.' };
  if (source.status === 'failed') {
    const finish = normalizeFinish({ from: 'responses', rawReason: 'failed', error: safeError });
    if (!finish.ok) return finish;
    return { ok: true, value: { body: encodeMessagesError(safeError), identity: { responseId: context.identity.responseId, upstreamResponseId: source.id as string }, terminal: finish.value.terminal } };
  }
  const usage = displayUsage(source);
  if (!usage.ok) return usage;
  if (usage.value === undefined) unsupported('$.usage', 'usage_not_representable');

  const itemIds = new Set<string>([context.identity.responseId, source.id as string]);
  const callIds = new Set<string>([context.identity.responseId]);
  const content: MessagesOutputBlock[] = [];
  let text = '';
  let sawTool = false;
  let sawVisible = false;
  const refusals: string[] = [];
  for (const [index, raw] of source.output.entries()) {
    const path = `$.output[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid(path);
    const rawType = (raw as Record<string, unknown>).type;
    if (rawType === 'function_call') {
      const item = record(raw, path, ['type', 'call_id', 'name', 'arguments'], ['id', 'status']);
      if (item.id !== undefined) {
        if (!isRepresentableWireId(item.id) || itemIds.has(item.id)) invalid(`${path}.id`);
        itemIds.add(item.id);
      }
      if (!isRepresentableWireId(item.call_id) || callIds.has(item.call_id)) invalid(`${path}.call_id`);
      if (typeof item.name !== 'string' || item.name.length < 1 || item.name.length > 64 || /[^A-Za-z0-9_-]/u.test(item.name)) invalid(`${path}.name`);
      if (item.status !== undefined && item.status !== 'completed'
        && !(source.status === 'incomplete' && (item.status === 'incomplete' || item.status === 'in_progress'))) unsupported(`${path}.status`);
      const input = parseToolArguments(String(item.arguments));
      if (input === undefined) invalid(`${path}.arguments`, 'invalid_tool_arguments');
      callIds.add(item.call_id);
      content.push({ type: 'tool_use', id: item.call_id, name: item.name, input });
      sawTool = true;
      continue;
    }
    if (rawType === 'reasoning') {
      const item = record(raw, path, ['type', 'id', 'summary'], ['status', 'encrypted_content']);
      if (!isRepresentableWireId(item.id) || itemIds.has(item.id)) invalid(`${path}.id`);
      if (item.status !== undefined && item.status !== 'completed'
        && !(source.status === 'incomplete' && (item.status === 'incomplete' || item.status === 'in_progress'))) unsupported(`${path}.status`);
      if (item.encrypted_content !== undefined && item.encrypted_content !== null) {
        if (typeof item.encrypted_content !== 'string') invalid(`${path}.encrypted_content`);
        if (item.encrypted_content.length > 0) unsupported(`${path}.encrypted_content`);
      }
      if (!Array.isArray(item.summary)) invalid(`${path}.summary`);
      itemIds.add(item.id);
      for (const [summaryIndex, rawSummary] of item.summary.entries()) {
        const summaryPath = `${path}.summary[${summaryIndex}]`;
        const summary = record(rawSummary, summaryPath, ['type', 'text']);
        if (summary.type !== 'summary_text' || typeof summary.text !== 'string') invalid(summaryPath);
        if (summary.text.length > 0 && (sawVisible || sawTool)) unsupported(summaryPath);
        if (summary.text.length > 0) content.push({ type: 'thinking', thinking: summary.text, signature: '' });
      }
      continue;
    }
    if (rawType !== 'message') unsupported(`${path}.type`);
    const item = record(raw, path, ['type', 'id', 'role', 'status', 'content'], ['phase']);
    if (item.role !== 'assistant' || !isRepresentableWireId(item.id) || itemIds.has(item.id)) invalid(path);
    if (item.status !== 'completed' && !(source.status === 'incomplete' && (item.status === 'incomplete' || item.status === 'in_progress'))) unsupported(`${path}.status`);
    if (item.phase !== undefined && item.phase !== null && item.phase !== 'final_answer') unsupported(`${path}.phase`);
    itemIds.add(item.id);
    if (!Array.isArray(item.content)) invalid(`${path}.content`);
    for (const [contentIndex, rawPart] of item.content.entries()) {
      const partPath = `${path}.content[${contentIndex}]`;
      if (!rawPart || typeof rawPart !== 'object' || Array.isArray(rawPart)) invalid(partPath);
      if ((rawPart as Record<string, unknown>).type === 'refusal') {
        const refusal = record(rawPart, partPath, ['type', 'refusal']);
        if (typeof refusal.refusal !== 'string') invalid(`${partPath}.refusal`);
        if (sawTool || sawVisible) unsupported(`${partPath}.refusal`);
        refusals.push(refusal.refusal);
        continue;
      }
      const part = record(rawPart, partPath, ['type', 'text', 'annotations'], ['logprobs']);
      if (part.type !== 'output_text' || typeof part.text !== 'string' || !Array.isArray(part.annotations)) invalid(partPath);
      if (part.annotations.length > 0) unsupported(`${partPath}.annotations`);
      if (part.logprobs !== undefined && (!Array.isArray(part.logprobs) || part.logprobs.length > 0)) unsupported(`${partPath}.logprobs`);
      if (sawTool && part.text.length > 0) unsupported(`${partPath}.text`);
      content.push({ type: 'text', text: part.text });
      text += part.text;
      if (part.text.length > 0) sawVisible = true;
    }
  }
  if (source.output_text !== undefined && source.output_text !== null && source.output_text !== text) invalid('$.output_text');
  const finish = normalizeFinish({ from: 'responses', rawReason: source.status as string,
    hasToolCalls: sawTool, hasRefusal: refusals.length > 0, ...(incompleteReason === undefined ? {} : { incompleteReason }) });
  if (!finish.ok) return finish;
  const mapped = mapFinishToTarget(finish.value, 'messages');
  if (!mapped.ok) return mapped;
  if (mapped.value.kind === 'error') return { ok: false, error: mapped.value.error };
  if (mapped.value.kind !== 'native' || mapped.value.to !== 'messages') return invalid('$.status', 'unrepresentable_responses_finish');
  const targetContent = refusals.length === 0 ? content : [...content, ...refusals.map(value => ({ type: 'text' as const, text: value }))];
  return { ok: true, value: {
    body: { id: context.identity.responseId, type: 'message', role: 'assistant', model: context.targetModel, content: targetContent,
      stop_reason: mapped.value.stop_reason, stop_sequence: null,
      ...(usage.value === undefined ? {} : { usage: usage.value }) },
    identity: { responseId: context.identity.responseId, upstreamResponseId: source.id as string },
    terminal: finish.value.terminal,
  } };
}

export function responsesToMessagesResponse(input: unknown, context: ResponseContext): ConversionResult<Output> {
  try { return convert(input, context); }
  catch (error) {
    return { ok: false, error: error instanceof Fault ? error.error : { kind: 'invalid_response', code: 'responses_to_messages_conversion_failed', message: 'The Responses response could not be converted.' } };
  }
}

export const responsesToMessagesResponseAdapter: JsonResponseAdapter<unknown, ResponsesToMessagesBody, 'responses', 'messages'> = Object.freeze({
  from: 'responses', to: 'messages', convert: responsesToMessagesResponse,
});
