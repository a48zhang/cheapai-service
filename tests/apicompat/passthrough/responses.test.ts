import { describe, expect, it } from 'vitest';
import { createResponsesPassthrough, responsesRequestAdapter, responsesResponseAdapter } from '../../../packages/apicompat/passthrough/responses.js';
import { createResponsesStreamSession } from '../../../packages/apicompat/passthrough/responses-stream.js';
import type { ResponseContext } from '../../../packages/apicompat/types/adapter.js';

const context: ResponseContext = { targetModel: 'public-model', identity: { responseId: 'resp_fixed' }, createdAt: 999,
  idFor() { throw new Error('Native item/tool IDs must stay unchanged.'); } };
const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 3 } };
const response = { object: 'response', id: 'upstream_id', model: 'provider-model', created_at: 12, status: 'completed', output: [
  { type: 'reasoning', id: 'rs_native', summary: [{ type: 'summary_text', text: 'Summary' }], encrypted_content: 'opaque-native-data' },
  { type: 'message', id: 'msg_native', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello', annotations: [] }] },
], usage, error: null, incomplete_details: null };

// Full ordinary response shape from the official create-response example, fetched
// 2026-09-06. Only IDs/text are replaced with synthetic values; retain all standard
// echo fields (not a minimized hand-built success fixture).
// https://developers.openai.com/api/reference/typescript/resources/responses/methods/create
// Pinned sub2api ab99d56... types.go:372 and bridge.go:1265/1603 also preserve service_tier.
const officialStandardResponse = {
  id: 'resp_official_fixture', object: 'response', created_at: 1752100704, status: 'completed', completed_at: 1752100705,
  background: false, error: null, incomplete_details: null, instructions: null, max_output_tokens: null, max_tool_calls: null,
  model: 'gpt-6-astra', output: [{ id: 'msg_official_fixture', type: 'message', status: 'completed', content: [
    { type: 'output_text', annotations: [], logprobs: [], text: 'Synthetic document summary.' },
  ], role: 'assistant' }], parallel_tool_calls: true, previous_response_id: null, reasoning: { effort: null, summary: null },
  service_tier: 'default', store: true, temperature: 1.0, text: { format: { type: 'text' } }, tool_choice: 'auto', tools: [],
  top_logprobs: 0, top_p: 1.0, truncation: 'disabled', usage: {
    input_tokens: 8438, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 398,
    output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 8836,
  }, user: null, metadata: {},
};

describe('official standard Responses JSON/terminal compatibility', () => {
  it('preserves the complete official ordinary response, changing only root public identity/model', () => {
    const result = responsesResponseAdapter.convert(officialStandardResponse, context);
    expect(result).toMatchObject({ ok: true, value: { terminal: { status: 'completed', reason: 'stop' } } });
    if (!result.ok) throw new Error('Official standard response rejected');
    expect(result.value.body).toEqual({ ...officialStandardResponse, id: context.identity.responseId, model: context.targetModel });
    expect(result.value.body.usage).toEqual(officialStandardResponse.usage);
  });
  it('accepts validated nullable echoes, function/structured-output configuration and native message phase', () => {
    const variant = { ...officialStandardResponse, background: null, completed_at: null, temperature: null, top_p: null, top_logprobs: null,
      metadata: { test: 'fixture' }, service_tier: 'priority', reasoning: { effort: 'high', summary: 'auto' },
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} }, strict: true }],
      tool_choice: { type: 'function', name: 'lookup' }, text: { verbosity: 'medium', format: { type: 'json_schema', name: 'answer', schema: { type: 'object' }, strict: null } },
      instructions: [{ role: 'developer', content: 'Synthetic instruction.' }], conversation: { id: 'conv_fixture' },
      prompt_cache_key: 'cache-fixture', prompt_cache_retention: '24h', prompt_cache_options: { mode: 'implicit', ttl: '30m' }, safety_identifier: 'fixture-user',
      output: officialStandardResponse.output.map(item => ({ ...item, phase: 'final_answer' })),
    };
    expect(responsesResponseAdapter.convert(variant, context)).toMatchObject({ ok: true, value: { body: { service_tier: 'priority', output: [{ phase: 'final_answer' }] } } });
  });
  it('rejects malformed known echoes and unknown fields even when listed as extensions', () => {
    for (const patch of [{ service_tier: {} }, { service_tier: 'imaginary-tier' }, { parallel_tool_calls: 'true' }, { background: 'false' },
      { temperature: 3 }, { top_p: -1 }, { max_output_tokens: -1 }, { completed_at: 'yesterday' }, { top_logprobs: 21 },
      { metadata: { key: 12 } }, { tools: { type: 'function' } }, { reasoning: { summary: {} } },
      { text: { format: { type: 'text', unknown: true } } }, { unknown_echo: true }, { authorization: 'secret' }]) {
      expect(responsesResponseAdapter.convert({ ...officialStandardResponse, ...patch }, context).ok).toBe(false);
    }
    expect(createResponsesPassthrough({ responseAllowedExtensions: ['service_tier'] }).response.convert({ ...officialStandardResponse, service_tier: {} }, context).ok).toBe(false);
    // Accepting background metadata must not enable unsupported background requests.
    expect(responsesRequestAdapter.convert({ model: 'x', input: 'hello', background: true }, { targetModel: 'y' }).ok).toBe(false);
  });
  it('passes the full standard response through P19 created/completed event validation', () => {
    const created = createResponsesStreamSession(context, { unknownEventPolicy: 'reject', maxBufferedBytes: 65536 });
    if (!created.ok) throw new Error('Invalid stream test context');
    const finalMessage = officialStandardResponse.output[0]!;
    const finalPart = finalMessage.content[0]!;
    const events = [
      { type: 'response.created', response: { ...officialStandardResponse, status: 'in_progress', completed_at: null, output: [], usage: null } },
      { type: 'response.output_item.added', output_index: 0, item: { ...finalMessage, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', output_index: 0, item_id: finalMessage.id, content_index: 0, part: { ...finalPart, text: '' } },
      { type: 'response.output_text.delta', output_index: 0, item_id: finalMessage.id, content_index: 0, delta: finalPart.text },
      { type: 'response.output_text.done', output_index: 0, item_id: finalMessage.id, content_index: 0, text: finalPart.text },
      { type: 'response.content_part.done', output_index: 0, item_id: finalMessage.id, content_index: 0, part: finalPart },
      { type: 'response.output_item.done', output_index: 0, item: finalMessage },
      { type: 'response.completed', response: officialStandardResponse },
    ];
    for (const [sequence_number, event] of events.entries()) {
      const step = created.value.push({ event: event.type, data: JSON.stringify({ ...event, sequence_number }) });
      expect(step.events[0]?.event).toBe(event.type);
      if (sequence_number === events.length - 1) {
        expect(step.terminal).toMatchObject({ status: 'completed', reason: 'stop' });
        expect(JSON.parse(step.events[0]!.data).response).toEqual({ ...officialStandardResponse, id: context.identity.responseId, model: context.targetModel });
        expect(step.usage).toMatchObject({ quality: 'complete', counts: { inputTokens: 8438, outputTokens: 398 } });
      }
    }
  });
});

