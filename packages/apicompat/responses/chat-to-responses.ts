/**
 * SPDX-License-Identifier: LGPL-3.0-only
 * Behavioral adaptation of Wei-Shaw/sub2api, commit
 * ab99d56e9626e6cd731592dae8553c9758a0efa2,
 * backend/internal/pkg/apicompat/chatcompletions_responses_bridge.go
 * (ChatCompletionsResponseToResponses / chatMessageToResponsesOutput),
 * blob e9f7ff03540047747e98670b5f8a875947afead6.
 * Full texts: LICENSES/LGPL-3.0.txt and LICENSES/GPL-3.0.txt.
 * Changes 2026-09-06, P-CR-J1: original TypeScript implementation/tests;
 * caller-owned stable IDs/model/time; reject unmapped fields and alternatives;
 * never substitute reasoning for visible text or fabricate empty usage.
 * P-CR-J2: preserve ordered function calls, original call IDs and raw complete
 * argument objects. Unlike the reference, do not invent {} or drop bad calls.
 * P-CR-J3: P11 native terminal mapping, refusal payloads and incomplete tool
 * arguments remain explicit; unknown terminal reasons fail conversion.
 * P-CR-J3-E: native Chat errors become P06-sanitized Responses error envelopes
 * and P11 failed terminals; never reflect provider messages or credential fields.
 * P-CR-J3-T: explicit reasoning aliases become native reasoning summary items;
 * conflicting aliases/private signatures are rejected, never turned into text.
 * P-CR-J4: P12 original-upstream usage is projected for display only. Missing,
 * partial or contradictory evidence emits no exact usage. Known zero-only
 * unrepresentable counters are omitted; nonzero unsupported buckets fail.
 * CR-JSON-STANDARD: verified service_tier metadata is echoed to the native target
 * field. Valid system_fingerprint is provider diagnostic metadata, not output.
 * CR-JSON-ANNOTATIONS: ordinary Chat annotations:[] is accepted; nonempty
 * citations need a dedicated semantic mapping and are never silently dropped.
 */
import { parseChatResponse } from '../types/chat.js';
import type { ChatResponse } from '../types/chat.js';
import { extractChatUsage } from '../usage/chat.js';
import { isRepresentableWireId } from '../ids.js';
import { normalizeFinish, mapFinishToTarget } from '../finish-reasons.js';
import { encodeResponsesError } from '../errors.js';
import type { ResponsesErrorBody } from '../errors.js';
import type { JsonResponseAdapter, JsonResponseOutput, ResponseContext } from '../types/adapter.js';
import type { ResponsesResponse, ResponsesOutputItem, ResponsesOutputContent, ResponsesUsage, ResponsesServiceTier } from '../types/responses.js';
import type { ConversionResult, ProtocolError } from '../types/shared.js';

export type ChatToResponsesBody = ResponsesResponse | ResponsesErrorBody;
type Output = JsonResponseOutput<ChatToResponsesBody>;
function failure(kind: ProtocolError['kind'], code: string, param?: string): ConversionResult<never> {
  return { ok: false, error: { kind, code, message: 'The Chat response cannot be represented as a Responses response.', ...(param === undefined ? {} : { param }) } };
}
function unsupported(param: string): ConversionResult<never> { return failure('unsupported_feature', 'unsupported_chat_to_responses_response', param); }
function unknownKey(value: object, allowed: readonly string[]): string | undefined {
  return Object.keys(value).find((key) => !allowed.includes(key));
}
function isResponsesServiceTier(value: unknown): value is ResponsesServiceTier {
  return typeof value === 'string' && ['auto', 'default', 'flex', 'scale', 'priority', 'fast', 'ultrafast'].includes(value);
}

function validContext(context: ResponseContext, upstreamId?: string): boolean {
  return !!context && typeof context.targetModel === 'string' && context.targetModel.trim().length > 0
    && Number.isSafeInteger(context.createdAt) && context.createdAt >= 0 && typeof context.idFor === 'function'
    && isRepresentableWireId(context.identity?.responseId)
    && (upstreamId === undefined || isRepresentableWireId(upstreamId))
    && (context.identity.upstreamResponseId === undefined || (isRepresentableWireId(context.identity.upstreamResponseId)
      && (upstreamId === undefined || context.identity.upstreamResponseId === upstreamId)));
}

function ownData(value: object, key: string): unknown {
  return (value as Record<string, unknown>)[key];
}

function nativeError(input: unknown, context: ResponseContext): ConversionResult<Output> | undefined {
  if (!input || typeof input !== 'object' || !Object.hasOwn(input, 'error')) return undefined;
  if (!validContext(context)) return failure('invalid_response', 'invalid_response_context');
  const error = ownData(input, 'error');
  if (!error || typeof error !== 'object' || Array.isArray(error) || Object.hasOwn(input, 'choices')
    || typeof ownData(error, 'message') !== 'string' || typeof ownData(error, 'type') !== 'string') {
    return failure('invalid_response', 'invalid_chat_error');
  }
  const safe: ProtocolError = { kind: 'upstream_error', code: 'upstream_error', message: 'The upstream Chat request failed.' };
  const finish = normalizeFinish({ from: 'chat', rawReason: null, event: 'failed', error: safe });
  if (!finish.ok) return finish;
  return { ok: true, value: { body: encodeResponsesError(safe), identity: { ...context.identity }, terminal: finish.value.terminal } };
}

