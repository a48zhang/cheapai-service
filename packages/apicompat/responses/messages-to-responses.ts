/**
 * SPDX-License-Identifier: LGPL-3.0-only
 * Behavioral adaptation of Wei-Shaw/sub2api, commit
 * ab99d56e9626e6cd731592dae8553c9758a0efa2,
 * backend/internal/pkg/apicompat/anthropic_to_responses_response.go,
 * AnthropicToResponsesResponse.
 * Full texts: LICENSES/LGPL-3.0.txt and LICENSES/GPL-3.0.txt.
 *
 * P-MR-J1: direct Messages -> Responses mapping with caller-owned stable
 * identity/model/time. Native content is inspected directly and never routed
 * through Chat or another intermediate wire representation.
 * P-MR-J2: ordered tool_use blocks become Responses function_call items with
 * preserved call IDs, complete JSON arguments and separate contiguous text
 * items; unrepresentable cache/extensions fail closed.
 * P-MR-J3: Messages stop reasons map through P11 to Responses completed or
 * incomplete terminals; mismatched tool claims and nonterminal states fail.
 * P-MR-J3-E: standalone Messages error events use a sanitized Responses error
 * envelope and failed terminal; provider diagnostics never cross the boundary.
 * P-MR-J3-T: public Messages thinking blocks become Responses reasoning
 * summaries only with an empty signature; redacted/signed payloads remain
 * protected and refusal text is mapped to native refusal content.
 * P-MR-J4: original Messages usage is projected to Responses' inclusive input
 * counters once; cache TTL sub-buckets remain subsets, and incomplete evidence
 * is omitted instead of zero-filled.
 */
import { parseMessagesResponse, parseMessagesStreamEvent } from '../types/messages.js';
import type { MessagesError, MessagesResponse, MessagesOutputBlock } from '../types/messages.js';
import { isRepresentableWireId } from '../ids.js';
import { normalizeFinish, mapFinishToTarget } from '../finish-reasons.js';
import { encodeResponsesError } from '../errors.js';
import { extractMessagesUsage } from '../usage/messages.js';
import type { JsonResponseAdapter, JsonResponseOutput, ResponseContext } from '../types/adapter.js';
import type { ResponsesResponse, ResponsesOutputItem, ResponsesUsage } from '../types/responses.js';
import type { ResponsesErrorBody } from '../errors.js';
import type { ConversionResult, JsonObject, ProtocolError } from '../types/shared.js';

export type MessagesToResponsesBody = ResponsesResponse | ResponsesErrorBody;
type Output = JsonResponseOutput<MessagesToResponsesBody>;

class Fault extends Error {
  constructor(readonly error: ProtocolError) { super(error.code); }
}
function invalid(param: string, code = 'invalid_messages_response'): never {
  throw new Fault({ kind: 'invalid_response', code, message: 'The Messages response cannot be represented as a Responses response.', param });
}
function unsupported(param: string): never {
  throw new Fault({ kind: 'unsupported_feature', code: 'unsupported_messages_to_responses_response', message: 'This Messages response feature cannot be represented as Responses.', param });
}
const extraKey = (value: object, allowed: readonly string[]) => Object.keys(value).find(key => !allowed.includes(key));

function validContext(context: ResponseContext, upstreamId?: string): boolean {
  return !!context && isRepresentableWireId(context.identity?.responseId)
    && (upstreamId === undefined || isRepresentableWireId(upstreamId))
    && typeof context.targetModel === 'string' && context.targetModel.trim().length > 0
    && typeof context.idFor === 'function' && Number.isSafeInteger(context.createdAt) && context.createdAt >= 0
    && (context.identity.upstreamResponseId === undefined || (isRepresentableWireId(context.identity.upstreamResponseId)
      && (upstreamId === undefined || context.identity.upstreamResponseId === upstreamId)));
}

function metadata(source: MessagesResponse): void {
  const top = extraKey(source, ['id', 'type', 'role', 'model', 'content', 'stop_reason', 'stop_sequence', 'usage', 'container', 'stop_details']);
  if (top) unsupported(`$.${top}`);
  if (source.container !== undefined && source.container !== null) {
    const key = extraKey(source.container, ['id', 'expires_at', 'skills']);
    if (key) unsupported(`$.container.${key}`);
    for (const [index, skill] of (source.container.skills ?? []).entries()) {
      const skillKey = extraKey(skill, ['skill_id', 'type', 'version']);
      if (skillKey) unsupported(`$.container.skills[${index}].${skillKey}`);
    }
  }
  if (source.stop_details !== undefined && source.stop_details !== null) {
    const key = extraKey(source.stop_details, ['type', 'category', 'explanation', 'recommended_model']);
    if (key) unsupported(`$.stop_details.${key}`);
    if (source.stop_reason !== 'refusal') invalid('$.stop_details');
  }
}

