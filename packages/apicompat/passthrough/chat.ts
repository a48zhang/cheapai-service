import { chatErrorAdapter } from '../errors.js';
import { normalizeFinish } from '../finish-reasons.js';
import type { JsonResponseAdapter, RequestAdapter } from '../types/adapter.js';
import { parseChatRequest, parseChatResponse } from '../types/chat.js';
import type { ChatRequest, ChatResponse } from '../types/chat.js';
import type { ConversionResult, ProtocolError, TerminalState } from '../types/shared.js';

export interface ChatPassthroughOptions {
  /** Caller-owned, exact top-level names. Unknown nested wire fields still fail. */
  readonly requestAllowedExtensions?: readonly string[];
  readonly responseAllowedExtensions?: readonly string[];
}

const forbiddenKey = (key: string): boolean => /^(?:auth|authorization|proxyauthorization|headers|requestheaders|responseheaders|apikey|xapikey|token|apitoken|accesstoken|refreshtoken|bearertoken|sessiontoken|credential|credentials|cookie|cookies|setcookie|password|secret|secrets|secretkey|privatekey|signingkey|clientsecret)$/u.test(key.toLowerCase().replace(/[^a-z0-9]/gu, ''));
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeModel = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
const safeId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u0020\u007f]/u.test(value);

function failure<T>(kind: ProtocolError['kind'], code: string, param: string): ConversionResult<T> {
  return { ok: false, error: { kind, code, message: 'The Chat payload cannot be safely passed through.', param } };
}

/** Extensions are JSON-validated first. Scan only extension data, not prompts or schemas. */
function extensionPolicy(input: Record<string, unknown>, allowlist: readonly string[]): string | undefined {
  for (const name of allowlist) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) || forbiddenKey(name)) return 'extensions';
    if (!Object.hasOwn(input, name)) continue;
    const pending: unknown[] = [input[name]];
    while (pending.length) {
      const value = pending.pop();
      if (Array.isArray(value)) pending.push(...value);
      else if (object(value)) {
        for (const [key, child] of Object.entries(value)) {
          if (forbiddenKey(key)) return `$.${name}`;
          pending.push(child);
        }
      }
    }
  }
  return undefined;
}

/**
 * Same-protocol body adapters only. No authentication, fetch, SSE, usage
 * extraction or billing. The explicit allowlist gates preserve mode; it is
 * copied at construction so callers cannot later broaden an existing adapter.
 */
export function createChatPassthrough(options: ChatPassthroughOptions = {}) {
  const requestAllowlist = Object.freeze([...(options.requestAllowedExtensions ?? [])]);
  const responseAllowlist = Object.freeze([...(options.responseAllowedExtensions ?? [])]);

  const request: RequestAdapter<unknown, ChatRequest, 'chat', 'chat'> = {
    from: 'chat', to: 'chat',
    convert(input, context) {
      if (!safeModel(context.targetModel)) return failure('invalid_request', 'invalid_target_model', 'model');
      const preserved = parseChatRequest(input, { unknownFields: 'preserve' });
      if (!preserved.ok) return preserved;
      const policy = extensionPolicy(preserved.value, requestAllowlist);
      if (policy) return failure('unsupported_feature', 'unsafe_chat_extension', policy);
      // Strict nested shapes plus P02's exact top-level allowlist prevent the
      // preserve pass from authorizing arbitrary unknown fields or tools.
      const allowed = parseChatRequest(input, { allowedExtensions: requestAllowlist });
      if (!allowed.ok) return allowed;
      return { ok: true, value: { ...structuredClone(preserved.value), model: context.targetModel } };
    },
  };

  const response: JsonResponseAdapter<unknown, ChatResponse, 'chat', 'chat'> = {
    from: 'chat', to: 'chat',
    convert(input, context) {
      if (!safeModel(context.targetModel)) return failure('invalid_response', 'invalid_target_model', 'model');
      if (!safeId(context.identity.responseId)) return failure('invalid_response', 'invalid_response_identity', 'id');
      const preserved = parseChatResponse(input, { unknownFields: 'preserve' });
      if (!preserved.ok) return preserved;
      const policy = extensionPolicy(preserved.value, responseAllowlist);
      if (policy) return failure('unsupported_feature', 'unsafe_chat_extension', policy);
      const allowed = parseChatResponse(input, { allowedExtensions: responseAllowlist });
      if (!allowed.ok) return allowed;
      if (context.identity.upstreamResponseId !== undefined && context.identity.upstreamResponseId !== preserved.value.id) {
        return failure('invalid_response', 'upstream_identity_mismatch', 'id');
      }
      const terminals: TerminalState[] = [];
      for (const choice of preserved.value.choices) {
        const finish = normalizeFinish({ from: 'chat', rawReason: choice.finish_reason,
          hasToolCalls: (choice.message.tool_calls?.length ?? 0) > 0,
          hasRefusal: typeof choice.message.refusal === 'string' && choice.message.refusal.length > 0 });
        if (!finish.ok) return finish;
        terminals.push(finish.value.terminal);
      }
      // A truncated/unknown/refused choice must not be hidden by another choice
      // completing. Native per-choice reasons remain unchanged in the body.
      const terminal = terminals.find(value => value.status !== 'completed')
        ?? terminals.find(value => value.status === 'completed' && value.reason === 'tool_calls')
        ?? terminals[0];
      if (!terminal) return failure('invalid_response', 'missing_chat_choices', 'choices');
      const body: ChatResponse = { ...structuredClone(preserved.value), id: context.identity.responseId, model: context.targetModel };
      return { ok: true, value: {
        body, identity: { responseId: context.identity.responseId, upstreamResponseId: preserved.value.id }, terminal,
      } };
    },
  };

  return Object.freeze({ request: Object.freeze(request), response: Object.freeze(response), error: chatErrorAdapter });
}

const defaults = createChatPassthrough();
export const chatRequestAdapter = defaults.request;
export const chatResponseAdapter = defaults.response;
