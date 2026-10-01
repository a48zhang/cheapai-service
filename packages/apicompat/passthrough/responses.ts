import { responsesErrorAdapter, encodeResponsesError } from '../errors.js';
import { normalizeFinish } from '../finish-reasons.js';
import type { JsonResponseAdapter, RequestAdapter } from '../types/adapter.js';
import { parseResponsesRequest } from '../types/responses.js';
import type { ResponsesRequest, ResponsesResponse } from '../types/responses.js';
import type { ConversionResult, ProtocolError } from '../types/shared.js';

export interface ResponsesPassthroughOptions {
  readonly requestAllowedExtensions?: readonly string[];
  readonly responseAllowedExtensions?: readonly string[];
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string';
const nonempty = (v: unknown): v is string => text(v) && v.trim().length > 0;
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const itemStatus = (v: unknown) => v === 'completed' || v === 'incomplete' || v === 'in_progress';
const forbidden = (key: string) => /^(?:auth|authorization|proxyauthorization|headers|requestheaders|responseheaders|apikey|xapikey|token|apitoken|accesstoken|refreshtoken|bearertoken|sessiontoken|credential|credentials|cookie|cookies|setcookie|password|secret|secrets|secretkey|privatekey|signingkey|clientsecret)$/u.test(key.toLowerCase().replace(/[^a-z0-9]/gu, ''));
const requestKeys = new Set(['model', 'input', 'instructions', 'previous_response_id', 'stream', 'store', 'background', 'max_output_tokens', 'temperature', 'top_p', 'tools', 'tool_choice', 'parallel_tool_calls', 'metadata', 'reasoning', 'text']);
const responseKeys = new Set(['id', 'object', 'created_at', 'model', 'status', 'output', 'usage', 'error', 'incomplete_details', 'previous_response_id',
  'completed_at', 'background', 'instructions', 'max_output_tokens', 'max_tool_calls', 'parallel_tool_calls', 'reasoning', 'service_tier',
  'store', 'temperature', 'text', 'tool_choice', 'tools', 'top_logprobs', 'top_p', 'truncation', 'user', 'metadata',
  'conversation', 'prompt_cache_key', 'prompt_cache_retention', 'prompt_cache_options', 'safety_identifier']);
function fail<T>(kind: ProtocolError['kind'], param: string): ConversionResult<T> {
  return { ok: false, error: { kind, code: 'invalid_responses_passthrough', message: 'The Responses payload cannot be safely passed through.', param } };
}
function jsonBoundary(input: unknown): boolean {
  let remaining = 100_000;
  const ancestors = new Set<object>();
  function visit(value: unknown, depth: number): boolean {
    if (--remaining < 0 || depth > 64) return false;
    if (value === null || text(value) || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object' || ancestors.has(value)) return false;
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    ancestors.add(value);
    const valid = (Array.isArray(value) ? Array.from(value) : Object.values(value)).every(v => visit(v, depth + 1));
    ancestors.delete(value); return valid;
  }
  return visit(input, 0);
}
function extras(value: Record<string, unknown>, known: ReadonlySet<string>, allowed: readonly string[]): string | undefined {
  for (const name of allowed) if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) || forbidden(name)) return 'extensions';
  for (const [name, root] of Object.entries(value)) {
    if (known.has(name)) continue;
    if (!allowed.includes(name)) return name;
    const pending = [root];
    while (pending.length) {
      const next = pending.pop();
      if (Array.isArray(next)) for (const child of next) pending.push(child);
      else if (object(next)) for (const [key, child] of Object.entries(next)) { if (forbidden(key)) return name; pending.push(child); }
    }
  }
  return undefined;
}
const keys = (value: Record<string, unknown>, names: readonly string[]) => Object.keys(value).every(k => names.includes(k));
const optional = (value: Record<string, unknown>, key: string, test: (v: unknown) => boolean) => !Object.hasOwn(value, key) || test(value[key]);
const nullable = (test: (value: unknown) => boolean) => (value: unknown) => value === null || test(value);
const oneOf = (...values: readonly string[]) => (value: unknown) => text(value) && values.includes(value);

