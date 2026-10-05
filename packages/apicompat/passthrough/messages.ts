import { messagesErrorAdapter } from '../errors.js';
import { normalizeFinish } from '../finish-reasons.js';
import type { JsonResponseAdapter, RequestAdapter } from '../types/adapter.js';
import { parseMessagesRequest, parseMessagesResponse } from '../types/messages.js';
import type { MessagesRequest, MessagesResponse } from '../types/messages.js';
import type { ConversionResult, ProtocolError } from '../types/shared.js';

export interface MessagesPassthroughOptions {
  /** Legacy options; native JSON extensions are always preserved. */
  readonly requestAllowedExtensions?: readonly string[];
  readonly responseAllowedExtensions?: readonly string[];
}

const safeModel = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
const safeId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u0020\u007f]/u.test(value);

function fail<T>(kind: ProtocolError['kind'], code: string, param: string): ConversionResult<T> {
  return { ok: false, error: { kind, code, message: 'The Messages payload cannot be safely passed through.', param } };
}

/**
 * Messages → Messages JSON body adapters. P04 owns supported wire shapes; P11
 * owns terminal semantics. Preserve opaque native signatures/redacted thinking,
 * cache controls, tool IDs and usage verbatim, without claiming authenticity,
 * capability checking, usage extraction or billing. P14 remains independent.
 * No headers, credentials, fetch or SSE are accepted as adapter dependencies.
 */
export function createMessagesPassthrough(_options: MessagesPassthroughOptions = {}) {
  const request: RequestAdapter<unknown, MessagesRequest, 'messages', 'messages'> = {
    from: 'messages', to: 'messages',
    convert(input, context) {
      if (!safeModel(context.targetModel)) return fail('invalid_request', 'invalid_target_model', 'model');
      const preserved = parseMessagesRequest(input, { unknownFields: 'preserve', native: true });
      if (!preserved.ok) return preserved;
      return { ok: true, value: { ...structuredClone(preserved.value), model: context.targetModel } };
    },
  };

  const response: JsonResponseAdapter<unknown, MessagesResponse, 'messages', 'messages'> = {
    from: 'messages', to: 'messages',
    convert(input, context) {
      if (!safeModel(context.targetModel)) return fail('invalid_response', 'invalid_target_model', 'model');
      if (!safeId(context.identity.responseId)) return fail('invalid_response', 'invalid_response_identity', 'id');
      const preserved = parseMessagesResponse(input, { unknownFields: 'preserve', native: true });
      if (!preserved.ok) return preserved;
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
