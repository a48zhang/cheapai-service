/** SPDX-License-Identifier: LGPL-3.0-only
 * Original synthetic tests for the pinned Sub2API behavioral adaptation documented
 * in packages/apicompat/responses/chat-to-responses.ts. No upstream fixtures copied.
 */
import { describe, expect, it } from 'vitest';
import { chatToResponsesResponse, chatToResponsesResponseAdapter } from '../../../packages/apicompat/responses/chat-to-responses.js';
import { createResponseIds } from '../../../packages/apicompat/ids.js';
import type { ResponseContext } from '../../../packages/apicompat/types/adapter.js';

const basic = () => ({ id: 'chatcmpl_upstream', object: 'chat.completion', created: 123, model: 'private-upstream-model', choices: [{ index: 0, message: { role: 'assistant', content: 'Hello 世界' as string | null }, finish_reason: 'stop' }] });
function context(): ResponseContext {
  const ids = createResponseIds({ seed: 'synthetic_response', upstreamResponseId: 'chatcmpl_upstream' });
  if (!ids.ok) throw new Error('Invalid fixture IDs');
  return { identity: ids.value.identity, idFor: ids.value.idFor, targetModel: 'public-model', createdAt: 456 };
}

describe('P-CR-J1 ordinary text, model and stable identity', () => {
  it('converts directly into native Responses with the caller-owned public identity', () => {
    const source = basic(); source.choices[0]!.message = { ...source.choices[0]!.message, annotations: [] };
    const result = chatToResponsesResponseAdapter.convert(source, context());
    expect(chatToResponsesResponseAdapter.from).toBe('chat');
    expect(chatToResponsesResponseAdapter.to).toBe('responses');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.body).toMatchObject({ id: 'resp_synthetic_response', object: 'response', created_at: 456, model: 'public-model', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello 世界', annotations: [] }] }] });
    expect(result.value.identity).toEqual({ responseId: 'resp_synthetic_response', upstreamResponseId: 'chatcmpl_upstream' });
    expect(result.value.terminal).toMatchObject({ status: 'completed', reason: 'stop' });
    expect(JSON.stringify(result.value.body)).not.toContain('private-upstream-model');
    expect(Object.hasOwn(result.value.body, 'usage')).toBe(false);
  });

  it('reuses stable item IDs and never mutates source/context', () => {
    const source = basic();
    const before = JSON.stringify(source);
    const ctx = context();
    expect(chatToResponsesResponse(source, ctx)).toEqual(chatToResponsesResponse(source, ctx));
    expect(JSON.stringify(source)).toBe(before);
    expect(ctx.identity.responseId).toBe('resp_synthetic_response');
  });

  it.each(['', '  {"structured":"unchanged"}\n  '])('preserves empty or whitespace-padded JSON text without reparsing case %#', (text) => {
    const source = basic(); source.choices[0]!.message.content = text;
    const result = chatToResponsesResponse(source, context());
    if (!result.ok) throw new Error('Expected text conversion');
    expect(result.value.body.output[0]).toMatchObject({ content: [{ type: 'output_text', text }] });
  });

  it('does not invent visible text for a null content payload', () => {
    const source = basic(); source.choices[0]!.message.content = null;
    const result = chatToResponsesResponse(source, context());
    if (!result.ok) throw new Error('Expected null-content conversion');
    expect(result.value.body.output).toEqual([]);
  });

  it('rejects alternative choices rather than silently taking the first', () => {
    const source = basic(); source.choices.push({ ...source.choices[0]!, message: { ...source.choices[0]!.message }, index: 1 });
    expect(chatToResponsesResponse(source, context())).toMatchObject({ ok: false, error: { param: '$.choices' } });
  });

  it.each([{ extra: 'not silently discarded' }])('rejects currently unmapped metadata case %#', (extra) => {
    expect(chatToResponsesResponse({ ...basic(), ...extra }, context()).ok).toBe(false);
  });

  it.each([{ audio: {} }])('rejects unmapped message content case %#', (extra) => {
    const source = basic();
    source.choices[0]!.message = { ...source.choices[0]!.message, ...extra };
    expect(chatToResponsesResponse(source, context()).ok).toBe(false);
  });

  it.each([{ targetModel: '' }, { createdAt: NaN }, { identity: { responseId: 'invalid/id' } }, { identity: { responseId: 'resp_ok', upstreamResponseId: 'different' } }])('rejects invalid response context case %#', (extra) => {
    expect(chatToResponsesResponse(basic(), { ...context(), ...extra }).ok).toBe(false);
  });

  it('contains allocator errors and refuses colliding item IDs', () => {
    expect(chatToResponsesResponse(basic(), { ...context(), idFor: () => { throw new Error('secret details'); } })).toMatchObject({ ok: false, error: { code: 'chat_to_responses_conversion_failed' } });
    const ctx = context();
    expect(chatToResponsesResponse(basic(), { ...ctx, idFor: () => ctx.identity.responseId }).ok).toBe(false);
  });
});

describe('CR-JSON-STANDARD known response metadata', () => {
  it.each(['auto', 'default', 'flex', 'scale', 'priority', 'fast', 'ultrafast', null])('accepts native service tier case %# without rejecting ordinary content', (service_tier) => {
    const result = chatToResponsesResponse({ ...basic(), service_tier, system_fingerprint: 'fp_backend_revision' }, context());
    if (!result.ok) throw new Error('Expected standard metadata');
    expect(result.value.body.service_tier).toBe(service_tier);
    expect(result.value.body.output[0]).toMatchObject({ content: [{ text: 'Hello 世界' }] });
    expect(Object.hasOwn(result.value.body, 'system_fingerprint')).toBe(false);
  });
  it('does not coerce malformed standard metadata into a valid reply', () => {
    expect(chatToResponsesResponse({ ...basic(), service_tier: 1 }, context()).ok).toBe(false);
    expect(chatToResponsesResponse({ ...basic(), service_tier: 'vendor-special' }, context())).toMatchObject({ ok: false, error: { code: 'invalid_service_tier' } });
    expect(chatToResponsesResponse({ ...basic(), system_fingerprint: { private: 'data' } }, context()).ok).toBe(false);
  });
});

describe('CR-JSON-ANNOTATIONS ordinary empty citation metadata', () => {
  it('never silently drops a nonempty citation or coerces null annotations', () => {
    for (const annotations of [null, [{ type: 'url_citation', url_citation: { start_index: 0, end_index: 5, url: 'https://example.com', title: 'Reference' } }]]) {
      const source = basic(); source.choices[0]!.message = { ...source.choices[0]!.message, annotations };
      expect(chatToResponsesResponse(source, context()).ok).toBe(false);
    }
  });
});

describe('P-CR-J4 usage is presentation, not another measurement or charge', () => {
  it('maps interpreted inclusive cache/reasoning counts without adding them to totals again', () => {
    const source = { ...basic(), usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19, prompt_tokens_details: { cached_tokens: 5, cache_write_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 3 } } };
    const before = JSON.stringify(source);
    const ctx = context();
    const result = chatToResponsesResponse(source, ctx);
    if (!result.ok) throw new Error('Expected usage projection');
    expect(result.value.body.usage).toEqual({ input_tokens: 12, output_tokens: 7, total_tokens: 19, input_tokens_details: { cached_tokens: 5, cache_write_tokens: 4 }, output_tokens_details: { reasoning_tokens: 3 } });
    expect(chatToResponsesResponse(source, ctx)).toEqual(result);
    expect(JSON.stringify(source)).toBe(before);
  });

  it('derives total only from two known counts and leaves unknown detail fields absent', () => {
    const result = chatToResponsesResponse({ ...basic(), usage: { prompt_tokens: 12, completion_tokens: 7 } }, context());
    if (!result.ok) throw new Error('Expected usage projection');
    expect(result.value.body.usage).toEqual({ input_tokens: 12, output_tokens: 7, total_tokens: 19 });
  });

  it('preserves real zero observations without synthesizing missing ones', () => {
    const result = chatToResponsesResponse({ ...basic(), usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } }, context());
    if (!result.ok) throw new Error('Expected zero evidence projection');
    expect(result.value.body.usage).toEqual({ input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } });
  });

  // Keep one missing, partial and invalid observation at this boundary; the
  // usage extractor suite covers empty evidence, other counters and overflow.
  it.each([null, { prompt_tokens: 4 }, { prompt_tokens: 4, completion_tokens: 3, total_tokens: 100 }])(
    'does not pretend incomplete/contradictory usage is exact zero case %#', (usage) => {
      const result = chatToResponsesResponse({ ...basic(), usage }, context());
      if (!result.ok) throw new Error('Expected output with unknown usage');
      expect(Object.hasOwn(result.value.body, 'usage')).toBe(false);
      expect(result.value.body.output[0]).toMatchObject({ content: [{ text: 'Hello 世界' }] });
    },
  );

  it('accepts known zero-only modality counters but rejects nonzero unmappable buckets', () => {
    const zero = { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7, prompt_tokens_details: { audio_tokens: 0, cache_write_tokens: 0 }, completion_tokens_details: { audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 } };
    const result = chatToResponsesResponse({ ...basic(), usage: zero }, context());
    if (!result.ok) throw new Error('Expected zero-only details to remain uncharged');
    expect(result.value.body.usage).toEqual({ input_tokens: 4, output_tokens: 3, total_tokens: 7 });
    expect(chatToResponsesResponse({ ...basic(), usage: { ...zero, prompt_tokens_details: { cache_write_tokens: 1 } } }, context()).ok).toBe(false);
    expect(chatToResponsesResponse({ ...basic(), usage: { ...zero, completion_tokens_details: { audio_tokens: 1 } } }, context()).ok).toBe(false);
  });

  it('does not silently drop unknown usage data or coerce invalid counts', () => {
    for (const usage of [
      { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 99 },
      { prompt_tokens: -1, completion_tokens: 1 },
      { prompt_tokens: '1', completion_tokens: 1 },
      { prompt_tokens: 1, completion_tokens: 1, prompt_tokens_details: { private_counter: 1 } },
    ]) expect(chatToResponsesResponse({ ...basic(), usage }, context()).ok).toBe(false);
  });
});

