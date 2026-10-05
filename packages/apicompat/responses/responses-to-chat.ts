/**
 * SPDX-License-Identifier: LGPL-3.0-only
 * Behavioral adaptation of Wei-Shaw/sub2api at
 * ab99d56e9626e6cd731592dae8553c9758a0efa2,
 * backend/internal/pkg/apicompat/responses_to_chatcompletions.go,
 * ResponsesToChatCompletions; blob d288b31bea08823de678bca8f743bef6422e7463.
 * Full license texts: LICENSES/LGPL-3.0.txt and LICENSES/GPL-3.0.txt.
 * Changes 2026-09-06, P-RC-J1: original TypeScript implementation and synthetic
 * tests; direct mapping, caller-owned IDs/model/time, ordered text concatenation;
 * unknown output is rejected, not silently skipped as in the reference.
 * P-RC-J2: preserve ordered complete functions and call IDs; accept ordinary
 * multi-item text/tool runs, reject nonempty text after tools as unrepresentable.
 * P-RC-J3: use P11 terminal semantics and P06 sanitized failed envelopes; preserve
 * refusal separately and never turn incomplete/failed/unknown status into stop.
 * P-RC-J3-E: standalone Responses error envelopes use the same P06 safe error
 * boundary and P11 failed terminal; no provider code/message/param is reflected.
 * P-RC-J3-T: ordered public reasoning summaries remain reasoning_content;
 * encrypted/signature payloads and nonrepresentable interleaving are rejected.
 * P-RC-J4: P13 original usage projects to optional Chat fields; partial evidence
 * stays partial, cache/reasoning are not added twice, no costs or zero guesses.
 * RC-JSON-STANDARD: validate standard response configuration echoes as metadata,
 * not generated content; preserve service_tier in Chat's native field. Reference:
 * https://developers.openai.com/api/reference/typescript/resources/responses/methods/create
 */
import { isRepresentableWireId } from '../ids.js';
import { normalizeFinish, mapFinishToTarget } from '../finish-reasons.js';
import { encodeChatError } from '../errors.js';
import { extractResponsesUsage } from '../usage/responses.js';
import { parseResponsesRequest } from '../types/responses.js';
import type { JsonResponseAdapter, JsonResponseOutput, ResponseContext } from '../types/adapter.js';
import type { ChatResponse, ChatToolCall, ChatErrorBody, ChatUsage } from '../types/chat.js';
import type { ConversionResult, ProtocolError } from '../types/shared.js';

export type ResponsesToChatBody = ChatResponse | ChatErrorBody;
type Output = JsonResponseOutput<ResponsesToChatBody>;
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
  throw new Fault({ kind: 'invalid_response', code, message: 'The Responses response cannot be represented as a Chat response.', param });
}
function unsupported(param: string): never {
  throw new Fault({ kind: 'unsupported_feature', code: 'unsupported_responses_to_chat_response', message: 'This Responses response feature cannot be represented as Chat.', param });
}
function record(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(path);
  for (const key of required) if (!Object.hasOwn(value, key)) invalid(`${path}.${key}`);
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) unsupported(`${path}.${key}`);
  return value as Record<string, unknown>;
}
function jsonBoundary(value: unknown): void {
  const pending = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 100_000 || item.depth > 64) invalid('$');
    const value = item.value;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') { if (!Number.isFinite(value)) invalid('$'); continue; }
    if (!value || typeof value !== 'object' || seen.has(value)) invalid('$');
    seen.add(value);
    const names = Object.keys(value);
    if (names.length + pending.length > 100_000 || (Array.isArray(value) && names.length !== value.length)) invalid('$');
    for (const key of names) {
      pending.push({ value: (value as Record<string, unknown>)[key], depth: item.depth + 1 });
    }
  }
}
function contextIdentity(context: ResponseContext, upstreamId?: unknown): void {
  if (!context || !isRepresentableWireId(context.identity?.responseId) || (upstreamId !== undefined && !isRepresentableWireId(upstreamId))
    || typeof context.targetModel !== 'string' || !context.targetModel.trim() || typeof context.idFor !== 'function'
    || !Number.isSafeInteger(context.createdAt) || context.createdAt < 0
    || (context.identity.upstreamResponseId !== undefined && (!isRepresentableWireId(context.identity.upstreamResponseId)
      || (upstreamId !== undefined && context.identity.upstreamResponseId !== upstreamId)))) invalid('context', 'invalid_response_context');
}