describe('Responses request passthrough', () => {
  it('preserves stream, complete history, native references, reasoning and tool constraints; only model changes', () => {
    const request = { model: 'public-model', stream: true, instructions: 'Continue.', previous_response_id: 'resp_requires_G13', input: [
      { role: 'user', content: [{ type: 'input_text', text: 'Describe' }, { type: 'input_image', image_url: 'data:image/png;base64,YQ==' }] },
      { type: 'reasoning', id: 'rs_native', summary: [], encrypted_content: 'opaque' },
      { type: 'function_call', call_id: 'call_native', id: 'fc_native', name: 'lookup', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_native', output: 'Result' },
      { type: 'item_reference', id: 'item_requires_G13' },
    ], tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} }, strict: true }],
    tool_choice: { type: 'function', name: 'lookup' }, reasoning: { effort: 'low' }, text: { format: { type: 'json_object' } } };
    const before = structuredClone(request);
    expect(responsesRequestAdapter.convert(request, { targetModel: 'provider-model' })).toEqual({ ok: true, value: { ...request, model: 'provider-model' } });
    expect(request).toEqual(before);
  });

  it('retains references without claiming ownership validation', () => {
    expect(responsesRequestAdapter.convert({ model: 'm', previous_response_id: 'other_user_id' }, { targetModel: 'u' }).ok).toBe(true);
    expect(responsesRequestAdapter.convert({ model: 'm', input: 'x', previous_response_id: null }, { targetModel: 'u' })).toMatchObject({ ok: true, value: { previous_response_id: null } });
  });

  it('preserves explicit extensions but never lets an allowlist bypass known field checks', () => {
    const names = ['vendor_options', 'stream']; const adapters = createResponsesPassthrough({ requestAllowedExtensions: names }); names.push('late');
    const request = { model: 'm', input: 'x', vendor_options: { mode: 'fast' } };
    expect(adapters.request.convert(request, { targetModel: 'u' })).toMatchObject({ ok: true, value: { vendor_options: request.vendor_options } });
    expect(adapters.request.convert({ ...request, stream: 'yes' }, { targetModel: 'u' }).ok).toBe(false);
    expect(adapters.request.convert({ ...request, late: true }, { targetModel: 'u' }).ok).toBe(false);
    expect(responsesRequestAdapter.convert(request, { targetModel: 'u' }).ok).toBe(false);
  });

  it.each([
    { model: 'm', input: 'x', background: true },
    { model: 'm', input: [{ type: 'computer_call' }] },
    { model: 'm', input: 'x', tools: [{ type: 'web_search' }] },
    { model: 'm', input: [{ role: 'user', content: 'x', vendor_hint: true }] },
  ])('rejects unsupported background work or unrecognized nested features %#', value => {
    expect(responsesRequestAdapter.convert(value, { targetModel: 'u' }).ok).toBe(false);
  });

  it('rejects credentials hidden within allowed extension objects', () => {
    const adapters = createResponsesPassthrough({ requestAllowedExtensions: ['vendor_options'] });
    expect(adapters.request.convert({ model: 'm', input: 'x', vendor_options: { headers: { authorization: 'secret' } } }, { targetModel: 'u' })).toMatchObject({ ok: false, error: { kind: 'unsupported_feature' } });
  });
});