describe('P-CR-J3-T explicit thinking content', () => {
  it.each(['reasoning_content', 'reasoning'])('preserves the %s alias as a native reasoning item, not answer text', (field) => {
    const source = basic();
    source.choices[0]!.message = { role: 'assistant', content: null, [field]: 'Consider the constraints.' };
    const ctx = context();
    const result = chatToResponsesResponse(source, ctx);
    if (!result.ok) throw new Error('Expected reasoning conversion');
    expect(result.value.body.output).toMatchObject([{ type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: 'Consider the constraints.' }] }]);
    expect(result.value.body.output).toHaveLength(1);
    expect(JSON.stringify(result.value.body)).not.toContain('output_text');
    expect(chatToResponsesResponse(source, ctx)).toEqual(result);
  });

  it('deduplicates equal aliases and preserves reasoning/text/tool order and distinct IDs', () => {
    const source = toolResponse('{"answer":42}');
    source.choices[0]!.message = { ...source.choices[0]!.message, reasoning_content: 'Thinking', reasoning: 'Thinking' };
    const result = chatToResponsesResponse(source, context());
    if (!result.ok) throw new Error('Expected mixed conversion');
    expect(result.value.body.output.map((item) => item.type)).toEqual(['reasoning', 'message', 'function_call', 'function_call']);
    expect(result.value.body.output[1]).toMatchObject({ content: [{ type: 'output_text', text: '{"answer":42}' }] });
    expect(new Set(result.value.body.output.map((item) => item.id)).size).toBe(4);
  });

  it('rejects conflicting nonidentical aliases instead of selecting and losing content', () => {
    const source = basic(); source.choices[0]!.message = { ...source.choices[0]!.message, reasoning_content: 'first', reasoning: 'second' };
    expect(chatToResponsesResponse(source, context())).toMatchObject({ ok: false, error: { code: 'conflicting_reasoning_aliases' } });
  });

  it.each(['signature', 'encrypted_content', 'reasoning_details', 'redacted_thinking'])('does not fabricate or downgrade private field %s', (field) => {
    const source = basic(); source.choices[0]!.message = { ...source.choices[0]!.message, reasoning: 'visible thinking', [field]: 'opaque-secret' };
    const result = chatToResponsesResponse(source, context());
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('opaque-secret');
  });

  it('keeps incomplete thinking distinct from a completed result', () => {
    const source = basic(); source.choices[0]!.finish_reason = 'length';
    source.choices[0]!.message = { role: 'assistant', content: null, reasoning: 'unfinished' };
    const result = chatToResponsesResponse(source, context());
    if (!result.ok) throw new Error('Expected incomplete reasoning');
    expect(result.value.body.output[0]).toMatchObject({ type: 'reasoning', status: 'incomplete', summary: [{ text: 'unfinished' }] });
    expect(result.value.body.status).toBe('incomplete');
  });
});

