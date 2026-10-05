/** SPDX-License-Identifier: LGPL-3.0-only
 * Original synthetic fixtures. The complete official Chat field layout is used
 * with substituted identifiers/text; no real provider conversation is retained.
 */
import { describe, expect, it } from 'vitest';
import { chatToMessagesResponse, chatToMessagesResponseAdapter } from '../../../packages/apicompat/responses/chat-to-messages.js';
import { createResponseIds } from '../../../packages/apicompat/ids.js';
import type { ResponseContext } from '../../../packages/apicompat/types/adapter.js';

const basic = () => ({ id: 'chatcmpl_source', object: 'chat.completion', created: 1741569952, model: 'private-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Synthetic greeting.' as string | null, refusal: null, annotations: [] }, logprobs: null, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }, service_tier: 'default', system_fingerprint: 'fp_synthetic' });
function context(): ResponseContext {
  const ids = createResponseIds({ seed: 'cm_synthetic', upstreamResponseId: 'chatcmpl_source' });
  if (!ids.ok) throw new Error('Invalid fixture IDs');
  return { identity: ids.value.identity, idFor: ids.value.idFor, createdAt: 456, targetModel: 'public-model' };
}
describe('P-CM-J1 text and complete Message core fields', () => {
  it('accepts standard neutral fields and asserts the target core independently of P04', () => {
    const result = chatToMessagesResponseAdapter.convert(basic(), context());
    expect(chatToMessagesResponseAdapter.from).toBe('chat');
    expect(chatToMessagesResponseAdapter.to).toBe('messages');
    if (!result.ok) throw new Error('Expected direct text response');
    // Independent field-level contract from the official Message response shape.
    expect(result.value.body).toEqual({ id: 'resp_cm_synthetic', type: 'message', role: 'assistant', model: 'public-model', content: [{ type: 'text', text: 'Synthetic greeting.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 2 } });
    expect(result.value.identity).toEqual({ responseId: 'resp_cm_synthetic', upstreamResponseId: 'chatcmpl_source' });
  });
  it.each(['', '  {"answer":42}\n  '])('keeps empty or whitespace-padded JSON text exact case %#', (content) => {
    const source = basic(); source.choices[0]!.message.content = content;
    const result = chatToMessagesResponse(source, context());
    if (!result.ok) throw new Error('Expected text');
    expect(result.value.body.content).toEqual([{ type: 'text', text: content }]);
  });
  it('does not invent a text block from null content and is stable on retries', () => {
    const source = basic(); source.choices[0]!.message.content = null;
    const before = JSON.stringify(source); const ctx = context();
    const result = chatToMessagesResponse(source, ctx);
    if (!result.ok) throw new Error('Expected absent content');
    expect(result.value.body.content).toEqual([]);
    expect(chatToMessagesResponse(source, ctx)).toEqual(result);
    expect(JSON.stringify(source)).toBe(before);
  });
  it('rejects alternatives and unknown data rather than selecting or dropping them', () => {
    const source = basic(); source.choices.push({ ...structuredClone(source.choices[0]!), index: 1 });
    expect(chatToMessagesResponse(source, context()).ok).toBe(false);
    expect(chatToMessagesResponse({ ...basic(), private_field: true }, context()).ok).toBe(false);
    expect(chatToMessagesResponse(basic(), { ...context(), targetModel: '' }).ok).toBe(false);
  });
});

const toolResponse = (content: string | null = null, argumentsText = ' { "city": "北京" }\n') => ({
  ...basic(), choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content,
    tool_calls: [
      { id: 'call_weather', type: 'function', function: { name: 'weather', arguments: argumentsText } },
      { id: 'call_clock', type: 'function', function: { name: 'clock', arguments: '{}' } },
    ],
  } }],
});

describe('P-CM-J2 function calls and ordered content blocks', () => {
  it('preserves multiple tool IDs, raw arguments as parsed objects and text order', () => {
    const result = chatToMessagesResponseAdapter.convert(toolResponse('before'), context());
    if (!result.ok) throw new Error('Expected tool conversion');
    expect(result.value.body.content).toEqual([
      { type: 'text', text: 'before' },
      { type: 'tool_use', id: 'call_weather', name: 'weather', input: { city: '北京' } },
      { type: 'tool_use', id: 'call_clock', name: 'clock', input: {} },
    ]);
  });

  it('preserves tool-only null content and explicit empty text', () => {
    for (const [content, expected] of [[null, [{ type: 'tool_use', id: 'call_weather', name: 'weather', input: { city: '北京' } }, { type: 'tool_use', id: 'call_clock', name: 'clock', input: {} }]], ['', [{ type: 'text', text: '' }, { type: 'tool_use', id: 'call_weather', name: 'weather', input: { city: '北京' } }, { type: 'tool_use', id: 'call_clock', name: 'clock', input: {} }]]] as const) {
      const result = chatToMessagesResponse(toolResponse(content), context());
      if (!result.ok) throw new Error('Expected tool-only conversion');
      expect(result.value.body.content).toEqual(expected);
    }
  });

  it.each(['', '{', '[]', 'null', '"scalar"'])('rejects invalid complete arguments case %#', (argumentsText) => {
    expect(chatToMessagesResponse(toolResponse(null, argumentsText), context())).toMatchObject({ ok: false, error: { code: 'invalid_tool_arguments' } });
  });

  it('rejects duplicate/unrepresentable tool IDs and names', () => {
    const duplicate = toolResponse(); duplicate.choices[0]!.message.tool_calls[1]!.id = 'call_weather';
    expect(chatToMessagesResponse(duplicate, context()).ok).toBe(false);
    const invalid = toolResponse(); invalid.choices[0]!.message.tool_calls[0]!.id = 'bad/id';
    expect(chatToMessagesResponse(invalid, context()).ok).toBe(false);
    const name = toolResponse(); name.choices[0]!.message.tool_calls[0]!.function.name = 'weather\n';
    expect(chatToMessagesResponse(name, context()).ok).toBe(false);
  });
});

describe('P-CM-J3 native terminal semantics', () => {
  it.each([['length', 'max_tokens'], ['tool_calls', 'tool_use']] as const)('maps %s to Messages stop_reason %s', (finish_reason, stop_reason) => {
    const source = toolResponse(null); source.choices[0]!.finish_reason = finish_reason;
    const result = chatToMessagesResponse(source, context());
    if (!result.ok) throw new Error('Expected terminal conversion');
    expect(result.value.body.stop_reason).toBe(stop_reason);
    expect(result.value.terminal.status).toBe(finish_reason === 'length' ? 'incomplete' : 'completed');
  });

  it('keeps an explicit refusal as target text while retaining refusal terminal semantics', () => {
    const source = basic(); source.choices[0]!.message = { role: 'assistant', content: null, refusal: 'Cannot comply.' };
    const result = chatToMessagesResponse(source, context());
    if (!result.ok) throw new Error('Expected refusal conversion');
    expect(result.value.body).toMatchObject({ content: [{ type: 'text', text: 'Cannot comply.' }], stop_reason: 'refusal' });
    expect(result.value.terminal).toMatchObject({ status: 'incomplete', reason: 'refusal' });
  });

  it('does not merge visible answer text with a separate refusal field', () => {
    const source = basic(); source.choices[0]!.message = { role: 'assistant', content: 'answer', refusal: 'Cannot comply.' };
    expect(chatToMessagesResponse(source, context()).ok).toBe(false);
  });

  it.each(['content_filter', 'vendor_finished'])('does not report %s as a normal Messages completion', (finish_reason) => {
    const source = basic(); source.choices[0]!.finish_reason = finish_reason;
    expect(chatToMessagesResponse(source, context()).ok).toBe(false);
  });
});

describe('P-CM-J3-E native Chat errors', () => {
  it('returns a sanitized Messages error envelope and failed terminal', () => {
    const result = chatToMessagesResponse({ error: { type: 'authentication_error', code: 'private-code', param: 'api_key', message: 'secret key at https://private.example' } }, context());
    expect(result).toMatchObject({ ok: true, value: { body: { type: 'error', error: { type: 'api_error', message: 'The upstream service could not complete the request.' } }, terminal: { status: 'failed', error: { kind: 'upstream_error' } } } });
    for (const secret of ['private-code', 'api_key', 'secret key', 'private.example']) expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([null, 'raw error', {}, { message: 1 }])('rejects malformed native error case %#', (error) => {
    expect(chatToMessagesResponse({ error }, context()).ok).toBe(false);
  });

  it('rejects success/error mixtures', () => {
    expect(chatToMessagesResponse({ ...basic(), error: { type: 'server_error', message: 'failed' } }, context()).ok).toBe(false);
  });
});

describe('P-CM-J3-T explicit thinking content', () => {
  it.each(['reasoning_content', 'reasoning'])('maps the public %s alias to an unsigned thinking block', (field) => {
    const source = basic(); source.choices[0]!.message = { role: 'assistant', content: null, [field]: 'Consider the constraints.' };
    const result = chatToMessagesResponse(source, context());
    if (!result.ok) throw new Error('Expected thinking conversion');
    expect(result.value.body.content).toEqual([{ type: 'thinking', thinking: 'Consider the constraints.', signature: '' }]);
  });

  it('deduplicates equal aliases and never falls back to visible text', () => {
    const source = basic(); source.choices[0]!.message = { role: 'assistant', content: null, reasoning_content: 'Think', reasoning: 'Think' };
    const result = chatToMessagesResponse(source, context());
    if (!result.ok) throw new Error('Expected thinking conversion');
    expect(result.value.body.content).toEqual([{ type: 'thinking', thinking: 'Think', signature: '' }]);
  });

  it('rejects conflicting aliases and unknown private reasoning payloads', () => {
    const conflict = basic(); conflict.choices[0]!.message = { role: 'assistant', content: null, reasoning_content: 'first', reasoning: 'second' };
    expect(chatToMessagesResponse(conflict, context())).toMatchObject({ ok: false, error: { code: 'conflicting_reasoning_aliases' } });
    const privatePayload = basic(); privatePayload.choices[0]!.message = { role: 'assistant', content: null, reasoning: 'visible', encrypted_content: 'opaque' };
    const result = chatToMessagesResponse(privatePayload, context());
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('opaque');
  });
});

describe('P-CM-J4 usage display without remeasurement', () => {
  it('converts inclusive Chat counts to Messages cache-exclusive input once', () => {
    const source = { ...basic(), usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19,
      prompt_tokens_details: { cached_tokens: 5, cache_write_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 3 } } };
    const result = chatToMessagesResponse(source, context());
    if (!result.ok) throw new Error('Expected usage conversion');
    expect(result.value.body.usage).toEqual({ input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 5, cache_creation_input_tokens: 4, output_tokens_details: { thinking_tokens: 3 } });
  });

  it('derives known no-cache usage and preserves observed zeros without adding total fields', () => {
    const result = chatToMessagesResponse({ ...basic(), usage: { prompt_tokens: 4, completion_tokens: 3 } }, context());
    if (!result.ok) throw new Error('Expected usage conversion');
    expect(result.value.body.usage).toEqual({ input_tokens: 4, output_tokens: 3 });
    const zero = chatToMessagesResponse({ ...basic(), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } }, context());
    if (!zero.ok) throw new Error('Expected zero usage conversion');
    expect(zero.value.body.usage).toEqual({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens_details: { thinking_tokens: 0 } });
  });

  // Missing, partial and invalid evidence exercise the adapter's rejection;
  // extractor tests own the individual counter/contradiction permutations.
  it.each([null, { prompt_tokens: 4 }, { prompt_tokens: 4, completion_tokens: 3, total_tokens: 100 }])('rejects incomplete or contradictory usage case %#', (usage) => {
    const result = chatToMessagesResponse({ ...basic(), usage }, context());
    expect(result).toMatchObject({ ok: false, error: { code: 'usage_not_representable', param: '$.usage' } });
  });

  it('keeps residual input and omits an unreported cache bucket', () => {
    const source = { ...basic(), usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19, prompt_tokens_details: { cached_tokens: 5 } } };
    const result = chatToMessagesResponse(source, context());
    if (!result.ok) throw new Error('Expected residual usage display');
    expect(result.value.body.usage).toEqual({ input_tokens: 7, output_tokens: 7, cache_read_input_tokens: 5 });
  });

  it('rejects unknown counters and nonzero unrepresentable modalities', () => {
    for (const usage of [
      { prompt_tokens: 1, completion_tokens: 1, cost: 99 },
      { prompt_tokens: -1, completion_tokens: 1 },
      { prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { private_counter: 1 } },
      { prompt_tokens: 1, completion_tokens: 1, completion_tokens_details: { audio_tokens: 1 } },
    ]) expect(chatToMessagesResponse({ ...basic(), usage }, context()).ok).toBe(false);
  });
});