/** Standard response echoes verified against the official Response schema and
 * create-response examples on 2026-09-06. This does not enable corresponding
 * background/built-in-tool requests; ingress and output item policies still apply.
 * https://developers.openai.com/api/reference/typescript/resources/responses/methods/create
 */
function responseEchoes(value: Record<string, unknown>): string | undefined {
  for (const name of ['completed_at', 'max_output_tokens', 'max_tool_calls']) if (!optional(value, name, nullable(count))) return name;
  for (const name of ['background', 'store']) if (!optional(value, name, nullable(v => typeof v === 'boolean'))) return name;
  if (!optional(value, 'parallel_tool_calls', v => typeof v === 'boolean')) return 'parallel_tool_calls';
  if (!optional(value, 'temperature', nullable(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 2))) return 'temperature';
  if (!optional(value, 'top_p', nullable(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1))) return 'top_p';
  if (!optional(value, 'top_logprobs', nullable(v => count(v) && v <= 20))) return 'top_logprobs';
  if (!optional(value, 'service_tier', nullable(oneOf('auto', 'default', 'flex', 'scale', 'priority', 'fast', 'ultrafast')))) return 'service_tier';
  if (!optional(value, 'truncation', nullable(oneOf('auto', 'disabled')))) return 'truncation';
  for (const name of ['user', 'prompt_cache_key']) if (!optional(value, name, nullable(text))) return name;
  if (!optional(value, 'safety_identifier', nullable(v => text(v) && v.length <= 64))) return 'safety_identifier';
  if (!optional(value, 'prompt_cache_retention', nullable(oneOf('in_memory', '24h')))) return 'prompt_cache_retention';
  if (!optional(value, 'conversation', nullable(v => object(v) && nonempty(v.id) && keys(v, ['id'])))) return 'conversation';
  if (!optional(value, 'prompt_cache_options', v => object(v) && keys(v, ['mode', 'ttl', 'comparison_response_id'])
    && oneOf('implicit', 'explicit')(v.mode) && v.ttl === '30m' && optional(v, 'comparison_response_id', nonempty))) return 'prompt_cache_options';
  if (!optional(value, 'metadata', nullable(v => object(v) && Object.keys(v).length <= 16
    && Object.entries(v).every(([key, data]) => key.length <= 64 && text(data) && data.length <= 512)))) return 'metadata';
  if (!optional(value, 'instructions', nullable(v => text(v) || (Array.isArray(v)
    && parseResponsesRequest({ model: 'echo-validation', input: v }).ok)))) return 'instructions';
  if (!optional(value, 'tools', v => Array.isArray(v) && parseResponsesRequest({ model: 'echo-validation', input: '', tools: v }).ok)) return 'tools';
  if (!optional(value, 'tool_choice', v => parseResponsesRequest({ model: 'echo-validation', input: '', tool_choice: v }).ok)) return 'tool_choice';
  if (!optional(value, 'reasoning', nullable(v => object(v) && keys(v, ['effort', 'summary', 'generate_summary', 'context', 'mode'])
    && optional(v, 'effort', nullable(oneOf('none', 'minimal', 'low', 'medium', 'high', 'xhigh')))
    && optional(v, 'summary', nullable(oneOf('auto', 'concise', 'detailed')))
    && optional(v, 'generate_summary', nullable(oneOf('auto', 'concise', 'detailed')))
    && optional(v, 'context', oneOf('auto')) && optional(v, 'mode', oneOf('standard'))))) return 'reasoning';
  if (!optional(value, 'text', v => object(v) && keys(v, ['format', 'verbosity'])
    && optional(v, 'verbosity', nullable(oneOf('low', 'medium', 'high')))
    && optional(v, 'format', format => {
      if (!object(format)) return false;
      if (format.type === 'text' || format.type === 'json_object') return keys(format, ['type']);
      return format.type === 'json_schema' && keys(format, ['type', 'name', 'schema', 'description', 'strict'])
        && text(format.name) && format.name.length <= 64 && /^[A-Za-z0-9_-]+$/.test(format.name)
        && object(format.schema) && optional(format, 'description', text) && optional(format, 'strict', nullable(v => typeof v === 'boolean'));
    }))) return 'text';
  return undefined;
}