describe('P-CR-J3 terminal states without fabricated success', () => {
  it.each([['length', 'max_output_tokens'], ['content_filter', 'content_filter']])('maps %s to native incomplete state', (finishReason, incompleteReason) => {
    const source = basic(); source.choices[0]!.finish_reason = finishReason!;
    const result = chatToResponsesResponse(source, context());
    if (!result.ok) throw new Error('Expected terminal conversion');
    expect(result.value.body).toMatchObject({ status: 'incomplete', incomplete_details: { reason: incompleteReason }, output: [{ status: 'incomplete' }] });
    expect(result.value.terminal).toMatchObject({ status: 'incomplete', reason: finishReason });
  });

  it('keeps truncated tool arguments only as incomplete, never silently completed/dropped', () => {
    const source = toolResponse(null, '{"city":'); source.choices[0]!.finish_reason = 'length';
    const result = chatToResponsesResponse(source, context());
    if (!result.ok) throw new Error('Expected incomplete tool conversion');
    expect(result.value.body.output[0]).toMatchObject({ type: 'function_call', arguments: '{"city":', status: 'incomplete' });
    expect(result.value.body.status).toBe('incomplete');
  });

  it('preserves native refusal content while P11 keeps refusal distinct from normal stop', () => {
    const source = { ...basic(), choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: null, refusal: 'Cannot fulfill this request.' } }] };
    const result = chatToResponsesResponse(source, context());
    if (!result.ok) throw new Error('Expected refusal conversion');
    expect(result.value.body).toMatchObject({ status: 'completed', output: [{ content: [{ type: 'refusal', refusal: 'Cannot fulfill this request.' }] }] });
    expect(result.value.terminal).toMatchObject({ status: 'incomplete', reason: 'refusal' });
  });

  it('does not invent refusal content from a finish reason alone', () => {
    const source = basic(); source.choices[0]!.finish_reason = 'refusal';
    expect(chatToResponsesResponse(source, context())).toMatchObject({ ok: false, error: { code: 'refusal_payload_required' } });
  });

  it('returns a failed conversion for an unknown provider reason', () => {
    const source = basic(); source.choices[0]!.finish_reason = 'vendor_finished';
    expect(chatToResponsesResponse(source, context())).toMatchObject({ ok: false, error: { code: 'unknown_finish_reason' } });
  });
});