/** Validated request/configuration echoes are not new assistant output or authority. */
function responseMetadata(source: Record<string, unknown>): void {
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
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
      if (!Number.isSafeInteger(value) || (value as number) < 0 || (key === 'top_logprobs' && (value as number) > 20)) invalid(path);
    } else if (key === 'temperature' || key === 'top_p') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > (key === 'temperature' ? 2 : 1)) invalid(path);
    } else if (key === 'previous_response_id') {
      if (!isRepresentableWireId(value)) invalid(path);
    } else if (key === 'metadata') {
      if (!object(value) || Object.keys(value).length > 16
        || Object.entries(value).some(([name, entry]) => name.length > 64 || typeof entry !== 'string' || entry.length > 512)) invalid(path);
    } else if (key === 'tools') {
      if (!Array.isArray(value) || value.some((tool) => !object(tool) || typeof tool.type !== 'string' || !tool.type.trim())) invalid(path);
    } else if (key === 'tool_choice') {
      if (typeof value === 'string') { if (!['auto', 'none', 'required'].includes(value)) invalid(path); }
      else if (!object(value) || typeof value.type !== 'string' || !value.type.trim()) invalid(path);
    } else if (key === 'reasoning') {
      const config = record(value, path, [], ['effort', 'summary', 'generate_summary', 'context', 'mode']);
      for (const [name, entry] of Object.entries(config)) {
        if (entry === null && ['effort', 'summary', 'generate_summary'].includes(name)) continue;
        const values = name === 'effort' ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']
          : name === 'context' ? ['auto'] : name === 'mode' ? ['standard'] : ['auto', 'concise', 'detailed'];
        if (typeof entry !== 'string' || !values.includes(entry)) invalid(`${path}.${name}`);
      }
    } else if (key === 'text') {
      const config = record(value, path, [], ['format', 'verbosity']);
      if (config.verbosity !== undefined && config.verbosity !== null
        && (typeof config.verbosity !== 'string' || !['low', 'medium', 'high'].includes(config.verbosity))) invalid(`${path}.verbosity`);
      if (config.format === undefined) continue;
      const format = record(config.format, `${path}.format`, ['type'], ['name', 'schema', 'strict', 'description']);
      if (typeof format.type !== 'string' || !['text', 'json_object', 'json_schema'].includes(format.type)) unsupported(`${path}.format.type`);
      if (format.type !== 'json_schema' && Object.keys(format).length !== 1) invalid(`${path}.format`);
      if (format.type === 'json_schema' && (typeof format.name !== 'string' || format.name.length < 1 || format.name.length > 64
        || /[^A-Za-z0-9_-]/.test(format.name) || !object(format.schema))) invalid(`${path}.format`);
      if (format.strict !== undefined && format.strict !== null && typeof format.strict !== 'boolean') invalid(`${path}.format.strict`);
      if (format.description !== undefined && typeof format.description !== 'string') invalid(`${path}.format.description`);
    } else if (key === 'conversation') {
      const conversation = record(value, path, ['id']);
      if (!isRepresentableWireId(conversation.id)) invalid(`${path}.id`);
    } else if (key === 'context_management') {
      if (!Array.isArray(value) || value.some((entry) => !object(entry))) invalid(path);
    } else if (key === 'prompt_cache_options') {
      const config = record(value, path, ['mode', 'ttl'], ['comparison_response_id']);
      if ((config.mode !== 'implicit' && config.mode !== 'explicit') || config.ttl !== '30m'
        || (config.comparison_response_id !== undefined && !isRepresentableWireId(config.comparison_response_id))) invalid(path);
    } else if (key === 'instructions') {
      if (typeof value !== 'string' && (!Array.isArray(value) || !parseResponsesRequest({ model: 'echo-validation', input: value }).ok)) invalid(path);
    } else if (['prompt', 'prompt_cache_diagnostics'].includes(key)) {
      if (!object(value)) invalid(path);
    } else {
      if (typeof value !== 'string') invalid(path);
      if (key === 'service_tier' && !['auto', 'default', 'flex', 'scale', 'priority', 'fast', 'ultrafast'].includes(value)) invalid(path);
      if (key === 'safety_identifier' && value.length > 64) invalid(path);
      if (key === 'prompt_cache_retention' && !['in_memory', '24h'].includes(value)) invalid(path);
      if (key === 'truncation' && !['auto', 'disabled'].includes(value)) invalid(path);
    }
  }
}