/** Validates the JSON response subset locally; usage is presentation, not accounting. */
function responseShape(value: Record<string, unknown>): string | undefined {
  const echo = responseEchoes(value); if (echo) return echo;
  if (!nonempty(value.id)) return 'id';
  if (value.object !== 'response') return 'object';
  if (!nonempty(value.model)) return 'model';
  if (!count(value.created_at)) return 'created_at';
  if (!text(value.status) || !['completed', 'incomplete', 'failed', 'cancelled', 'queued', 'in_progress'].includes(value.status)) return 'status';
  if (!optional(value, 'previous_response_id', v => v === null || nonempty(v))) return 'previous_response_id';
  if (!optional(value, 'error', v => v === null || (object(v) && text(v.code) && text(v.message) && keys(v, ['code', 'message'])))) return 'error';
  if (!optional(value, 'incomplete_details', v => v === null || (object(v) && nonempty(v.reason) && keys(v, ['reason'])))) return 'incomplete_details';
  if (!Array.isArray(value.output)) return 'output';
  for (const [i, item] of value.output.entries()) {
    const path = `output[${i}]`;
    if (!object(item) || !optional(item, 'id', nonempty) || !optional(item, 'status', itemStatus)) return path;
    if (item.type === 'message') {
      if (!nonempty(item.id) || item.role !== 'assistant' || !itemStatus(item.status) || !Array.isArray(item.content)
        || !optional(item, 'phase', nullable(oneOf('commentary', 'final_answer'))) || !keys(item, ['type', 'id', 'role', 'status', 'content', 'phase'])) return path;
      for (const [j, part] of item.content.entries()) {
        const p = `${path}.content[${j}]`;
        if (!object(part)) return p;
        if (part.type === 'output_text') {
          if (!text(part.text) || !Array.isArray(part.annotations) || !part.annotations.every(object)
            || !optional(part, 'logprobs', v => Array.isArray(v) && v.every(object)) || !keys(part, ['type', 'text', 'annotations', 'logprobs'])) return p;
        } else if (part.type !== 'refusal' || !text(part.refusal) || !keys(part, ['type', 'refusal'])) return p;
      }
    } else if (item.type === 'function_call') {
      if (!nonempty(item.call_id) || !nonempty(item.name) || !text(item.arguments) || !keys(item, ['type', 'id', 'call_id', 'name', 'arguments', 'status'])) return path;
    } else if (item.type === 'reasoning') {
      if (!nonempty(item.id) || !Array.isArray(item.summary) || !item.summary.every(v => object(v) && v.type === 'summary_text' && text(v.text) && keys(v, ['type', 'text']))
        || !optional(item, 'encrypted_content', v => v === null || text(v)) || !keys(item, ['type', 'id', 'summary', 'encrypted_content', 'status'])) return path;
    } else return `${path}.type`;
  }
  if (value.usage !== undefined && value.usage !== null) {
    const usage = value.usage;
    if (!object(usage) || !count(usage.input_tokens) || !count(usage.output_tokens) || !count(usage.total_tokens)
      || !keys(usage, ['input_tokens', 'output_tokens', 'total_tokens', 'input_tokens_details', 'output_tokens_details'])) return 'usage';
    if (!optional(usage, 'input_tokens_details', v => object(v) && count(v.cached_tokens)
      && optional(v, 'cache_write_tokens', count) && keys(v, ['cached_tokens', 'cache_write_tokens']))) return 'usage.input_tokens_details';
    if (!optional(usage, 'output_tokens_details', v => object(v) && count(v.reasoning_tokens) && keys(v, ['reasoning_tokens']))) return 'usage.output_tokens_details';
  }
  return undefined;
}

