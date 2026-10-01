/**
 * SPDX-License-Identifier: LGPL-3.0-only
 * Behavioral adaptation of Wei-Shaw/sub2api, commit
 * ab99d56e9626e6cd731592dae8553c9758a0efa2,
 * backend/internal/pkg/apicompat/chatcompletions_anthropic_bridge.go,
 * ChatCompletionsResponseToAnthropic / chatMessageToAnthropicBlocks,
 * blob 47d4601c24d2213fe2cb2a646a89f7aa0e5b5cdd.
 * Full texts: LICENSES/LGPL-3.0.txt and LICENSES/GPL-3.0.txt.
 * P-CM-J1, 2026-09-07: direct original TypeScript/synthetic tests; stable caller
 * ID/model, standard neutral Chat metadata, no reasoning-to-answer fallback.
 * P-CM-J3-E: native Chat errors become sanitized Messages error envelopes and
 * failed terminals; provider diagnostics never cross the protocol boundary.
 * P-CM-J3-T: explicit public reasoning aliases become unsigned compatible
 * thinking blocks; private/signature fields are never invented or downgraded.
 * P-CM-J4: original Chat usage is projected into Messages' cache-exclusive
 * counters once; partial/contradictory evidence is omitted, never zero-filled.
 */
import { parseChatResponse } from '../types/chat.js';
import type { ChatResponse } from '../types/chat.js';
import { isRepresentableWireId } from '../ids.js';
import { normalizeFinish, mapFinishToTarget } from '../finish-reasons.js';
import { encodeMessagesError } from '../errors.js';
import { extractChatUsage } from '../usage/chat.js';
import type { JsonResponseAdapter, JsonResponseOutput, ResponseContext } from '../types/adapter.js';
import type { MessagesError, MessagesResponse, MessagesOutputBlock, MessagesUsage } from '../types/messages.js';
import type { ConversionResult, JsonObject, ProtocolError } from '../types/shared.js';

export type ChatToMessagesBody = MessagesResponse | MessagesError;
type Output = JsonResponseOutput<ChatToMessagesBody>;
function failure(kind: ProtocolError['kind'], code: string, param?: string): ConversionResult<never> {
  return { ok: false, error: { kind, code, message: 'The Chat response cannot be represented as a Messages response.', ...(param === undefined ? {} : { param }) } };
}
const unsupported = (param: string) => failure('unsupported_feature', 'unsupported_chat_to_messages_response', param);
const extraKey = (value: object, allowed: readonly string[]) => Object.keys(value).find((key) => !allowed.includes(key));

/** Complete non-streaming Chat arguments must be a JSON object. Fragments are
 * only valid on the SSE path, where the stream adapter retains them. */
function parseToolArguments(value: string): JsonObject | undefined {
  if (value.length > 1_048_576) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return undefined; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const pending: { value: unknown; depth: number }[] = [{ value: parsed, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 100_000 || item.depth > 64) return undefined;
    const current = item.value;
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue;
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || (Number.isInteger(current) && !Number.isSafeInteger(current))) return undefined;
      continue;
    }
    if (typeof current !== 'object' || seen.has(current)) return undefined;
    seen.add(current);
    if (!Array.isArray(current) && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) return undefined;
    for (const key of Object.keys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !('value' in descriptor)) return undefined;
      pending.push({ value: descriptor.value, depth: item.depth + 1 });
    }
  }
  return parsed as JsonObject;
}

function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function nativeError(input: unknown, context: ResponseContext): ConversionResult<Output> | undefined {
  if (!input || typeof input !== 'object' || !Object.hasOwn(input, 'error')) return undefined;
  if (Object.hasOwn(input, 'choices') || extraKey(input, ['error'])) return failure('invalid_response', 'invalid_chat_error');
  const error = ownData(input, 'error');
  if (!error || typeof error !== 'object' || Array.isArray(error)
    || typeof ownData(error, 'message') !== 'string' || typeof ownData(error, 'type') !== 'string') {
    return failure('invalid_response', 'invalid_chat_error');
  }
  if (!context || !isRepresentableWireId(context.identity?.responseId) || typeof context.targetModel !== 'string'
    || !context.targetModel.trim() || typeof context.idFor !== 'function' || !Number.isSafeInteger(context.createdAt) || context.createdAt < 0) {
    return failure('invalid_response', 'invalid_response_context');
  }
  const safe: ProtocolError = { kind: 'upstream_error', code: 'upstream_error', message: 'The upstream Chat request failed.' };
  const finish = normalizeFinish({ from: 'chat', rawReason: null, event: 'failed', error: safe });
  if (!finish.ok) return finish;
  return { ok: true, value: { body: encodeMessagesError(safe), identity: { ...context.identity }, terminal: finish.value.terminal } };
}

