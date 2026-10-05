import { createChatPassthrough } from './passthrough/chat.js';
import { createResponsesPassthrough } from './passthrough/responses.js';
import { createMessagesPassthrough } from './passthrough/messages.js';
import { chatStreamAdapter } from './passthrough/chat-stream.js';
import { responsesStreamAdapter } from './passthrough/responses-stream.js';
import { messagesStreamAdapter } from './passthrough/messages-stream.js';
import { chatUsageExtractor } from './usage/chat.js';
import { responsesUsageExtractor } from './usage/responses.js';
import { messagesUsageExtractor } from './usage/messages.js';
import { chatErrorAdapter, responsesErrorAdapter, messagesErrorAdapter } from './errors.js';
import { chatToMessagesResponseAdapter } from './responses/chat-to-messages.js';
import { chatToResponsesResponseAdapter } from './responses/chat-to-responses.js';
import { messagesToChatResponseAdapter } from './responses/messages-to-chat.js';
import { messagesToResponsesResponseAdapter } from './responses/messages-to-responses.js';
import { responsesToChatResponseAdapter } from './responses/responses-to-chat.js';
import { responsesToMessagesResponseAdapter } from './responses/responses-to-messages.js';
import { chatToMessagesStreamAdapter } from './streams/chat-to-messages.js';
import { chatToResponsesStreamAdapter } from './streams/chat-to-responses.js';
import { messagesToChatStreamAdapter } from './streams/messages-to-chat.js';
import { messagesToResponsesStreamAdapter } from './streams/messages-to-responses.js';
import { responsesToChatStreamAdapter } from './streams/responses-to-chat.js';
import { responsesToMessagesStreamAdapter } from './streams/responses-to-messages.js';
import { createChatToMessagesRequestAdapter } from './requests/chat-to-messages.js';
import { createChatToResponsesRequestAdapter } from './requests/chat-to-responses.js';
import { createMessagesToChatRequestAdapter } from './requests/messages-to-chat.js';
import { createMessagesToResponsesRequestAdapter } from './requests/messages-to-responses.js';
import { createResponsesToChatRequestAdapter } from './requests/responses-to-chat.js';
import { createResponsesToMessagesRequestAdapter } from './requests/responses-to-messages.js';
import type { ResponsesErrorBody } from './errors.js';
import type { ChatRequest, ChatResponse, ChatErrorBody } from './types/chat.js';
import type { ResponsesRequest, ResponsesResponse } from './types/responses.js';
import type { MessagesRequest, MessagesResponse, MessagesError } from './types/messages.js';
import type { RequestAdapter, JsonResponseAdapter, StreamAdapter, ErrorAdapter, UsageExtractor } from './types/adapter.js';
import type { Protocol, ConversionResult, SseFrame } from './types/shared.js';
import type { ChannelCapabilities } from './capabilities/check.js';

export interface RequestWire { chat: ChatRequest; responses: ResponsesRequest; messages: MessagesRequest }
export interface ResponseWire { chat: ChatResponse; responses: ResponsesResponse; messages: MessagesResponse }
export interface ErrorWire { chat: ChatErrorBody; responses: ResponsesErrorBody; messages: MessagesError }
/** from/to always describes the REQUEST, never the return direction. */
export interface RegistryDirection<D extends Protocol = Protocol, U extends Protocol = Protocol> {
  readonly from: D; readonly to: U; readonly streaming: boolean;
}
export interface RegistryFactoryContext {
  readonly capabilities: ChannelCapabilities;
  readonly outputTokenLimit?: number;
  /** Trusted exact top-level response field names. Native body adapters still validate them. */
  readonly nativeResponseExtensions?: readonly string[];
}
export interface ProtocolAdapters<D extends Protocol = Protocol, U extends Protocol = Protocol> {
  readonly request: RequestAdapter<RequestWire[D], RequestWire[U], D, U>;
  readonly response: JsonResponseAdapter<ResponseWire[U], ResponseWire[D], U, D>;
  readonly stream: StreamAdapter<SseFrame, SseFrame, U, D>;
}
export interface ResolvedProtocolAdapters<D extends Protocol = Protocol, U extends Protocol = Protocol> extends ProtocolAdapters<D, U> {
  readonly error: ErrorAdapter<ErrorWire[D], D>;
  /** Consume original upstream JSON/events, not converted response/stream usage. */
  readonly usage: UsageExtractor<unknown, unknown, U>;
}
/** A registration is available only when BOTH JSON and SSE are implemented. */
export interface ProtocolRegistration<D extends Protocol, U extends Protocol> {
  readonly from: D; readonly to: U;
  readonly create: (context: RegistryFactoryContext) => ConversionResult<ProtocolAdapters<D, U>>;
}
export type AnyProtocolRegistration = { [D in Protocol]: { [U in Protocol]: ProtocolRegistration<D, U> }[Protocol] }[Protocol];
export interface ProtocolRegistry {
  available(direction: RegistryDirection): boolean;
  lookup<D extends Protocol, U extends Protocol>(direction: RegistryDirection<D, U>, context: RegistryFactoryContext): ConversionResult<ResolvedProtocolAdapters<D, U>>;
  readonly directions: readonly Readonly<{ from: Protocol; to: Protocol }>[];
}