function nativeError(input: unknown, context: ResponseContext): ConversionResult<Output> | undefined {
  if (!input || typeof input !== 'object' || !Object.hasOwn(input, 'error') || Object.hasOwn(input, 'object') || Object.hasOwn(input, 'status')) return undefined;
  const envelope = record(input, '$', ['error']);
  if (!envelope.error || typeof envelope.error !== 'object' || Array.isArray(envelope.error)) invalid('$.error');
  const error = envelope.error as Record<string, unknown>;
  if (typeof error.message !== 'string' || (error.type !== undefined && typeof error.type !== 'string')) invalid('$.error');
  contextIdentity(context);
  const safe: ProtocolError = { kind: 'upstream_error', code: 'upstream_error', message: 'The upstream Responses request failed.' };
  const finish = normalizeFinish({ from: 'responses', rawReason: 'failed', error: safe });
  if (!finish.ok) return finish;
  return { ok: true, value: { body: encodeChatError(safe), identity: { ...context.identity }, terminal: finish.value.terminal } };
}

function displayUsage(source: Record<string, unknown>): ChatUsage | undefined {
  if (source.usage === undefined || source.usage === null) return undefined;
  const raw = record(source.usage, '$.usage', [], ['input_tokens', 'output_tokens', 'total_tokens', 'input_tokens_details', 'output_tokens_details']);
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens']) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'number' || !Number.isSafeInteger(raw[key]) || (raw[key] as number) < 0)) invalid(`$.usage.${key}`);
  }
  for (const [field, allowed, zeroOnly] of [
    ['input_tokens_details', ['cached_tokens', 'cache_write_tokens', 'audio_tokens'], ['audio_tokens']],
    ['output_tokens_details', ['reasoning_tokens', 'audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens'], ['audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens']],
  ] as const) {
    if (raw[field] === undefined) continue;
    const details = record(raw[field], `$.usage.${field}`, [], allowed);
    for (const key of Object.keys(details)) {
      if (typeof details[key] !== 'number' || !Number.isSafeInteger(details[key]) || (details[key] as number) < 0) invalid(`$.usage.${field}.${key}`);
    }
    for (const key of zeroOnly) if (details[key] !== undefined && details[key] !== 0) unsupported(`$.usage.${field}.${key}`);
  }
  // This is presentation of original evidence, not a new accumulator or charge.
  const usage = extractResponsesUsage(source);
  if (usage.quality === 'missing' || usage.quality === 'invalid') return undefined;
  if (usage.semantics.cacheRead !== 'included_in_input' || usage.semantics.cacheWrite !== 'included_in_input'
    || usage.semantics.reasoning !== 'included_in_output') unsupported('$.usage');
  const { inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens } = usage.counts;
  const total = totalTokens ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
  if (total !== undefined && !Number.isSafeInteger(total)) return undefined;
  return {
    ...(inputTokens === undefined ? {} : { prompt_tokens: inputTokens }),
    ...(outputTokens === undefined ? {} : { completion_tokens: outputTokens }),
    ...(total === undefined ? {} : { total_tokens: total }),
    ...(cacheReadTokens === undefined && cacheWriteTokens === undefined ? {} : { prompt_tokens_details: {
      ...(cacheReadTokens === undefined ? {} : { cached_tokens: cacheReadTokens }),
      ...(cacheWriteTokens === undefined ? {} : { cache_write_tokens: cacheWriteTokens }),
    } }),
    ...(reasoningTokens === undefined ? {} : { completion_tokens_details: { reasoning_tokens: reasoningTokens } }),
  };
}