function displayUsage(source: ChatResponse): ConversionResult<MessagesUsage | undefined> {
  const raw = source.usage;
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  const extra = extraKey(raw, ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_tokens_details', 'completion_tokens_details']);
  if (extra) return unsupported(`$.usage.${extra}`);
  for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const) {
    if (raw[field] !== undefined && (typeof raw[field] !== 'number' || !Number.isSafeInteger(raw[field]) || raw[field] < 0)) return failure('invalid_response', 'invalid_usage', `$.usage.${field}`);
  }
  for (const [field, allowed, zeroOnly] of [
    ['prompt_tokens_details', ['cached_tokens', 'cache_write_tokens', 'audio_tokens'], ['audio_tokens']],
    ['completion_tokens_details', ['reasoning_tokens', 'audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens'], ['audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens']],
  ] as const) {
    const details = raw[field];
    if (details === undefined) continue;
    if (!details || typeof details !== 'object' || Array.isArray(details)) return failure('invalid_response', 'invalid_usage', `$.usage.${field}`);
    const detailExtra = extraKey(details, allowed);
    if (detailExtra) return unsupported(`$.usage.${field}.${detailExtra}`);
    for (const key of Object.keys(details)) {
      const value = details[key];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return failure('invalid_response', 'invalid_usage', `$.usage.${field}.${key}`);
      if ((zeroOnly as readonly string[]).includes(key) && value !== 0) return unsupported(`$.usage.${field}.${key}`);
    }
  }
  // P14 remains the only accounting source. This function only changes field
  // names and input-token inclusion semantics for the target wire shape.
  const observed = extractChatUsage(source);
  if (observed.quality !== 'complete' || observed.semantics.cacheRead !== 'included_in_input'
    || observed.semantics.cacheWrite !== 'included_in_input' || observed.semantics.reasoning !== 'included_in_output') {
    return { ok: true, value: undefined };
  }
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens } = observed.counts;
  if (inputTokens === undefined || outputTokens === undefined) return { ok: true, value: undefined };
  // Chat prompt_tokens includes any reported cache buckets. Subtract the
  // buckets that are actually present and retain the remainder as the target's
  // input_tokens aggregate. With a missing cache subdivision this is a display
  // projection of residual input, never a claim of a precise cache-exclusive
  // measurement; absent target fields stay absent rather than becoming zero.
  const input = inputTokens - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0);
  if (!Number.isSafeInteger(input) || input < 0) return { ok: true, value: undefined };
  return { ok: true, value: {
    input_tokens: input, output_tokens: outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cache_read_input_tokens: cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cache_creation_input_tokens: cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { output_tokens_details: { thinking_tokens: reasoningTokens } }),
  } };
}

