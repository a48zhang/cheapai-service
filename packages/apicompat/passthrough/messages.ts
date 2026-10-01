import { messagesErrorAdapter } from '../errors.js';
import { normalizeFinish } from '../finish-reasons.js';
import type { JsonResponseAdapter, RequestAdapter } from '../types/adapter.js';
import { parseMessagesRequest, parseMessagesResponse } from '../types/messages.js';
import type { MessagesRequest, MessagesResponse } from '../types/messages.js';
import type { ConversionResult, ProtocolError } from '../types/shared.js';

export interface MessagesPassthroughOptions {
  /** Exact top-level extensions only; never permits unknown blocks/nested fields. */
  readonly requestAllowedExtensions?: readonly string[];
  readonly responseAllowedExtensions?: readonly string[];
}

const requestKeys = new Set(['model', 'max_tokens', 'messages', 'system', 'stream', 'tools', 'tool_choice',
  'thinking', 'output_config', 'cache_control', 'temperature', 'top_p', 'top_k', 'stop_sequences', 'metadata']);
// P04 validates these standard response-only metadata fields. They do not enable
// container/server-tool requests or make server-tool usage token-priceable.
const responseKeys = new Set(['id', 'type', 'role', 'model', 'content', 'stop_reason', 'stop_sequence', 'usage', 'container', 'stop_details']);
const forbidden = (key: string): boolean => /^(?:auth|authorization|proxyauthorization|headers|requestheaders|responseheaders|apikey|xapikey|token|apitoken|accesstoken|refreshtoken|bearertoken|sessiontoken|credential|credentials|cookie|cookies|setcookie|password|secret|secrets|secretkey|privatekey|signingkey|clientsecret)$/u.test(key.toLowerCase().replace(/[^a-z0-9]/gu, ''));
const safeModel = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
const safeId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u0020\u007f]/u.test(value);

function fail<T>(kind: ProtocolError['kind'], code: string, param: string): ConversionResult<T> {
  return { ok: false, error: { kind, code, message: 'The Messages payload cannot be safely passed through.', param } };
}

/** Called only after P04's bounded plain-JSON validation (no getters or cycles). */
function allowedExtensions(value: Record<string, unknown>, known: ReadonlySet<string>, allowed: readonly string[]): boolean {
  for (const name of allowed) {
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) || forbidden(name)) return false;
  }
  for (const [name, root] of Object.entries(value)) {
    if (known.has(name)) continue;
    if (!allowed.includes(name)) return false;
    const pending: unknown[] = [root];
    while (pending.length > 0) {
      const next = pending.pop();
      if (Array.isArray(next)) for (const item of next) pending.push(item);
      else if (next !== null && typeof next === 'object') {
        for (const [key, child] of Object.entries(next)) {
          if (forbidden(key)) return false;
          pending.push(child);
        }
      }
    }
  }
  return true;
}

function knownFields(value: Record<string, unknown>, known: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => known.has(key)));
}

/**
 * Messages → Messages JSON body adapters. P04 owns supported wire shapes; P11
 * owns terminal semantics. Preserve opaque native signatures/redacted thinking,
 * cache controls, tool IDs and usage verbatim, without claiming authenticity,
 * capability checking, usage extraction or billing. P14 remains independent.
 * No headers, credentials, fetch or SSE are accepted as adapter dependencies.
 */
export function createMessagesPassthrough(options: MessagesPassthroughOptions = {}) {
  const requestAllowlist = Object.freeze([...(options.requestAllowedExtensions ?? [])]);
  const responseAllowlist = Object.freeze([...(options.responseAllowedExtensions ?? [])]);

  const request: RequestAdapter<unknown, MessagesRequest, 'messages', 'messages'> = {
    from: 'messages', to: 'messages',
    convert(input, context) {
      if (!safeModel(context.targetModel)) return fail('invalid_request', 'invalid_target_model', 'model');
      const preserved = parseMessagesRequest(input, { unknownFields: 'preserve' });
      if (!preserved.ok) return preserved;
      if (!allowedExtensions(preserved.value, requestKeys, requestAllowlist)) return fail('unsupported_feature', 'unsupported_messages_extension', 'extensions');
      // P04 has no top-level allowlist option. Validate the known projection in
      // strict mode; extension permission must not bypass known/nested checks.
      const strict = parseMessagesRequest(knownFields(preserved.value, requestKeys));
      if (!strict.ok) return strict;
      return { ok: true, value: { ...structuredClone(preserved.value), model: context.targetModel } };
    },
  };

  const response: JsonResponseAdapter<unknown, MessagesResponse, 'messages', 'messages'> = {
    from: 'messages', to: 'messages',
    convert(input, context) {
      if (!safeModel(context.targetModel)) return fail('invalid_response', 'invalid_target_model', 'model');
      if (!safeId(context.identity.responseId)) return fail('invalid_response', 'invalid_response_identity', 'id');
      const preserved = parseMessagesResponse(input, { unknownFields: 'preserve' });
      if (!preserved.ok) return preserved;
      if (!allowedExtensions(preserved.value, responseKeys, responseAllowlist)) return fail('unsupported_feature', 'unsupported_messages_extension', 'extensions');
      const strict = parseMessagesResponse(knownFields(preserved.value, responseKeys));
      if (!strict.ok) return strict;
      if (!safeId(preserved.value.id)) return fail('invalid_response', 'invalid_upstream_identity', 'id');
      if (context.identity.upstreamResponseId !== undefined && context.identity.upstreamResponseId !== preserved.value.id) {
        return fail('invalid_response', 'upstream_identity_mismatch', 'id');
      }
      const finish = normalizeFinish({ from: 'messages', rawReason: preserved.value.stop_reason,
        hasToolCalls: preserved.value.content.some(block => block.type === 'tool_use') });
      if (!finish.ok) return finish;
      return { ok: true, value: {
        body: { ...structuredClone(preserved.value), id: context.identity.responseId, model: context.targetModel },
        identity: { responseId: context.identity.responseId, upstreamResponseId: preserved.value.id },
        terminal: finish.value.terminal,
      } };
    },
  };

  return Object.freeze({ request: Object.freeze(request), response: Object.freeze(response), error: messagesErrorAdapter });
}

const defaults = createMessagesPassthrough();
export const messagesRequestAdapter = defaults.request;
export const messagesResponseAdapter = defaults.response;
