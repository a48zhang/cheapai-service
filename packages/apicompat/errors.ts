import type { ErrorAdapter } from './types/adapter.js';
import type { ChatErrorBody } from './types/chat.js';
import type { MessagesError } from './types/messages.js';
import type { Protocol, ProtocolError, SseFrame } from './types/shared.js';

export interface ResponsesErrorBody {
  readonly error: {
    readonly message: string;
    readonly type: 'invalid_request_error' | 'server_error';
    readonly code: string;
    readonly param: string | null;
  };
}

export interface ResponsesStreamError {
  readonly type: 'error';
  readonly sequence_number: number;
  readonly code: string;
  readonly message: string;
  readonly param: string | null;
}

type ErrorKind = ProtocolError['kind'];
interface PublicError {
  readonly code: string;
  readonly message: string;
  readonly request: boolean;
  readonly param: string | null;
}

const publicErrors: Readonly<Record<ErrorKind, Omit<PublicError, 'param'>>> = Object.freeze({
  invalid_request: Object.freeze({ code: 'invalid_request', message: 'The request is invalid.', request: true }),
  unsupported_feature: Object.freeze({ code: 'unsupported_feature', message: 'The requested feature is not supported.', request: true }),
  upstream_error: Object.freeze({ code: 'upstream_error', message: 'The upstream service could not complete the request.', request: false }),
  invalid_response: Object.freeze({ code: 'invalid_response', message: 'The upstream service returned an invalid response.', request: false }),
  stream_error: Object.freeze({ code: 'stream_error', message: 'The response stream could not be completed.', request: false }),
});
const internalError: PublicError = Object.freeze({ code: 'internal_error', message: 'An internal error occurred.', request: false, param: null });

/** Read data properties only: arbitrary Error objects/accessors are not trusted. */
function ownData(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function safeParam(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 128) return null;
  if (!/^(?:\$|(?:\$\.)?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[0-9]+\])*)$/u.test(value)) return null;
  if (/(?:^|\.)(?:authorization|api_key|password|secret|access_token)(?:$|\.|\[)/iu.test(value)) return null;
  return value;
}

/**
 * Even recognized ProtocolError.message/code are not reflected: callers may
 * accidentally place a provider body or credential there. Known kinds select a
 * fixed public diagnostic; unknown thrown values receive one stable fallback.
 * HTTP status and headers belong exclusively to the gateway.
 */
function publicError(input: unknown): PublicError {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return internalError;
    const kind = ownData(input, 'kind');
    if (typeof kind !== 'string' || !Object.hasOwn(publicErrors, kind)) return internalError;
    // A known kind alone is insufficient to impersonate the shared error shape.
    if (typeof ownData(input, 'code') !== 'string' || typeof ownData(input, 'message') !== 'string') return internalError;
    const safe = publicErrors[kind as ErrorKind];
    return { ...safe, param: safe.request ? safeParam(ownData(input, 'param')) : null };
  } catch {
    // Includes hostile proxies; error encoding must not reveal their exceptions.
    return internalError;
  }
}

export function encodeChatError(error: unknown): ChatErrorBody {
  const safe = publicError(error);
  return { error: { message: safe.message, type: safe.request ? 'invalid_request_error' : 'server_error', code: safe.code, param: safe.param } };
}

export function encodeResponsesError(error: unknown): ResponsesErrorBody {
  const safe = publicError(error);
  return { error: { message: safe.message, type: safe.request ? 'invalid_request_error' : 'server_error', code: safe.code, param: safe.param } };
}

export function encodeMessagesError(error: unknown): MessagesError {
  const safe = publicError(error);
  return { type: 'error', error: { type: safe.request ? 'invalid_request_error' : 'api_error', message: safe.message } };
}

/** Chat and Messages carry their native error envelopes inside SSE data. */
export const encodeChatStreamError = encodeChatError;
export const encodeMessagesStreamError = encodeMessagesError;

/** The caller owns event sequencing. An invalid sequence is a caller error. */
export function encodeResponsesStreamError(error: unknown, sequenceNumber = 0): ResponsesStreamError {
  if (!Number.isSafeInteger(sequenceNumber) || sequenceNumber < 0) throw new RangeError('Invalid Responses event sequence.');
  const safe = publicError(error);
  return { type: 'error', sequence_number: sequenceNumber, code: safe.code, message: safe.message, param: safe.param };
}

/** Parsed SSE frame only: no HTTP status, header changes, success markers or I/O. */
export function encodeErrorSseFrame(protocol: Protocol, error: unknown, sequenceNumber = 0): SseFrame {
  switch (protocol) {
    case 'chat': return { data: JSON.stringify(encodeChatStreamError(error)) };
    case 'responses': return { event: 'error', data: JSON.stringify(encodeResponsesStreamError(error, sequenceNumber)) };
    case 'messages': return { event: 'error', data: JSON.stringify(encodeMessagesStreamError(error)) };
  }
}

export const chatErrorAdapter: ErrorAdapter<ChatErrorBody, 'chat'> = Object.freeze({ to: 'chat', convert: encodeChatError });
export const responsesErrorAdapter: ErrorAdapter<ResponsesErrorBody, 'responses'> = Object.freeze({ to: 'responses', convert: encodeResponsesError });
export const messagesErrorAdapter: ErrorAdapter<MessagesError, 'messages'> = Object.freeze({ to: 'messages', convert: encodeMessagesError });