const nativeRegistrations: readonly AnyProtocolRegistration[] = [
  { from: 'chat', to: 'chat', create() { const body = createChatPassthrough(); return { ok: true, value: { request: body.request, response: body.response, stream: chatStreamAdapter } }; } },
  { from: 'responses', to: 'responses', create() { const body = createResponsesPassthrough(); return { ok: true, value: { request: body.request, response: body.response, stream: responsesStreamAdapter } }; } },
  { from: 'messages', to: 'messages', create() { const body = createMessagesPassthrough(); return { ok: true, value: { request: body.request, response: body.response, stream: messagesStreamAdapter } }; } },
];

/*
 * Direct cross-protocol registrations. Each entry wires one request adapter
 * d→u to the corresponding upstream response/stream adapters u→d. Keeping
 * this table explicit makes it impossible to accidentally route through a
 * third wire protocol, and a direction is not registered until both JSON and
 * SSE implementations are present.
 */
const crossProtocolRegistrations: readonly AnyProtocolRegistration[] = [
  {
    from: 'chat', to: 'responses',
    create(context: RegistryFactoryContext) {
      return { ok: true, value: {
        request: createChatToResponsesRequestAdapter(context.capabilities),
        response: responsesToChatResponseAdapter,
        stream: responsesToChatStreamAdapter,
      } };
    },
  } as unknown as AnyProtocolRegistration,
  {
    from: 'chat', to: 'messages',
    create(context: RegistryFactoryContext) {
      if (context.outputTokenLimit === undefined) return failure('invalid_registry_context');
      const request = createChatToMessagesRequestAdapter({ maxTokens: context.outputTokenLimit, channelCapabilities: context.capabilities });
      if (!request.ok) return request;
      return { ok: true, value: { request: request.value, response: messagesToChatResponseAdapter, stream: messagesToChatStreamAdapter } };
    },
  } as unknown as AnyProtocolRegistration,
  {
    from: 'responses', to: 'chat',
    create(context: RegistryFactoryContext) {
      return { ok: true, value: {
        request: createResponsesToChatRequestAdapter(context.capabilities),
        response: chatToResponsesResponseAdapter,
        stream: chatToResponsesStreamAdapter,
      } };
    },
  } as unknown as AnyProtocolRegistration,
  {
    from: 'responses', to: 'messages',
    create(context: RegistryFactoryContext) {
      if (context.outputTokenLimit === undefined) return failure('invalid_registry_context');
      const request = createResponsesToMessagesRequestAdapter({ maxTokens: context.outputTokenLimit, channelCapabilities: context.capabilities });
      if (!request.ok) return request;
      return { ok: true, value: { request: request.value, response: messagesToResponsesResponseAdapter, stream: messagesToResponsesStreamAdapter } };
    },
  } as unknown as AnyProtocolRegistration,
  {
    from: 'messages', to: 'chat',
    create(context: RegistryFactoryContext) {
      return { ok: true, value: {
        request: createMessagesToChatRequestAdapter(context.capabilities),
        response: chatToMessagesResponseAdapter,
        stream: chatToMessagesStreamAdapter,
      } };
    },
  } as unknown as AnyProtocolRegistration,
  {
    from: 'messages', to: 'responses',
    create(context: RegistryFactoryContext) {
      return { ok: true, value: {
        request: createMessagesToResponsesRequestAdapter(context.capabilities),
        response: responsesToMessagesResponseAdapter,
        stream: responsesToMessagesStreamAdapter,
      } };
    },
  } as unknown as AnyProtocolRegistration,
];

