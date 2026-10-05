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
    ancestors.add(value);
    const valid = (Array.isArray(value) ? Array.from(value) : Object.values(value)).every(v => visit(v, depth + 1));
    ancestors.delete(value); return valid;
  }
  return visit(input, 0);
}
const optional = (value: Record<string, unknown>, key: string, test: (v: unknown) => boolean) => !Object.hasOwn(value, key) || test(value[key]);
const nullable = (test: (value: unknown) => boolean) => (value: unknown) => value === null || test(value);

/** Validates the JSON response subset locally; usage is presentation, not accounting. */
function responseShape(value: Record<string, unknown>): string | undefined {
  if (!nonempty(value.id)) return 'id';
  if (value.object !== 'response') return 'object';
  if (!nonempty(value.model)) return 'model';
  if (!count(value.created_at)) return 'created_at';
  if (!text(value.status) || !['completed', 'incomplete', 'failed', 'cancelled', 'queued', 'in_progress'].includes(value.status)) return 'status';
  if (!optional(value, 'previous_response_id', v => v === null || nonempty(v))) return 'previous_response_id';
  if (!optional(value, 'error', v => v === null || (object(v) && text(v.code) && text(v.message)))) return 'error';
  if (!optional(value, 'incomplete_details', v => v === null || (object(v) && nonempty(v.reason)))) return 'incomplete_details';
  if (!Array.isArray(value.output)) return 'output';
  for (const [i, item] of value.output.entries()) {
    const path = `output[${i}]`;
    if (!object(item) || !optional(item, 'id', nonempty) || !optional(item, 'status', itemStatus)) return path;
    if (item.type === 'message') {
      if (!nonempty(item.id) || item.role !== 'assistant' || !itemStatus(item.status) || !Array.isArray(item.content)
        || !optional(item, 'phase', nullable(text))) return path;
      for (const [j, part] of item.content.entries()) {
        const p = `${path}.content[${j}]`;
        if (!object(part)) return p;
        if (part.type === 'output_text') {
          if (!text(part.text) || !Array.isArray(part.annotations) || !part.annotations.every(object)
            || !optional(part, 'logprobs', v => Array.isArray(v) && v.every(object))) return p;
        } else if (part.type !== 'refusal' || !text(part.refusal)) return p;
      }
    } else if (item.type === 'function_call') {
      if (!nonempty(item.call_id) || !nonempty(item.name) || !text(item.arguments)) return path;
    } else if (item.type === 'reasoning') {
      if (!nonempty(item.id) || !Array.isArray(item.summary) || !item.summary.every(v => object(v) && v.type === 'summary_text' && text(v.text))
        || !optional(item, 'encrypted_content', v => v === null || text(v))) return path;
    } else if (!nonempty(item.type)) return `${path}.type`;
  }
  if (value.usage !== undefined && value.usage !== null) {
    const usage = value.usage;
    if (!object(usage) || !count(usage.input_tokens) || !count(usage.output_tokens) || !count(usage.total_tokens)) return 'usage';
    if (!optional(usage, 'input_tokens_details', v => object(v) && count(v.cached_tokens)
      && optional(v, 'cache_write_tokens', count))) return 'usage.input_tokens_details';
    if (!optional(usage, 'output_tokens_details', v => object(v) && count(v.reasoning_tokens))) return 'usage.output_tokens_details';
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
export function createResponsesPassthrough(_options: ResponsesPassthroughOptions = {}) {
  const request: RequestAdapter<unknown, ResponsesRequest, 'responses', 'responses'> = {
    from: 'responses', to: 'responses',
    convert(input, context) {
      if (!nonempty(context.targetModel)) return fail('invalid_request', 'model');
      if (!object(input) || !jsonBoundary(input)) return fail('invalid_request', '$');
      const parsed = parseResponsesRequest(input, { unknownFields: 'preserve', native: true });
      if (!parsed.ok) return parsed;
      if (parsed.value.background === true) return fail('unsupported_feature', 'background');
      return { ok: true, value: { ...structuredClone(parsed.value), model: context.targetModel } };
    },
  };
  const response: JsonResponseAdapter<unknown, ResponsesResponse, 'responses', 'responses'> = {
    from: 'responses', to: 'responses',
    convert(input, context) {
      if (!nonempty(context.targetModel) || !nonempty(context.identity.responseId)) return fail('invalid_response', 'context');
      if (!object(input) || !jsonBoundary(input)) return fail('invalid_response', '$');
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