describe('P-CR-J3-E native upstream error envelopes', () => {
  it('encodes an upstream failure with the target native error shape and failed terminal', () => {
    const result = chatToResponsesResponse({ error: { type: 'authentication_error', code: 'private-code', param: 'api_key', message: 'Bearer secret-key at https://private.example/' } }, context());
    expect(result).toMatchObject({ ok: true, value: {
      body: { error: { type: 'server_error', code: 'upstream_error', message: 'The upstream service could not complete the request.', param: null } },
      terminal: { status: 'failed', error: { kind: 'upstream_error' } },
    } });
    const encoded = JSON.stringify(result);
    for (const privateText of ['secret-key', 'private-code', 'private.example', 'api_key']) expect(encoded).not.toContain(privateText);
    if (result.ok) expect(Object.hasOwn(result.value.body, 'output')).toBe(false);
  });

  it('does not infer success from partial choices mixed with an error', () => {
    expect(chatToResponsesResponse({ ...basic(), error: { type: 'server_error', message: 'failed' } }, context())).toMatchObject({ ok: false, error: { code: 'invalid_chat_error' } });
  });

  it.each([null, 'error text', {}, { message: 'missing type' }])('rejects malformed error envelope case %#', (error) => {
    expect(chatToResponsesResponse({ error }, context()).ok).toBe(false);
  });

  it('does not invoke error-message accessors or leak allocator/error exceptions', () => {
    let read = false;
    const error = { type: 'server_error', get message() { read = true; throw new Error('private secret'); } };
    expect(chatToResponsesResponse({ error }, context()).ok).toBe(false);
    expect(read).toBe(false);
  });
});