function convert(input: unknown, context: ResponseContext): ConversionResult<Output> {
  const failed = nativeError(input, context);
  if (failed !== undefined) return failed;
  const parsed = parseChatResponse(input, { unknownFields: 'preserve' });
  if (!parsed.ok) return parsed;
  const source = parsed.value;
  if (!context || !isRepresentableWireId(context.identity?.responseId) || !isRepresentableWireId(source.id)
    || typeof context.targetModel !== 'string' || !context.targetModel.trim() || typeof context.idFor !== 'function'
    || !Number.isSafeInteger(context.createdAt) || context.createdAt < 0
    || (context.identity.upstreamResponseId !== undefined && context.identity.upstreamResponseId !== source.id)) return failure('invalid_response', 'invalid_response_context');
  const extra = extraKey(source, ['id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint', 'service_tier']);
  if (extra) return unsupported(`$.${extra}`);
  if (source.service_tier !== undefined && source.service_tier !== null
    && !['auto', 'default', 'flex', 'scale', 'priority', 'fast', 'ultrafast'].includes(source.service_tier)) return unsupported('$.service_tier');
  // Valid service_tier/fingerprint are source-provider metadata; they are not
  // an Anthropic tier or generated Message content and do not alter billing.
  const usage = displayUsage(source);
  if (!usage.ok) return usage;
  if (usage.value === undefined) return failure('unsupported_feature', 'usage_not_representable', '$.usage');
  if (source.choices.length !== 1 || source.choices[0]?.index !== 0) return unsupported('$.choices');
  const choice = source.choices[0];
  const choiceExtra = extraKey(choice, ['index', 'message', 'finish_reason', 'logprobs']);
  if (choiceExtra) return unsupported(`$.choices[0].${choiceExtra}`);
  if (choice.logprobs !== undefined && choice.logprobs !== null) return unsupported('$.choices[0].logprobs');
  const messageExtra = extraKey(choice.message, ['role', 'content', 'annotations', 'refusal', 'tool_calls', 'reasoning', 'reasoning_content']);
  if (messageExtra) return unsupported(`$.choices[0].message.${messageExtra}`);
  if (choice.message.annotations !== undefined && choice.message.annotations.length > 0) return unsupported('$.choices[0].message.annotations');
  const refusal = typeof choice.message.refusal === 'string' ? choice.message.refusal : undefined;
  if (refusal !== undefined && choice.message.content !== null && choice.message.content.length > 0) {
    return unsupported('$.choices[0].message.refusal');
  }
  const tools = choice.message.tool_calls ?? [];
  const usedCallIds = new Set<string>([context.identity.responseId]);
  const toolBlocks: MessagesOutputBlock[] = [];
  for (const [index, call] of tools.entries()) {
    const path = `$.choices[0].message.tool_calls[${index}]`;
    const callExtra = extraKey(call, ['id', 'type', 'function']);
    if (callExtra) return unsupported(`${path}.${callExtra}`);
    const functionExtra = extraKey(call.function, ['name', 'arguments']);
    if (functionExtra) return unsupported(`${path}.function.${functionExtra}`);
    if (!isRepresentableWireId(call.id) || usedCallIds.has(call.id)) return failure('invalid_response', 'invalid_tool_call_id', `${path}.id`);
    if (call.function.name.length < 1 || call.function.name.length > 64 || /[^A-Za-z0-9_-]/u.test(call.function.name)) return unsupported(`${path}.function.name`);
    const input = parseToolArguments(call.function.arguments);
    if (input === undefined) return failure('invalid_response', 'invalid_tool_arguments', `${path}.function.arguments`);
    usedCallIds.add(call.id);
    toolBlocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
  }
  const primaryReasoning = typeof choice.message.reasoning_content === 'string' ? choice.message.reasoning_content : undefined;
  const aliasReasoning = typeof choice.message.reasoning === 'string' ? choice.message.reasoning : undefined;
  if (primaryReasoning !== undefined && aliasReasoning !== undefined && primaryReasoning !== aliasReasoning) {
    return failure('invalid_response', 'conflicting_reasoning_aliases');
  }
  const reasoning = primaryReasoning ?? aliasReasoning;
  const finish = normalizeFinish({ from: 'chat', rawReason: choice.finish_reason, hasToolCalls: tools.length > 0, hasRefusal: refusal !== undefined });
  if (!finish.ok) return finish;
  const target = mapFinishToTarget(finish.value, 'messages');
  if (!target.ok) return target;
  if (target.value.kind === 'error') return { ok: false, error: target.value.error };
  if (target.value.kind !== 'native' || target.value.to !== 'messages') return failure('invalid_response', 'unrepresentable_chat_finish');
  const text = refusal === undefined ? choice.message.content : refusal;
  const content: MessagesOutputBlock[] = [
    ...(reasoning === undefined || reasoning.length === 0 ? [] : [{ type: 'thinking' as const, thinking: reasoning, signature: '' }]),
    ...(text === null ? [] : [{ type: 'text' as const, text }]),
    ...toolBlocks,
  ];
  return { ok: true, value: {
      body: { id: context.identity.responseId, type: 'message', role: 'assistant', model: context.targetModel, content,
      stop_reason: target.value.stop_reason, stop_sequence: null, ...(usage.value === undefined ? {} : { usage: usage.value }) },
    identity: { responseId: context.identity.responseId, upstreamResponseId: source.id }, terminal: finish.value.terminal,
  } };
}
export function chatToMessagesResponse(input: unknown, context: ResponseContext): ConversionResult<Output> {
  try { return convert(input, context); }
  catch { return failure('invalid_response', 'chat_to_messages_conversion_failed'); }
}
export const chatToMessagesResponseAdapter: JsonResponseAdapter<unknown, ChatToMessagesBody, 'chat', 'messages'> = Object.freeze({
  from: 'chat', to: 'messages', convert: chatToMessagesResponse,
});
