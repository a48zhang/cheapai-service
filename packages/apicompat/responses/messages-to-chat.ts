/**
 * SPDX-License-Identifier: LGPL-3.0-only
 * Independent direct Messages -> Chat implementation; the pinned baseline does
 * not establish a corresponding direct upstream response converter.
 * Semantic reference: Wei-Shaw/sub2api, commit ab99d56e9626e6cd731592dae8553c9758a0efa2,
 * backend/internal/pkg/apicompat/anthropic_to_responses_response.go
 * (43542dfaaf34ccf4de2da43a56e5802d8d42d3e3) and responses_to_chatcompletions.go
 * (d288b31bea08823de678bca8f743bef6422e7463). Neither is invoked as a pivot.
 * Full license texts: LICENSES/LGPL-3.0.txt and LICENSES/GPL-3.0.txt.
 * P-MC-J1, 2026-09-06: original TypeScript and synthetic tests; stable P05 caller
 * identity/time/public model, ordered text blocks, no silently consumed content.
 * P-MC-J2: direct tool_use objects serialize once to Chat argument strings;
 * preserve call IDs and order, reject text/tool interleaving that Chat cannot encode.
 * P-MC-J3: P11 maps end-turn/stop-sequence/length/tool/refusal semantics;
 * refusal text is a refusal field, not a normal answer; pause/null is not success.
 * P-MC-J3-E: native error events/envelopes use P06 public errors and P11 failure,
 * never provider message/type/request_id as public diagnostic authority.
 * P-MC-J3-T: unsigned compatible thinking becomes reasoning_content. Nonempty
 * opaque signatures and redacted thinking have no native Chat representation.
 * P-MC-J4: P14 original usage display only. Inclusive Chat input is computed
 * only from known uncached/read/write counts; TTL subdivisions remain detail
 * metadata, not extra tokens. Neutral provider metadata does not alter prices.
 */
import { parseMessagesResponse, parseMessagesStreamEvent } from '../types/messages.js';
import { encodeChatError } from '../errors.js';
import { extractMessagesUsage } from '../usage/messages.js';
import type { MessagesResponse } from '../types/messages.js';
import { isRepresentableWireId } from '../ids.js';
import { normalizeFinish, mapFinishToTarget } from '../finish-reasons.js';
import type { JsonResponseAdapter, JsonResponseOutput, ResponseContext } from '../types/adapter.js';
import type { ChatResponse, ChatToolCall, ChatErrorBody, ChatUsage } from '../types/chat.js';
import type { ConversionResult, ProtocolError } from '../types/shared.js';

export type MessagesToChatBody = ChatResponse | ChatErrorBody;
type Output = JsonResponseOutput<MessagesToChatBody>;
function failure(kind: ProtocolError['kind'], code: string, param?: string): ConversionResult<never> {
  return { ok: false, error: { kind, code, message: 'The Messages response cannot be represented as a Chat response.', ...(param === undefined ? {} : { param }) } };
}
const unsupported = (param: string) => failure('unsupported_feature', 'unsupported_messages_to_chat_response', param);
const extraKey = (value: object, keys: readonly string[]) => Object.keys(value).find((key) => !keys.includes(key));

function validContext(context: ResponseContext, upstreamId?: string): boolean {
  return !!context && isRepresentableWireId(context.identity?.responseId)
    && (upstreamId === undefined || isRepresentableWireId(upstreamId))
    && typeof context.targetModel === 'string' && context.targetModel.trim().length > 0 && typeof context.idFor === 'function'
    && Number.isSafeInteger(context.createdAt) && context.createdAt >= 0
    && (context.identity.upstreamResponseId === undefined || (isRepresentableWireId(context.identity.upstreamResponseId)
      && (upstreamId === undefined || context.identity.upstreamResponseId === upstreamId)));
}

function nativeError(input: unknown, context: ResponseContext): ConversionResult<Output> | undefined {
  if (!input || typeof input !== 'object') return undefined;
  if ((input as Record<string, unknown>).type !== 'error') return undefined;
  // The error variant shares its native shape with Messages SSE errors; only
  // validation is reused here, not a streaming/pivot conversion.
  const parsed = parseMessagesStreamEvent(input, { unknownFields: 'preserve' });
  if (!parsed.ok) return parsed;
  const key = extraKey(parsed.value, ['type', 'error', 'request_id']);
  if (key) return unsupported(`$.${key}`);
  if (!validContext(context)) return failure('invalid_response', 'invalid_response_context');
  const safe: ProtocolError = { kind: 'upstream_error', code: 'upstream_error', message: 'The upstream Messages request failed.' };
  const finish = normalizeFinish({ from: 'messages', rawReason: null, event: 'failed', error: safe });
  if (!finish.ok) return finish;
  return { ok: true, value: { body: encodeChatError(safe), identity: { ...context.identity }, terminal: finish.value.terminal } };
}

