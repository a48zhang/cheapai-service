import { describe, expect, it } from 'vitest';
import { chatErrorAdapter, encodeChatError, encodeChatStreamError, encodeErrorSseFrame, encodeMessagesError,
  encodeMessagesStreamError, encodeResponsesError, encodeResponsesStreamError, messagesErrorAdapter, responsesErrorAdapter,
} from '../../packages/apicompat/errors.js';
import type { ProtocolError } from '../../packages/apicompat/types/shared.js';

const invalid: ProtocolError = { kind: 'invalid_request', code: 'parser_specific', message: 'A parser diagnostic.', param: '$.messages[0].content' };
const encoders = [encodeChatError, encodeResponsesError, encodeMessagesError];

describe('native safe protocol error encoding', () => {
  it('encodes Chat and Responses HTTP errors with their OpenAI-style envelope', () => {
    const expected = { error: { type: 'invalid_request_error', code: 'invalid_request', message: 'The request is invalid.', param: '$.messages[0].content' } };
    expect(encodeChatError(invalid)).toEqual(expected);
    expect(encodeResponsesError(invalid)).toEqual(expected);
    expect(chatErrorAdapter.convert(invalid)).toEqual(expected);
    expect(responsesErrorAdapter.convert(invalid)).toEqual(expected);
  });

  it('encodes Messages native top-level type and error type/message without OpenAI-only fields', () => {
    const expected = { type: 'error', error: { type: 'invalid_request_error', message: 'The request is invalid.' } };
    expect(encodeMessagesError(invalid)).toEqual(expected);
    expect(messagesErrorAdapter.convert(invalid)).toEqual(expected);
  });

  it.each(['invalid_request', 'unsupported_feature', 'upstream_error', 'invalid_response', 'stream_error'] as const)('maps known kind %s to fixed safe diagnostics', kind => {
    const error: ProtocolError = { kind, code: 'secret-code', message: 'Bearer SECRET_TOKEN', param: 'model', upstreamStatus: 401 };
    const chat = encodeChatError(error);
    expect(chat.error.code).toBe(kind);
    expect(chat.error.type).toBe(kind === 'invalid_request' || kind === 'unsupported_feature' ? 'invalid_request_error' : 'server_error');
    for (const encode of encoders) expect(JSON.stringify(encode(error))).not.toMatch(/SECRET_TOKEN|secret-code|401/);
  });

  it.each([undefined, 'secret thrown string', new Error('database password=secret'),
    { error: { message: 'provider raw body' }, headers: { Authorization: 'Bearer private' } },
    { kind: 'unknown', code: 'private', message: 'secret' }, { kind: 'upstream_error' },
  ])('uses one stable fallback for unknown internal errors %#', error => {
    for (const encode of encoders) expect(encode(error)).toEqual(encode(undefined));
    expect(encodeChatError(error).error).toEqual({ type: 'server_error', code: 'internal_error', message: 'An internal error occurred.', param: null });
  });


  it.each(['authorization', '$.api_key', 'password', 'secret', 'access_token', 'Bearer private', 'model\nSet-Cookie: secret', 'x'.repeat(129)])('omits unsafe parameter paths %#', param => {
    expect(encodeChatError({ ...invalid, param }).error.param).toBeNull();
  });

  it.each(['$', 'model', 'max_tokens', '$.messages[12].tool_calls[0].function.arguments'])('preserves bounded structural parameter path %s', param => {
    expect(encodeChatError({ ...invalid, param }).error.param).toBe(param);
  });

});

describe('native in-stream error encoding', () => {
  it('emits the Responses error event with caller-owned sequence instead of an HTTP wrapper', () => {
    expect(encodeResponsesStreamError(invalid, 7)).toEqual({ type: 'error', sequence_number: 7,
      code: 'invalid_request', message: 'The request is invalid.', param: '$.messages[0].content' });
    expect(encodeResponsesStreamError(undefined).sequence_number).toBe(0);
  });

  it.each([-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid caller sequence %#', sequence => {
    expect(() => encodeResponsesStreamError(invalid, sequence)).toThrow('Invalid Responses event sequence.');
  });

  it('uses Chat data-only SSE and native error event names for Responses/Messages', () => {
    expect(encodeChatStreamError(invalid)).toEqual(encodeChatError(invalid));
    expect(encodeMessagesStreamError(invalid)).toEqual(encodeMessagesError(invalid));
    const chat = encodeErrorSseFrame('chat', invalid);
    expect(chat).not.toHaveProperty('event'); expect(JSON.parse(chat.data)).toEqual(encodeChatError(invalid));
    const responses = encodeErrorSseFrame('responses', invalid, 4);
    expect(responses.event).toBe('error'); expect(JSON.parse(responses.data)).toEqual(encodeResponsesStreamError(invalid, 4));
    const messages = encodeErrorSseFrame('messages', invalid);
    expect(messages.event).toBe('error'); expect(JSON.parse(messages.data)).toEqual(encodeMessagesError(invalid));
    for (const frame of [chat, responses, messages]) {
      expect(frame).not.toHaveProperty('headers'); expect(frame).not.toHaveProperty('status');
      expect(frame.data).not.toMatch(/\[DONE\]|message_stop|response.completed/);
    }
  });
});