function displayUsage(source: ChatResponse): ConversionResult<ResponsesUsage | undefined> {
  const raw = source.usage;
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  const extra = unknownKey(raw, ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_tokens_details', 'completion_tokens_details']);
  if (extra) return unsupported(`$.usage.${extra}`);
  for (const [field, supported, zeroOnly] of [
    ['prompt_tokens_details', ['cached_tokens', 'cache_write_tokens', 'audio_tokens'], ['audio_tokens']],
    ['completion_tokens_details', ['reasoning_tokens', 'audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens'], ['audio_tokens', 'accepted_prediction_tokens', 'rejected_prediction_tokens']],
  ] as const) {
    const details = raw[field];
    if (details === undefined) continue;
    const unknown = unknownKey(details, supported);
    if (unknown) return unsupported(`$.usage.${field}.${unknown}`);
    for (const key of zeroOnly) if (details[key] !== undefined && details[key] !== 0) return unsupported(`$.usage.${field}.${key}`);
  }
  // Pure interpretation of original Chat evidence; never extract tokens from the
  // converted body or add pricing/charges. Gateway accounting still owns that source.
  const usage = extractChatUsage(source);
  if (usage.quality !== 'complete') return { ok: true, value: undefined };
  const { inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens } = usage.counts;
  if (usage.semantics.cacheRead !== 'included_in_input' || usage.semantics.reasoning !== 'included_in_output') {
    return unsupported('$.usage');
  }
  // P13 recognizes this explicit cache-write extension. The target's details
  // shape requires a known cached_tokens count; never synthesize that count as 0.
  if (cacheWriteTokens !== undefined && cacheWriteTokens !== 0 && cacheReadTokens === undefined) {
    return unsupported('$.usage.prompt_tokens_details.cache_write_tokens');
  }
  if (cacheWriteTokens !== undefined && usage.semantics.cacheWrite !== 'included_in_input') return unsupported('$.usage');
  const total = totalTokens ?? inputTokens + outputTokens;
  if (!Number.isSafeInteger(total)) return { ok: true, value: undefined };
  return { ok: true, value: {
    input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: total,
    ...(cacheReadTokens === undefined ? {} : { input_tokens_details: { cached_tokens: cacheReadTokens,
      ...(cacheWriteTokens === undefined ? {} : { cache_write_tokens: cacheWriteTokens }),
    } }),
    ...(reasoningTokens === undefined ? {} : { output_tokens_details: { reasoning_tokens: reasoningTokens } }),
  } };
}

function convert(input: unknown, context: ResponseContext): ConversionResult<Output> {
  const failed = nativeError(input, context);
  if (failed !== undefined) return failed;
  const parsed = parseChatResponse(input, { unknownFields: 'preserve' });
  if (!parsed.ok) return parsed;
  const source = parsed.value;
  if (!validContext(context, source.id)) {
    return failure('invalid_response', 'invalid_response_context');
  }
  const top = unknownKey(source, ['id', 'object', 'created', 'model', 'choices', 'usage', 'system_fingerprint', 'service_tier']);
  if (top) return unsupported(`$.${top}`);
  const serviceTier = source.service_tier;
  if (serviceTier !== undefined && serviceTier !== null && !isResponsesServiceTier(serviceTier)) {
    return failure('invalid_response', 'invalid_service_tier', '$.service_tier');
  }
  const usage = displayUsage(source);
  if (!usage.ok) return usage;
  if (source.choices.length !== 1 || source.choices[0]?.index !== 0) return unsupported('$.choices');
  const choice = source.choices[0];
  const choiceKey = unknownKey(choice, ['index', 'message', 'finish_reason', 'logprobs']);
  if (choiceKey) return unsupported(`$.choices[0].${choiceKey}`);
  if (choice.logprobs !== undefined && choice.logprobs !== null) return unsupported('$.choices[0].logprobs');
  const messageKey = unknownKey(choice.message, ['role', 'content', 'tool_calls', 'refusal', 'reasoning_content', 'reasoning', 'annotations']);
  if (messageKey) return unsupported(`$.choices[0].message.${messageKey}`);
  if (choice.message.annotations !== undefined) {
    if (!Array.isArray(choice.message.annotations)) return failure('invalid_response', 'invalid_annotations', '$.choices[0].message.annotations');
    if (choice.message.annotations.length > 0) return unsupported('$.choices[0].message.annotations');
  }
  const tools = choice.message.tool_calls ?? [];
  if (['tool_calls', 'function_call'].includes(choice.finish_reason) && tools.length === 0) return failure('invalid_response', 'missing_tool_calls');
  const interrupted = choice.finish_reason === 'length' || choice.finish_reason === 'content_filter';
  const usedIds = new Set<string>([context.identity.responseId]);
  for (const [index, call] of tools.entries()) {
    const path = `$.choices[0].message.tool_calls[${index}]`;
    const extra = unknownKey(call, ['id', 'type', 'function']);
    if (extra) return unsupported(`${path}.${extra}`);
    const functionExtra = unknownKey(call.function, ['name', 'arguments']);
    if (functionExtra) return unsupported(`${path}.function.${functionExtra}`);
    if (!isRepresentableWireId(call.id) || usedIds.has(call.id)) return failure('invalid_response', 'invalid_tool_call_id', `${path}.id`);
    if (call.function.name.length < 1 || call.function.name.length > 64 || /[^A-Za-z0-9_-]/.test(call.function.name)) return unsupported(`${path}.function.name`);
    if (!interrupted) try {
      const argumentsValue: unknown = JSON.parse(call.function.arguments);
      if (argumentsValue === null || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) return failure('invalid_response', 'invalid_tool_arguments', `${path}.function.arguments`);
    } catch { return failure('invalid_response', 'invalid_tool_arguments', `${path}.function.arguments`); }
    usedIds.add(call.id);
  }
  const refusal = typeof choice.message.refusal === 'string' ? choice.message.refusal : undefined;
  const primaryReasoning = typeof choice.message.reasoning_content === 'string' ? choice.message.reasoning_content : undefined;
  const aliasReasoning = typeof choice.message.reasoning === 'string' ? choice.message.reasoning : undefined;
  if (primaryReasoning !== undefined && aliasReasoning !== undefined && primaryReasoning !== aliasReasoning) {
    return failure('invalid_response', 'conflicting_reasoning_aliases');
  }
  const reasoning = primaryReasoning ?? aliasReasoning;
  const finish = normalizeFinish({ from: 'chat', rawReason: choice.finish_reason, hasToolCalls: tools.length > 0, hasRefusal: refusal !== undefined });
  if (!finish.ok) return finish;
  const mapped = mapFinishToTarget(finish.value, 'responses', refusal === undefined ? {} : { refusalPayload: { refusal } });
  if (!mapped.ok) return mapped;
  if (mapped.value.kind === 'error') return { ok: false, error: mapped.value.error };
  if ((mapped.value.kind !== 'native' && mapped.value.kind !== 'refusal') || mapped.value.to !== 'responses') return failure('invalid_response', 'unrepresentable_chat_finish');
  const status = mapped.value.status;
  const incompleteDetails = mapped.value.kind === 'native' ? mapped.value.incomplete_details : null;
  const output: ResponsesOutputItem[] = [];
  const itemId = (key: string): string | undefined => {
    const id = context.idFor('item', key);
    if (!isRepresentableWireId(id) || usedIds.has(id)) return undefined;
    usedIds.add(id);
    return id;
  };
  if (reasoning !== undefined) {
    const id = itemId('chat:choice:0:reasoning');
    if (id === undefined) return failure('invalid_response', 'invalid_response_item_id');
    output.push({ type: 'reasoning', id, status, summary: [{ type: 'summary_text', text: reasoning }] });
  }
  if (choice.message.content !== null || refusal !== undefined) {
    const id = itemId('chat:choice:0:message');
    if (id === undefined) return failure('invalid_response', 'invalid_response_item_id');
    const content: ResponsesOutputContent[] = [];
    if (choice.message.content !== null) content.push({ type: 'output_text', text: choice.message.content, annotations: [] });
    if (refusal !== undefined) content.push({ type: 'refusal', refusal });
    output.push({ type: 'message', id, role: 'assistant', status, content });
  }
  for (const [index, call] of tools.entries()) {
    const id = itemId(`chat:choice:0:tool:${index}`);
    if (id === undefined) return failure('invalid_response', 'invalid_response_item_id');
    output.push({ type: 'function_call', id, call_id: call.id, name: call.function.name, arguments: call.function.arguments, status });
  }
  return { ok: true, value: {
    body: { id: context.identity.responseId, object: 'response', created_at: context.createdAt, model: context.targetModel,
      status, output, incomplete_details: incompleteDetails, ...(usage.value === undefined ? {} : { usage: usage.value }),
      ...(serviceTier === undefined ? {} : { service_tier: serviceTier }) },
    identity: { responseId: context.identity.responseId, upstreamResponseId: source.id },
    terminal: finish.value.terminal,
  } };
}

/** Direct JSON adapter; usage extraction/charging belongs to the gateway. */
export function chatToResponsesResponse(input: unknown, context: ResponseContext): ConversionResult<Output> {
  try { return convert(input, context); }
  catch { return failure('invalid_response', 'chat_to_responses_conversion_failed'); }
}
export const chatToResponsesResponseAdapter: JsonResponseAdapter<unknown, ChatToResponsesBody, 'chat', 'responses'> = Object.freeze({
  from: 'chat', to: 'responses', convert: chatToResponsesResponse,
});