function displayUsage(source: MessagesResponse): ConversionResult<ChatUsage | undefined> {
  const raw = source.usage;
  if (raw === undefined) return { ok: true, value: undefined };
  const key = extraKey(raw, ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'cache_creation', 'output_tokens_details', 'service_tier', 'inference_geo', 'server_tool_use']);
  if (key) return unsupported(`$.usage.${key}`);
  for (const [field, keys] of [
    ['cache_creation', ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']],
    ['output_tokens_details', ['thinking_tokens']],
    ['server_tool_use', ['web_fetch_requests', 'web_search_requests']],
  ] as const) {
    const details = raw[field];
    if (details === undefined || details === null) continue;
    const extra = extraKey(details, keys);
    if (extra) return unsupported(`$.usage.${field}.${extra}`);
  }
  // Read original upstream evidence, never a converted Chat body or prices.
  const usage = extractMessagesUsage(source);
  if (usage.quality === 'missing' || usage.quality === 'invalid') return { ok: true, value: undefined };
  if (usage.semantics.cacheRead !== 'excluded_from_input' || usage.semantics.cacheWrite !== 'excluded_from_input'
    || usage.semantics.reasoning !== 'included_in_output') return unsupported('$.usage');
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cacheWrite5mTokens, cacheWrite1hTokens, reasoningTokens } = usage.counts;
  const prompt = inputTokens !== undefined && cacheReadTokens !== undefined && cacheWriteTokens !== undefined
    ? inputTokens + cacheReadTokens + cacheWriteTokens : undefined;
  const total = prompt !== undefined && outputTokens !== undefined ? prompt + outputTokens : undefined;
  if ((prompt !== undefined && !Number.isSafeInteger(prompt)) || (total !== undefined && !Number.isSafeInteger(total))) return { ok: true, value: undefined };
  const ttlDetails = cacheWrite5mTokens !== undefined || cacheWrite1hTokens !== undefined ? {
    ...(cacheWrite5mTokens === undefined ? {} : { ephemeral_5m_input_tokens: cacheWrite5mTokens }),
    ...(cacheWrite1hTokens === undefined ? {} : { ephemeral_1h_input_tokens: cacheWrite1hTokens }),
  } : undefined;
  return { ok: true, value: {
    ...(prompt === undefined ? {} : { prompt_tokens: prompt }),
    ...(outputTokens === undefined ? {} : { completion_tokens: outputTokens }),
    ...(total === undefined ? {} : { total_tokens: total }),
    ...(cacheReadTokens === undefined && cacheWriteTokens === undefined && ttlDetails === undefined ? {} : { prompt_tokens_details: {
      ...(cacheReadTokens === undefined ? {} : { cached_tokens: cacheReadTokens }),
      ...(cacheWriteTokens === undefined ? {} : { cache_write_tokens: cacheWriteTokens }),
      ...(ttlDetails === undefined ? {} : { cache_creation: ttlDetails }),
    } }),
    ...(reasoningTokens === undefined ? {} : { completion_tokens_details: { reasoning_tokens: reasoningTokens } }),
  } };
}