function convert(input: unknown, context: ResponseContext): ConversionResult<Output> {
  jsonBoundary(input);
  const errorEnvelope = nativeError(input, context);
  if (errorEnvelope !== undefined) return errorEnvelope;
  const source = record(input, '$', ['id', 'object', 'created_at', 'model', 'status', 'output'], ['usage', 'error', 'incomplete_details', ...RESPONSE_METADATA_KEYS]);
  if (source.object !== 'response' || typeof source.model !== 'string' || !source.model.trim()
    || !Number.isSafeInteger(source.created_at) || (source.created_at as number) < 0 || !Array.isArray(source.output)) invalid('$');
  contextIdentity(context, source.id);
  if (typeof source.status !== 'string') invalid('$.status');
  responseMetadata(source);
  const usage = displayUsage(source);
  if (source.error !== undefined && source.error !== null && source.status !== 'failed') invalid('$.error');
  if (source.status === 'failed' && source.output.length) unsupported('$.output');
  let incompleteReason: string | undefined;
  if (source.incomplete_details !== undefined && source.incomplete_details !== null) {
    if (source.status !== 'incomplete') invalid('$.incomplete_details');
    const details = record(source.incomplete_details, '$.incomplete_details', ['reason']);
    if (typeof details.reason !== 'string') invalid('$.incomplete_details.reason');
    incompleteReason = details.reason;
  }
  const texts: string[] = [];
  const reasoning: string[] = [];
  const refusals: string[] = [];
  const phases = new Set<string>();
  const tools: ChatToolCall[] = [];
  const callIds = new Set<string>([context.identity.responseId]);
  const itemIds = new Set<string>([source.id as string]);
  for (const [index, raw] of source.output.entries()) {
    const path = `$.output[${index}]`;
    if (!raw || typeof raw !== 'object') invalid(path);
    if ((raw as Record<string, unknown>).type === 'reasoning') {
      const item = record(raw, path, ['type', 'id', 'summary'], ['status', 'encrypted_content']);
      if (!isRepresentableWireId(item.id) || itemIds.has(item.id) || !Array.isArray(item.summary)) invalid(path);
      itemIds.add(item.id);
      if (item.encrypted_content !== undefined && item.encrypted_content !== null) unsupported(`${path}.encrypted_content`);
      if (item.status !== undefined && item.status !== 'completed'
        && !(source.status === 'incomplete' && (item.status === 'incomplete' || item.status === 'in_progress'))) unsupported(`${path}.status`);
      for (const [summaryIndex, rawPart] of item.summary.entries()) {
        const partPath = `${path}.summary[${summaryIndex}]`;
        const part = record(rawPart, partPath, ['type', 'text']);
        if (part.type !== 'summary_text' || typeof part.text !== 'string') invalid(partPath);
        if (part.text.length && (texts.some((text) => text.length > 0) || tools.length || refusals.length)) unsupported(partPath);
        reasoning.push(part.text);
      }
      continue;
    }
    if ((raw as Record<string, unknown>).type === 'function_call') {
      if (refusals.length) unsupported(`${path}.type`);
      const item = record(raw, path, ['type', 'call_id', 'name', 'arguments'], ['id', 'status']);
      if (item.id !== undefined) {
        if (!isRepresentableWireId(item.id) || itemIds.has(item.id)) invalid(`${path}.id`);
        itemIds.add(item.id);
      }
      if (!isRepresentableWireId(item.call_id) || callIds.has(item.call_id)) invalid(`${path}.call_id`);
      callIds.add(item.call_id);
      if (typeof item.name !== 'string' || item.name.length < 1 || item.name.length > 64 || /[^A-Za-z0-9_-]/.test(item.name)
        || typeof item.arguments !== 'string') invalid(path);
      if (item.status !== undefined && item.status !== 'completed'
        && !(source.status === 'incomplete' && (item.status === 'incomplete' || item.status === 'in_progress'))) unsupported(`${path}.status`);
      if (source.status !== 'incomplete' || item.status === 'completed') try {
        const args: unknown = JSON.parse(item.arguments);
        if (!args || typeof args !== 'object' || Array.isArray(args)) invalid(`${path}.arguments`, 'invalid_tool_arguments');
      } catch (error) {
        if (error instanceof Fault) throw error;
        invalid(`${path}.arguments`, 'invalid_tool_arguments');
      }
      tools.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
      continue;
    }
    if ((raw as Record<string, unknown>).type !== 'message') unsupported(`${path}.type`);
    const item = record(raw, path, ['type', 'id', 'role', 'status', 'content'], ['phase']);
    if (!isRepresentableWireId(item.id) || itemIds.has(item.id) || item.role !== 'assistant' || !Array.isArray(item.content)) invalid(path);
    itemIds.add(item.id);
    if (item.phase !== undefined && item.phase !== null) {
      if (item.phase !== 'commentary' && item.phase !== 'final_answer') invalid(`${path}.phase`);
      phases.add(item.phase);
    }
    if (item.status !== 'completed' && !(source.status === 'incomplete' && (item.status === 'incomplete' || item.status === 'in_progress'))) unsupported(`${path}.status`);
    for (const [contentIndex, rawPart] of item.content.entries()) {
      const partPath = `${path}.content[${contentIndex}]`;
      if (!rawPart || typeof rawPart !== 'object') invalid(partPath);
      if ((rawPart as Record<string, unknown>).type === 'refusal') {
        const part = record(rawPart, partPath, ['type', 'refusal']);
        if (typeof part.refusal !== 'string') invalid(`${partPath}.refusal`);
        if (tools.length) unsupported(`${partPath}.refusal`);
        refusals.push(part.refusal);
        continue;
      }
      if ((rawPart as Record<string, unknown>).type !== 'output_text') unsupported(`${partPath}.type`);
      const part = record(rawPart, partPath, ['type', 'text', 'annotations'], ['logprobs']);
      if (typeof part.text !== 'string' || !Array.isArray(part.annotations)) invalid(partPath);
      if (part.annotations.length) unsupported(`${partPath}.annotations`);
      if (part.logprobs !== undefined && (!Array.isArray(part.logprobs) || part.logprobs.length)) unsupported(`${partPath}.logprobs`);
      if ((tools.length || refusals.length) && part.text.length > 0) unsupported(`${partPath}.text`);
      texts.push(part.text);
    }
  }
  if (source.output_text !== undefined && source.output_text !== null && source.output_text !== texts.join('')) invalid('$.output_text');
  // Chat can represent one final answer or tool-call commentary, not a mixture
  // of phase-labelled messages collapsed into one indistinguishable string.
  if (phases.size > 1 || (phases.has('final_answer') && tools.length > 0)
    || (phases.has('commentary') && tools.length === 0 && source.status === 'completed')) unsupported('$.output');
  const safeError: ProtocolError = { kind: 'upstream_error', code: 'upstream_error', message: 'The upstream Responses request failed.' };
  const finish = normalizeFinish({ from: 'responses', rawReason: source.status, hasToolCalls: tools.length > 0, hasRefusal: refusals.length > 0,
    ...(incompleteReason === undefined ? {} : { incompleteReason }), ...(source.status === 'failed' ? { error: safeError } : {}) });
  if (!finish.ok) return finish;
  const mapped = mapFinishToTarget(finish.value, 'chat', refusals.length ? { refusalPayload: { refusal: refusals.join('') } } : {});
  if (!mapped.ok) return mapped;
  if (mapped.value.kind === 'error') {
    if (finish.value.terminal.status !== 'failed') return { ok: false, error: mapped.value.error };
    return { ok: true, value: { body: encodeChatError(mapped.value.error), identity: { responseId: context.identity.responseId, upstreamResponseId: source.id as string }, terminal: finish.value.terminal } };
  }
  if ((mapped.value.kind !== 'native' && mapped.value.kind !== 'refusal') || mapped.value.to !== 'chat') unsupported('$.status');
  return { ok: true, value: {
    body: { id: context.identity.responseId, object: 'chat.completion', created: context.createdAt, model: context.targetModel,
      choices: [{ index: 0, message: { role: 'assistant', content: texts.length ? texts.join('') : null,
        ...(reasoning.length ? { reasoning_content: reasoning.join('') } : {}), ...(refusals.length ? { refusal: refusals.join('') } : {}), ...(tools.length ? { tool_calls: tools } : {}) }, finish_reason: mapped.value.finish_reason }],
      ...(usage === undefined ? {} : { usage }), ...(source.service_tier === undefined ? {} : { service_tier: source.service_tier as string | null }) },
    identity: { responseId: context.identity.responseId, upstreamResponseId: source.id as string },
    terminal: finish.value.terminal,
  } };
}

export function responsesToChatResponse(input: unknown, context: ResponseContext): ConversionResult<Output> {
  try { return convert(input, context); }
  catch (error) {
    return { ok: false, error: error instanceof Fault ? error.error : { kind: 'invalid_response', code: 'responses_to_chat_conversion_failed', message: 'The Responses response could not be converted.' } };
  }
}
export const responsesToChatResponseAdapter: JsonResponseAdapter<unknown, ResponsesToChatBody, 'responses', 'chat'> = Object.freeze({
  from: 'responses', to: 'chat', convert: responsesToChatResponse,
});