/**
 * Native body passthrough only. BEFORE sending a request containing
 * previous_response_id or item_reference, G13 must verify user/Key ownership
 * and bind it to the original channel/model. This adapter neither resolves nor
 * authorizes history. The request adapter preserves stream for P19; no SSE,
 * background jobs, authentication, storage or usage extraction is implemented.
 */
export function createResponsesPassthrough(options: ResponsesPassthroughOptions = {}) {
  const requestAllowed = Object.freeze([...(options.requestAllowedExtensions ?? [])]);
  const responseAllowed = Object.freeze([...(options.responseAllowedExtensions ?? [])]);
  const request: RequestAdapter<unknown, ResponsesRequest, 'responses', 'responses'> = {
    from: 'responses', to: 'responses',
    convert(input, context) {
      if (!nonempty(context.targetModel)) return fail('invalid_request', 'model');
      if (!object(input) || !jsonBoundary(input)) return fail('invalid_request', '$');
      const parsed = parseResponsesRequest(input, { unknownFields: 'preserve' });
      if (!parsed.ok) return parsed;
      const extra = extras(input, requestKeys, requestAllowed); if (extra) return fail('unsupported_feature', extra);
      const known = Object.fromEntries(Object.entries(input).filter(([key]) => requestKeys.has(key)));
      const strict = parseResponsesRequest(known); if (!strict.ok) return strict;
      if (parsed.value.background === true) return fail('unsupported_feature', 'background');
      return { ok: true, value: { ...structuredClone(parsed.value), model: context.targetModel } };
    },
  };
  const response: JsonResponseAdapter<unknown, ResponsesResponse, 'responses', 'responses'> = {
    from: 'responses', to: 'responses',
    convert(input, context) {
      if (!nonempty(context.targetModel) || !nonempty(context.identity.responseId)) return fail('invalid_response', 'context');
      if (!object(input) || !jsonBoundary(input)) return fail('invalid_response', '$');
      const extra = extras(input, responseKeys, responseAllowed); if (extra) return fail('unsupported_feature', extra);
      const bad = responseShape(input); if (bad) return fail('invalid_response', bad);
      // All declared response fields and discriminated output members were checked.
      const parsed = input as unknown as ResponsesResponse;
      if (context.identity.upstreamResponseId !== undefined && context.identity.upstreamResponseId !== parsed.id) return fail('invalid_response', 'id');
      const upstreamError: ProtocolError = { kind: 'upstream_error', code: 'upstream_error', message: 'The upstream response failed.' };
      const finish = normalizeFinish({ from: 'responses', rawReason: parsed.status, incompleteReason: parsed.incomplete_details?.reason ?? null,
        hasToolCalls: parsed.output.some(item => item.type === 'function_call'),
        hasRefusal: parsed.output.some(item => item.type === 'message' && item.content.some(part => part.type === 'refusal')),
        ...(parsed.status === 'failed' ? { error: upstreamError } : {}) });
      if (!finish.ok) return finish;
      const body = { ...structuredClone(parsed), id: context.identity.responseId, model: context.targetModel };
      if (body.error !== undefined && body.error !== null) {
        const safe = encodeResponsesError(upstreamError).error; body.error = { code: safe.code, message: safe.message };
      }
      return { ok: true, value: { body, identity: { responseId: context.identity.responseId, upstreamResponseId: parsed.id }, terminal: finish.value.terminal } };
    },
  };
  return Object.freeze({ request: Object.freeze(request), response: Object.freeze(response), error: responsesErrorAdapter });
}
const defaults = createResponsesPassthrough();
export const responsesRequestAdapter = defaults.request;
export const responsesResponseAdapter = defaults.response;