function serializeArguments(input: JsonObject): string | undefined {
  const pending: { value: unknown; depth: number }[] = [{ value: input, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 100_000 || item.depth > 64) return undefined;
    const value = item.value;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) return undefined;
      continue;
    }
    if (typeof value !== 'object' || seen.has(value)) return undefined;
    seen.add(value);
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return undefined;
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) return undefined;
      pending.push({ value: descriptor.value, depth: item.depth + 1 });
    }
  }
  try {
    const result = JSON.stringify(input);
    return result !== undefined && result.length <= 1_048_576 ? result : undefined;
  } catch { return undefined; }
}

function itemId(context: ResponseContext, key: string, used: Set<string>): string | undefined {
  let id: string;
  try { id = context.idFor('item', key); } catch { return undefined; }
  if (!isRepresentableWireId(id) || used.has(id)) return undefined;
  used.add(id);
  return id;
}

function nativeError(input: unknown, context: ResponseContext): ConversionResult<Output> | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(input, 'type');
  if (!descriptor || !('value' in descriptor) || descriptor.value !== 'error') return undefined;
  const parsed = parseMessagesStreamEvent(input, { unknownFields: 'preserve' });
  if (!parsed.ok) return parsed as ConversionResult<Output>;
  const extra = extraKey(parsed.value, ['type', 'error', 'request_id']);
  if (extra) return unsupported(`$.${extra}`);
  if (!validContext(context)) return { ok: false, error: { kind: 'invalid_response', code: 'invalid_response_context', message: 'Invalid response context.' } };
  const safe: ProtocolError = { kind: 'upstream_error', code: 'upstream_error', message: 'The upstream Messages request failed.' };
  const finish = normalizeFinish({ from: 'messages', rawReason: null, event: 'failed', error: safe });
  if (!finish.ok) return finish;
  return { ok: true, value: { body: encodeResponsesError(safe), identity: { ...context.identity }, terminal: finish.value.terminal } };
}

function displayUsage(source: MessagesResponse): ConversionResult<ResponsesUsage | undefined> {
  const raw = source.usage;
  if (raw === undefined) return { ok: true, value: undefined };
  const topExtra = extraKey(raw, ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'cache_creation', 'output_tokens_details', 'service_tier', 'inference_geo', 'server_tool_use']);
  if (topExtra) return unsupported(`$.usage.${topExtra}`);
  for (const key of ['input_tokens', 'output_tokens'] as const) {
    if (typeof raw[key] !== 'number' || !Number.isSafeInteger(raw[key]) || raw[key] < 0) invalid(`$.usage.${key}`);
  }
  for (const key of ['cache_creation_input_tokens', 'cache_read_input_tokens'] as const) {
    const value = raw[key];
    if (value !== undefined && value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) invalid(`$.usage.${key}`);
  }
  if (raw.service_tier !== undefined && raw.service_tier !== null && !['standard', 'priority', 'batch'].includes(raw.service_tier)) invalid('$.usage.service_tier');
  if (raw.inference_geo !== undefined && raw.inference_geo !== null && (typeof raw.inference_geo !== 'string' || raw.inference_geo.length > 64)) invalid('$.usage.inference_geo');
  if (raw.cache_creation !== undefined && raw.cache_creation !== null) {
    const details = raw.cache_creation;
    const key = extraKey(details, ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']);
    if (key) return unsupported(`$.usage.cache_creation.${key}`);
    for (const name of ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens'] as const) {
      if (typeof details[name] !== 'number' || !Number.isSafeInteger(details[name]) || details[name] < 0) invalid(`$.usage.cache_creation.${name}`);
    }
  }
  if (raw.output_tokens_details !== undefined && raw.output_tokens_details !== null) {
    const details = raw.output_tokens_details;
    const key = extraKey(details, ['thinking_tokens']);
    if (key) return unsupported(`$.usage.output_tokens_details.${key}`);
    if (typeof details.thinking_tokens !== 'number' || !Number.isSafeInteger(details.thinking_tokens) || details.thinking_tokens < 0) invalid('$.usage.output_tokens_details.thinking_tokens');
  }
  if (raw.server_tool_use !== undefined && raw.server_tool_use !== null) {
    const details = raw.server_tool_use;
    const key = extraKey(details, ['web_fetch_requests', 'web_search_requests']);
    if (key) return unsupported(`$.usage.server_tool_use.${key}`);
    for (const name of ['web_fetch_requests', 'web_search_requests'] as const) {
      if (typeof details[name] !== 'number' || !Number.isSafeInteger(details[name]) || details[name] < 0) invalid(`$.usage.server_tool_use.${name}`);
    }
  }
  const observed = extractMessagesUsage(source);
  if (!('semantics' in observed) || observed.quality === 'invalid' || observed.semantics.cacheRead !== 'excluded_from_input'
    || observed.semantics.cacheWrite !== 'excluded_from_input' || observed.semantics.reasoning !== 'included_in_output') return { ok: true, value: undefined };
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens } = observed.counts;
  if (inputTokens === undefined || outputTokens === undefined) return { ok: true, value: undefined };
  // Add only cache buckets that are present. If a sibling bucket is absent,
  // the aggregate remains a residual display projection; do not synthesize a
  // target detail field with zero or claim a complete cache measurement.
  const input = inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
  const total = input + outputTokens;
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(total)) return { ok: true, value: undefined };
  return { ok: true, value: {
    input_tokens: input, output_tokens: outputTokens, total_tokens: total,
    ...(cacheReadTokens === undefined ? {} : { input_tokens_details: { cached_tokens: cacheReadTokens,
      ...(cacheWriteTokens === undefined ? {} : { cache_write_tokens: cacheWriteTokens }) } }),
    ...(reasoningTokens === undefined ? {} : { output_tokens_details: { reasoning_tokens: reasoningTokens } }),
  } };
}