const toolResponse = (content: string | null = null, argumentsText = ' { "city": "北京" }\n') => ({
  ...basic(), choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content,
    tool_calls: [
      { id: 'call_weather', type: 'function', function: { name: 'weather', arguments: argumentsText } },
      { id: 'call_clock', type: 'function', function: { name: 'clock', arguments: '{}' } },
    ],
  } }],
});

describe('P-CR-J2 function calls and ordered output items', () => {
  it('preserves multiple tool IDs, raw argument whitespace and tool-only output order', () => {
    const source = toolResponse();
    const result = chatToResponsesResponse(source, context());
    if (!result.ok) throw new Error('Expected tool conversion');
    expect(result.value.body.output).toMatchObject([
      { type: 'function_call', call_id: 'call_weather', name: 'weather', arguments: ' { "city": "北京" }\n', status: 'completed' },
      { type: 'function_call', call_id: 'call_clock', name: 'clock', arguments: '{}', status: 'completed' },
    ]);
    expect(new Set(result.value.body.output.map((item) => item.id)).size).toBe(2);
    expect(result.value.terminal).toMatchObject({ status: 'completed', reason: 'tool_calls' });
  });

  it('retains an explicitly empty text item before tool items', () => {
    const result = chatToResponsesResponse(toolResponse(''), context());
    if (!result.ok) throw new Error('Expected tool conversion');
    expect(result.value.body.output.map((item) => item.type)).toEqual(['message', 'function_call', 'function_call']);
    expect(result.value.body.output[0]).toMatchObject({ content: [{ type: 'output_text', text: '' }] });
  });

  it('keeps each item ID stable on retries without confusing call IDs and item IDs', () => {
    const ctx = context();
    const first = chatToResponsesResponse(toolResponse('text'), ctx);
    expect(first).toEqual(chatToResponsesResponse(toolResponse('text'), ctx));
    if (!first.ok) return;
    expect(first.value.body.output[1]?.id).not.toBe('call_weather');
  });

  it.each(['', '{', '[]', '"scalar"', 'null'])('rejects invalid completed arguments case %# instead of inventing or dropping calls', (argumentsText) => {
    expect(chatToResponsesResponse(toolResponse(null, argumentsText), context())).toMatchObject({ ok: false, error: { code: 'invalid_tool_arguments' } });
  });

  it('rejects duplicate/unrepresentable tool IDs and allocator collisions', () => {
    const duplicate = toolResponse(); duplicate.choices[0]!.message.tool_calls[1]!.id = 'call_weather';
    expect(chatToResponsesResponse(duplicate, context()).ok).toBe(false);
    const invalid = toolResponse(); invalid.choices[0]!.message.tool_calls[0]!.id = 'bad/id';
    expect(chatToResponsesResponse(invalid, context()).ok).toBe(false);
    expect(chatToResponsesResponse(toolResponse(), { ...context(), idFor: () => 'call_weather' }).ok).toBe(false);
  });

  it('does not manufacture calls for a tool terminal with no payload', () => {
    const source = toolResponse(); source.choices[0]!.message.tool_calls = [];
    expect(chatToResponsesResponse(source, context())).toMatchObject({ ok: false, error: { code: 'missing_tool_calls' } });
  });

  it('rejects tool names with control characters', () => {
    const source = toolResponse(); source.choices[0]!.message.tool_calls[0]!.function.name = 'weather\n';
    expect(chatToResponsesResponse(source, context()).ok).toBe(false);
  });
});