describe('Responses ordinary JSON passthrough', () => {
  it('only changes root model/ID, preserving item IDs, timestamp, reasoning and usage', () => {
    const before = structuredClone(response); const result = responsesResponseAdapter.convert(response, context);
    expect(result).toMatchObject({ ok: true, value: { body: { ...response, id: 'resp_fixed', model: 'public-model' },
      identity: { responseId: 'resp_fixed', upstreamResponseId: 'upstream_id' }, terminal: { status: 'completed', reason: 'stop' } } });
    expect(response).toEqual(before);
    if (result.ok) { expect(result.value.body.output).not.toBe(response.output); expect(result.value.body.usage).toEqual(usage); expect(result.value).not.toHaveProperty('counts'); }
  });

  it('preserves parallel function item/call IDs and reports tool completion via P11', () => {
    const output = [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'f', arguments: '{"a":1}', status: 'completed' },
      { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'f', arguments: '{"a":2}', status: 'completed' }];
    expect(responsesResponseAdapter.convert({ ...response, output }, context)).toMatchObject({ ok: true, value: { body: { output }, terminal: { status: 'completed', reason: 'tool_calls' } } });
  });

  it('maps incomplete/refusal/cancelled outcomes without rewriting native status or payloads', () => {
    expect(responsesResponseAdapter.convert({ ...response, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }, context)).toMatchObject({ ok: true, value: { body: { status: 'incomplete' }, terminal: { status: 'incomplete', reason: 'length' } } });
    const refusal = { ...response, output: [{ type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'Cannot help.' }] }] };
    expect(responsesResponseAdapter.convert(refusal, context)).toMatchObject({ ok: true, value: { terminal: { status: 'incomplete', reason: 'refusal' } } });
    expect(responsesResponseAdapter.convert({ ...response, status: 'cancelled' }, context)).toMatchObject({ ok: true, value: { terminal: { status: 'cancelled' } } });
  });

  it('retains failed response/items/usage but encodes raw provider errors through P06', () => {
    const result = responsesResponseAdapter.convert({ ...response, status: 'failed', error: { code: 'PRIVATE_CODE', message: 'Bearer PRIVATE_TOKEN' } }, context);
    expect(result).toMatchObject({ ok: true, value: { body: { status: 'failed', usage, error: { code: 'upstream_error' } }, terminal: { status: 'failed' } } });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_CODE|PRIVATE_TOKEN/);
  });

  it('preserves allowed top-level response extensions and blocks extension credentials', () => {
    const adapters = createResponsesPassthrough({ responseAllowedExtensions: ['provider_metadata'] });
    expect(adapters.response.convert({ ...response, provider_metadata: { tier: 'fast' } }, context)).toMatchObject({ ok: true, value: { body: { provider_metadata: { tier: 'fast' } } } });
    expect(adapters.response.convert({ ...response, provider_metadata: { api_key: 'private' } }, context).ok).toBe(false);
  });

  it.each([
    { ...response, status: 'in_progress' }, { ...response, status: 'queued' },
    { ...response, status: { toString: 'not callable' } },
    { ...response, output: [{ type: 'unknown_item' }] },
    { ...response, output: [{ type: 'message', id: 'm', role: 'user', status: 'completed', content: [] }] },
    { ...response, output: [{ type: 'function_call', call_id: 'c', name: 'f', arguments: {} }] },
    { ...response, output: [{ type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: 1 }] }] },
    { ...response, usage: { input_tokens: -1, output_tokens: 2, total_tokens: 1 } },
    { ...response, usage: { input_tokens: 1, output_tokens: 2 } },
    { ...response, previous_response_id: 123 },
    { ...response, object: 'response.completed' },
  ])('rejects nonterminal/event/malformed wire bodies %#', value => {
    expect(responsesResponseAdapter.convert(value, context).ok).toBe(false);
  });

  it('rejects upstream identity mismatch and uses the shared error adapter', () => {
    const adapters = createResponsesPassthrough();
    const result = adapters.response.convert(response, { ...context, identity: { responseId: 'fixed', upstreamResponseId: 'wrong' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(adapters.error.convert(result.error)).toMatchObject({ error: { type: 'server_error', code: 'invalid_response' } });
  });
});