function convert(input: unknown, context: ResponseContext): ConversionResult<Output> {
  const failed = nativeError(input, context);
  if (failed !== undefined) return failed;
  const parsed = parseMessagesResponse(input, { unknownFields: 'preserve' });
  if (!parsed.ok) return parsed as ConversionResult<Output>;
  const source = parsed.value;
  if (!validContext(context, source.id)) return { ok: false, error: { kind: 'invalid_response', code: 'invalid_response_context', message: 'Invalid response context.' } };
  metadata(source);
  const usage = displayUsage(source);
  if (!usage.ok) return usage;
  if (source.stop_sequence !== null && source.stop_reason !== 'stop_sequence') invalid('$.stop_sequence', 'inconsistent_stop_sequence');

  const output: ResponsesOutputItem[] = [];
  const usedItemIds = new Set<string>([context.identity.responseId, source.id]);
  const usedCallIds = new Set<string>([context.identity.responseId]);
  let outputContent: { type: 'output_text'; text: string; annotations: readonly [] }[] = [];
  const flushText = (): boolean => {
    if (outputContent.length === 0) return true;
    const id = itemId(context, `messages:content:${output.length}:message`, usedItemIds);
    if (id === undefined) return false;
    output.push({ type: 'message', id, role: 'assistant', status: 'completed', content: outputContent });
    outputContent = [];
    return true;
  };
  let sawVisible = false;
  let sawTool = false;
  let sawTextBlock = false;
  let visibleText = '';
  for (const [index, block] of source.content.entries()) {
    const path = `$.content[${index}]`;
    if (block.type === 'tool_use') {
      if (!flushText()) return { ok: false, error: { kind: 'invalid_response', code: 'invalid_response_item_id', message: 'Response identifier allocation failed.' } };
      const key = extraKey(block, ['type', 'id', 'name', 'input', 'cache_control']);
      if (key) unsupported(`${path}.${key}`);
      if (block.cache_control !== undefined && block.cache_control !== null) unsupported(`${path}.cache_control`);
      if (!isRepresentableWireId(block.id) || usedCallIds.has(block.id)) invalid(`${path}.id`);
      if (block.name.length < 1 || block.name.length > 64 || /[^A-Za-z0-9_-]/u.test(block.name)) invalid(`${path}.name`);
      const args = serializeArguments(block.input);
      if (args === undefined) invalid(`${path}.input`, 'invalid_tool_arguments');
      const id = itemId(context, `messages:content:${index}:tool`, usedItemIds);
      if (id === undefined) return { ok: false, error: { kind: 'invalid_response', code: 'invalid_response_item_id', message: 'Response identifier allocation failed.' } };
      usedCallIds.add(block.id);
      output.push({ type: 'function_call', id, call_id: block.id, name: block.name, arguments: args, status: 'completed' });
      sawTool = true;
      continue;
    }
    if (block.type === 'thinking') {
      if (block.signature !== '') unsupported(`${path}.signature`);
      if (block.thinking.length > 0 && (sawVisible || sawTool)) unsupported(`${path}.thinking`);
      if (!flushText()) return { ok: false, error: { kind: 'invalid_response', code: 'invalid_response_item_id', message: 'Response identifier allocation failed.' } };
      const id = itemId(context, `messages:content:${index}:reasoning`, usedItemIds);
      if (id === undefined) return { ok: false, error: { kind: 'invalid_response', code: 'invalid_response_item_id', message: 'Response identifier allocation failed.' } };
      output.push({ type: 'reasoning', id, summary: [{ type: 'summary_text', text: block.thinking }], status: 'completed' });
      continue;
    }
    if (block.type === 'redacted_thinking') unsupported(`${path}.data`);
    if (block.type !== 'text') unsupported(`${path}.type`);
    const key = extraKey(block, ['type', 'text', 'citations', 'cache_control']);
    if (key) unsupported(`${path}.${key}`);
    if (block.citations !== undefined && block.citations !== null && block.citations.length > 0) unsupported(`${path}.citations`);
    if (block.cache_control !== undefined && block.cache_control !== null) unsupported(`${path}.cache_control`);
    outputContent.push({ type: 'output_text', text: block.text, annotations: [] });
    sawTextBlock = true;
    visibleText += block.text;
    if (block.text.length > 0) sawVisible = true;
  }
  if (!flushText()) return { ok: false, error: { kind: 'invalid_response', code: 'invalid_response_item_id', message: 'Response identifier allocation failed.' } };
  if (source.stop_reason === 'tool_use' && !output.some(item => item.type === 'function_call')) return { ok: false, error: { kind: 'invalid_response', code: 'missing_tool_use', message: 'The Messages response claims a tool use without a tool block.', param: '$.stop_reason' } };
  if (output.some(item => item.type === 'function_call') && ['end_turn', 'stop_sequence', 'refusal'].includes(source.stop_reason ?? '')) unsupported('$.stop_reason');
  const refusalText = visibleText;
  if (source.stop_reason === 'refusal' && !sawTextBlock) return { ok: false, error: { kind: 'unsupported_feature', code: 'refusal_payload_required', message: 'A refusal payload is required.' } };
  const finish = normalizeFinish({ from: 'messages', rawReason: source.stop_reason });
  if (!finish.ok) return finish;
  const mapped = mapFinishToTarget(finish.value, 'responses', source.stop_reason === 'refusal' ? { refusalPayload: { refusal: refusalText } } : {});
  if (!mapped.ok) return mapped;
  if (mapped.value.kind === 'error') return { ok: false, error: mapped.value.error };
  if ((mapped.value.kind !== 'native' && mapped.value.kind !== 'refusal') || mapped.value.to !== 'responses') return invalid('$.stop_reason', 'unrepresentable_messages_finish');
  const outputStatus = mapped.value.status === 'completed' ? 'completed' as const : 'incomplete' as const;
  const incompleteDetails = mapped.value.kind === 'native' ? mapped.value.incomplete_details : null;
  const completedOutput = output.map(item => {
    const withStatus = { ...item, status: outputStatus };
    if (source.stop_reason === 'refusal' && withStatus.type === 'message') {
      return { ...withStatus, content: withStatus.content.map(part => part.type === 'output_text' ? { type: 'refusal' as const, refusal: part.text } : part) };
    }
    return withStatus;
  });
  return { ok: true, value: {
    body: { id: context.identity.responseId, object: 'response', created_at: context.createdAt, model: context.targetModel,
      status: mapped.value.status, output: completedOutput, incomplete_details: incompleteDetails,
      ...(usage.value === undefined ? {} : { usage: usage.value }) },
    identity: { responseId: context.identity.responseId, upstreamResponseId: source.id }, terminal: finish.value.terminal,
  } };
}

export function messagesToResponsesResponse(input: unknown, context: ResponseContext): ConversionResult<Output> {
  try { return convert(input, context); }
  catch (error) {
    return { ok: false, error: error instanceof Fault ? error.error : { kind: 'invalid_response', code: 'messages_to_responses_conversion_failed', message: 'The Messages response could not be converted.' } };
  }
}

export const messagesToResponsesResponseAdapter: JsonResponseAdapter<unknown, MessagesToResponsesBody, 'messages', 'responses'> = Object.freeze({
  from: 'messages', to: 'responses', convert: messagesToResponsesResponse,
});