function convert(input: unknown, context: ResponseContext): ConversionResult<Output> {
  const error = nativeError(input, context);
  if (error !== undefined) return error;
  const parsed = parseMessagesResponse(input, { unknownFields: 'preserve' });
  if (!parsed.ok) return parsed;
  const source = parsed.value;
  if (!validContext(context, source.id)) {
    return failure('invalid_response', 'invalid_response_context');
  }
  const extra = extraKey(source, ['id', 'type', 'role', 'model', 'content', 'stop_reason', 'stop_sequence', 'usage', 'container', 'stop_details']);
  if (extra) return unsupported(`$.${extra}`);
  // P04 validates container/stop_details as standard metadata. They do not
  // authorize server-tool execution or become generated answer text.
  if (source.container !== undefined && source.container !== null) {
    const key = extraKey(source.container, ['id', 'expires_at', 'skills']);
    if (key) return unsupported(`$.container.${key}`);
    for (const [index, skill] of (source.container.skills ?? []).entries()) {
      const skillKey = extraKey(skill, ['skill_id', 'type', 'version']);
      if (skillKey) return unsupported(`$.container.skills[${index}].${skillKey}`);
    }
  }
  if (source.stop_details !== undefined && source.stop_details !== null) {
    const key = extraKey(source.stop_details, ['type', 'category', 'explanation', 'recommended_model']);
    if (key) return unsupported(`$.stop_details.${key}`);
  }
  if (source.stop_details !== undefined && source.stop_details !== null && source.stop_reason !== 'refusal') {
    return failure('invalid_response', 'inconsistent_stop_details', '$.stop_details');
  }
  const usage = displayUsage(source);
  if (!usage.ok) return usage;
  if (source.stop_sequence !== null && source.stop_reason !== 'stop_sequence') return failure('invalid_response', 'inconsistent_stop_sequence', '$.stop_sequence');
  const texts: string[] = [];
  const thinking: string[] = [];
  const tools: ChatToolCall[] = [];
  const callIds = new Set<string>([context.identity.responseId]);
  for (const [index, block] of source.content.entries()) {
    const path = `$.content[${index}]`;
    if (block.type === 'thinking') {
      const key = extraKey(block, ['type', 'thinking', 'signature']);
      if (key) return unsupported(`${path}.${key}`);
      if (block.signature !== '') return unsupported(`${path}.signature`);
      if (block.thinking.length && (tools.length || texts.some((value) => value.length > 0))) return unsupported(`${path}.thinking`);
      thinking.push(block.thinking);
      continue;
    }
    if (block.type === 'redacted_thinking') return unsupported(`${path}.data`);
    if (block.type === 'tool_use') {
      const key = extraKey(block, ['type', 'id', 'name', 'input', 'cache_control']);
      if (key) return unsupported(`${path}.${key}`);
      if (!isRepresentableWireId(block.id) || callIds.has(block.id)) return failure('invalid_response', 'invalid_tool_call_id', `${path}.id`);
      if (block.name.length < 1 || block.name.length > 64 || /[^A-Za-z0-9_-]/.test(block.name)) return unsupported(`${path}.name`);
      if (block.cache_control !== undefined && block.cache_control !== null) return unsupported(`${path}.cache_control`);
      // P04 has validated a JSON object; integer precision cannot be recovered
      // once an unsafe JSON numeric ID has already been parsed by the caller.
      const pending: unknown[] = [block.input];
      while (pending.length) {
        const value = pending.pop();
        if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) return unsupported(`${path}.input`);
        if (value && typeof value === 'object') pending.push(...Object.values(value));
      }
      callIds.add(block.id);
      tools.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } });
      continue;
    }
    if (block.type !== 'text') return unsupported(`${path}.type`);
    const key = extraKey(block, ['type', 'text', 'citations', 'cache_control']);
    if (key) return unsupported(`${path}.${key}`);
    if (block.citations !== undefined && block.citations !== null && block.citations.length > 0) return unsupported(`${path}.citations`);
    if (block.cache_control !== undefined && block.cache_control !== null) return unsupported(`${path}.cache_control`);
    if (tools.length && block.text.length > 0) return unsupported(`${path}.text`);
    texts.push(block.text);
  }
  if (source.stop_reason === 'tool_use' && tools.length === 0) return failure('invalid_response', 'missing_tool_use');
  if (tools.length && ['end_turn', 'stop_sequence', 'refusal'].includes(source.stop_reason ?? '')) return unsupported('$.stop_reason');
  const finish = normalizeFinish({ from: 'messages', rawReason: source.stop_reason, hasToolCalls: tools.length > 0 });
  if (!finish.ok) return finish;
  const refusal = source.stop_reason === 'refusal' && texts.length > 0 ? texts.join('') : undefined;
  const mapped = mapFinishToTarget(finish.value, 'chat', refusal === undefined ? {} : { refusalPayload: { refusal } });
  if (!mapped.ok) return mapped;
  if (mapped.value.kind === 'error') return { ok: false, error: mapped.value.error };
  if ((mapped.value.kind !== 'native' && mapped.value.kind !== 'refusal') || mapped.value.to !== 'chat') return failure('invalid_response', 'unrepresentable_messages_finish');
  return { ok: true, value: {
    body: { id: context.identity.responseId, object: 'chat.completion', created: context.createdAt, model: context.targetModel,
      choices: [{ index: 0, message: { role: 'assistant', content: refusal === undefined && texts.length ? texts.join('') : null,
        ...(thinking.length ? { reasoning_content: thinking.join('') } : {}), ...(refusal === undefined ? {} : { refusal }), ...(tools.length ? { tool_calls: tools } : {}) }, finish_reason: mapped.value.finish_reason }],
      ...(usage.value === undefined ? {} : { usage: usage.value }) },
    identity: { responseId: context.identity.responseId, upstreamResponseId: source.id }, terminal: finish.value.terminal,
  } };
}
export function messagesToChatResponse(input: unknown, context: ResponseContext): ConversionResult<Output> {
  try { return convert(input, context); }
  catch { return failure('invalid_response', 'messages_to_chat_conversion_failed'); }
}
export const messagesToChatResponseAdapter: JsonResponseAdapter<unknown, MessagesToChatBody, 'messages', 'chat'> = Object.freeze({
  from: 'messages', to: 'chat', convert: messagesToChatResponse,
});