/* Matrix order keeps directions stable for diagnostics and tests. */
const productionRegistrations: readonly AnyProtocolRegistration[] = [
  nativeRegistrations[0]!, crossProtocolRegistrations[0]!, crossProtocolRegistrations[1]!,
  crossProtocolRegistrations[2]!, nativeRegistrations[1]!, crossProtocolRegistrations[3]!,
  crossProtocolRegistrations[4]!, crossProtocolRegistrations[5]!, nativeRegistrations[2]!,
];
const errors = { chat: chatErrorAdapter, responses: responsesErrorAdapter, messages: messagesErrorAdapter };
const usage = { chat: chatUsageExtractor, responses: responsesUsageExtractor, messages: messagesUsageExtractor };
const protocol = (value: unknown): value is Protocol => value === 'chat' || value === 'responses' || value === 'messages';
const validDirection = (value: RegistryDirection): boolean => !!value && protocol(value.from) && protocol(value.to) && typeof value.streaming === 'boolean';
function failure<T>(code: 'adapter_not_available' | 'invalid_registry_context' | 'invalid_registry_direction' | 'adapter_direction_mismatch'): ConversionResult<T> {
  return { ok: false, error: { kind: code === 'adapter_not_available' ? 'unsupported_feature' : 'invalid_request', code,
    message: code === 'adapter_not_available' ? 'The requested protocol adapter is not available.' : 'Invalid protocol registry configuration.' } };
}

/**
 * One registry for P22-BASE and the eventual complete P22. Supplying registrations
 * replaces the defaults for controlled composition/tests; append future complete
 * direct directions here, never chain two wire conversions. No I/O or accounting.
 * Availability is implementation presence, separate from P10's semantic checks.
 */
export function createProtocolRegistry(registrations: readonly AnyProtocolRegistration[] = productionRegistrations): ProtocolRegistry {
  const entries = new Map<string, AnyProtocolRegistration>();
  for (const entry of registrations) {
    if (!protocol(entry.from) || !protocol(entry.to) || typeof entry.create !== 'function') throw new TypeError('Invalid protocol registration');
    const key = `${entry.from}:${entry.to}`;
    if (entries.has(key)) throw new TypeError('Duplicate protocol registration');
    entries.set(key, Object.freeze({ ...entry }));
  }
  const directions = Object.freeze([...entries.values()].map(entry => Object.freeze({ from: entry.from, to: entry.to })));
  return Object.freeze({
    directions,
    available(direction: RegistryDirection) { return validDirection(direction) && entries.has(`${direction.from}:${direction.to}`); },
    lookup<D extends Protocol, U extends Protocol>(direction: RegistryDirection<D, U>, context: RegistryFactoryContext): ConversionResult<ResolvedProtocolAdapters<D, U>> {
      if (!validDirection(direction)) return failure('invalid_registry_direction');
      const entry = entries.get(`${direction.from}:${direction.to}`);
      if (!entry) return failure('adapter_not_available');
      if (!context || !context.capabilities || context.capabilities.protocol !== direction.to
        || (context.outputTokenLimit !== undefined && (!Number.isSafeInteger(context.outputTokenLimit) || context.outputTokenLimit < 1
        || (context.capabilities.maxOutputTokens !== undefined && context.outputTokenLimit > context.capabilities.maxOutputTokens)))) return failure('invalid_registry_context');
      const made = entry.create(context);
      if (!made.ok) return made;
      const bundle = made.value;
      if (bundle.request.from !== direction.from || bundle.request.to !== direction.to
        || bundle.response.from !== direction.to || bundle.response.to !== direction.from
        || bundle.stream.from !== direction.to || bundle.stream.to !== direction.from) return failure('adapter_direction_mismatch');
      // The key and all native directions have been checked. This is the one
      // existential-map boundary; each registration enforces its wire types.
      return { ok: true, value: Object.freeze({ ...bundle, error: errors[direction.from], usage: usage[direction.to] }) as unknown as ResolvedProtocolAdapters<D, U> };
    },
  });
}

/** Production support: all nine direct protocol combinations, in ordinary and streaming modes. */
export const defaultProtocolRegistry = createProtocolRegistry();
