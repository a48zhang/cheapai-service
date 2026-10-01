import { describe, expect, it } from 'vitest';
import { chatRequestAdapter, chatResponseAdapter, createChatPassthrough } from '../../../packages/apicompat/passthrough/chat.js';
import type { ResponseContext } from '../../../packages/apicompat/types/adapter.js';

const context: ResponseContext = { targetModel: 'public/model', identity: { responseId: 'resp_stable' }, createdAt: 99,
  idFor() { throw new Error('Native tool IDs must not be reallocated.'); } };
const response = { id: 'upstream_response', object: 'chat.completion', created: 17, model: 'provider/model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, prompt_tokens_details: { cached_tokens: 4 } } };

describe('complete official Chat response regression', () => {
  it('preserves every standard ordinary response field, including annotations and detailed usage', () => {
    // Official create example fetched 2026-09-06; only id/content sanitized.
    // https://developers.openai.com/api/reference/cli/resources/chat/subresources/completions/methods/create
    const official = { id: 'chatcmpl_official_fixture', object: 'chat.completion', created: 1741569952, model: 'gpt-6-astra',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Synthetic greeting.', refusal: null, annotations: [] }, logprobs: null, finish_reason: 'stop' }],
      usage: { prompt_tokens: 19, completion_tokens: 10, total_tokens: 29, prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 } }, service_tier: 'default' };
    expect(chatResponseAdapter.convert(official, context)).toMatchObject({ ok: true, value: {
      body: { ...official, id: context.identity.responseId, model: context.targetModel }, terminal: { status: 'completed', reason: 'stop' },
    } });
    const citation = { type: 'url_citation', url_citation: { start_index: 0, end_index: 9, title: 'Fixture', url: 'https://example.invalid/source' } };
    const annotated = { ...official, choices: [{ ...official.choices[0]!, message: { ...official.choices[0]!.message, annotations: [citation] } }] };
    expect(chatResponseAdapter.convert(annotated, context)).toMatchObject({ ok: true, value: { body: { choices: [{ message: { annotations: [citation] } }] } } });
    expect(chatResponseAdapter.convert({ ...official, unknown_standard_claim: {} }, context).ok).toBe(false);
  });
});

describe('Chat same-protocol request passthrough', () => {
  it('only remaps model while preserving multi-turn tools, images, constraints and stream flags', () => {
    const original = { model: 'public/model', stream: true, stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: 'Use the supplied tools.' },
        { role: 'user', content: [{ type: 'text', text: 'Find this.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==', detail: 'high' } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_native', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
        { role: 'tool', tool_call_id: 'call_native', content: 'Result' }, { role: 'user', content: 'Continue.' },
      ], tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false }, strict: true } }],
      tool_choice: { type: 'function', function: { name: 'lookup' } }, parallel_tool_calls: false,
      response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } },
      max_completion_tokens: 64, temperature: 0, stop: ['END'],
    };
    const before = structuredClone(original);
    const result = chatRequestAdapter.convert(original, { targetModel: 'provider/model' });
    expect(result).toEqual({ ok: true, value: { ...original, model: 'provider/model' } }); expect(original).toEqual(before);
    if (result.ok) expect(result.value.messages).not.toBe(original.messages);
  });

  it('preserves explicitly allowed JSON extension data and snapshots the allowlist', () => {
    const allowlist = ['vendor_options'];
    const adapters = createChatPassthrough({ requestAllowedExtensions: allowlist }); allowlist.push('later');
    const body = { model: 'm', messages: [{ role: 'user', content: 'hello' }], vendor_options: { mode: 'fast', budget: 0, flags: [true, null] } };
    expect(adapters.request.convert(body, { targetModel: 'upstream' })).toEqual({ ok: true, value: { ...body, model: 'upstream' } });
    expect(adapters.request.convert({ ...body, later: true }, { targetModel: 'm' }).ok).toBe(false);
    expect(chatRequestAdapter.convert(body, { targetModel: 'm' }).ok).toBe(false);
  });

  it.each(['authorization', 'api_key', 'headers', 'cookie', 'client_secret'])('rejects credential-like extension %s even when allowlisted', key => {
    const adapters = createChatPassthrough({ requestAllowedExtensions: [key] });
    expect(adapters.request.convert({ model: 'm', messages: [{ role: 'user', content: 'x' }], [key]: 'secret' }, { targetModel: 'u' })).toMatchObject({ ok: false, error: { kind: 'unsupported_feature' } });
  });

  it.each(['Authorization', 'api_token', 'token', 'private-key'])('rejects credential key %s nested inside allowed extension data', key => {
    const adapters = createChatPassthrough({ requestAllowedExtensions: ['vendor_options'] });
    expect(adapters.request.convert({ model: 'm', messages: [{ role: 'user', content: 'x' }], vendor_options: { nested: [{ [key]: 'secret' }] } }, { targetModel: 'u' })).toMatchObject({ ok: false, error: { code: 'unsafe_chat_extension' } });
  });

  it('keeps JSON schema field names as content rather than mistaking them for transport headers', () => {
    const body = { model: 'm', messages: [{ role: 'user', content: 'Explain authorization.' }], tools: [{ type: 'function', function: {
      name: 'validate', parameters: { type: 'object', properties: { authorization: { type: 'string' } } },
    } }] };
    expect(chatRequestAdapter.convert(body, { targetModel: 'u' }).ok).toBe(true);
  });

  it.each([
    { model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'computer' }] },
    { model: 'm', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x', detail: 'invalid' } }] }] },
    { model: 'm', messages: [{ role: 'user', content: 'x', vendor_hint: true }] },
  ])('rejects unsupported tools or malformed/nested constraints without dropping them %#', body => {
    const before = structuredClone(body); expect(chatRequestAdapter.convert(body, { targetModel: 'u' }).ok).toBe(false); expect(body).toEqual(before);
  });

  it('rejects non-JSON extension values and invalid target model', () => {
    const adapters = createChatPassthrough({ requestAllowedExtensions: ['extension'] });
    expect(adapters.request.convert({ model: 'm', messages: [{ role: 'user', content: 'x' }], extension: () => 1 }, { targetModel: 'u' }).ok).toBe(false);
    expect(chatRequestAdapter.convert({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, { targetModel: '' }).ok).toBe(false);
  });
});

describe('Chat same-protocol JSON response passthrough', () => {
  it('only remaps model and stable response ID, preserving created timestamp and raw usage presentation', () => {
    const before = structuredClone(response); const result = chatResponseAdapter.convert(response, context);
    expect(result).toMatchObject({ ok: true, value: { body: { ...response, id: 'resp_stable', model: 'public/model' },
      identity: { responseId: 'resp_stable', upstreamResponseId: 'upstream_response' }, terminal: { status: 'completed', reason: 'stop' } } });
    expect(response).toEqual(before);
    if (result.ok) {
      expect(result.value.body.created).toBe(17); expect(result.value.body.usage).toEqual(response.usage);
      expect(result.value.body.usage).not.toBe(response.usage); expect(result.value).not.toHaveProperty('counts');
    }
  });

  it('preserves native tool IDs and parallel calls while using P11 tool completion semantics', () => {
    const body = { ...response, choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
      { id: 'call_original_1', type: 'function', function: { name: 'f', arguments: '{"x":1}' } },
      { id: 'call_original_2', type: 'function', function: { name: 'f', arguments: '{"x":2}' } },
    ] } }] };
    const result = chatResponseAdapter.convert(body, context);
    expect(result).toMatchObject({ ok: true, value: { body: { choices: body.choices }, terminal: { status: 'completed', reason: 'tool_calls' } } });
  });

  it.each([['length', 'length'], ['content_filter', 'content_filter'], ['future_provider_reason', 'unknown']])('keeps native reason %s and reports incomplete via P11', (reason, normalized) => {
    const body = { ...response, choices: [{ ...response.choices[0], finish_reason: reason }] };
    expect(chatResponseAdapter.convert(body, context)).toMatchObject({ ok: true, value: { body: { choices: [{ finish_reason: reason }] }, terminal: { status: 'incomplete', reason: normalized } } });
  });

  it('retains refusal content and prevents a successful choice from hiding another truncated choice', () => {
    const refusal = { ...response, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: null, refusal: 'Cannot comply.' } }] };
    expect(chatResponseAdapter.convert(refusal, context)).toMatchObject({ ok: true, value: { terminal: { status: 'incomplete', reason: 'refusal' } } });
    const multi = { ...response, choices: [...response.choices, { ...structuredClone(response.choices[0]), index: 1, finish_reason: 'length' }] };
    expect(chatResponseAdapter.convert(multi, context)).toMatchObject({ ok: true, value: { terminal: { status: 'incomplete', reason: 'length' } } });
  });

  it('preserves only explicitly allowed response extensions and does not copy credentials', () => {
    const adapters = createChatPassthrough({ responseAllowedExtensions: ['provider_metadata'] });
    const body = { ...response, provider_metadata: { routing_tier: 'fast' } };
    expect(adapters.response.convert(body, context)).toMatchObject({ ok: true, value: { body: { provider_metadata: body.provider_metadata } } });
    expect(chatResponseAdapter.convert(body, context).ok).toBe(false);
    expect(adapters.response.convert({ ...body, provider_metadata: { response_headers: { 'Set-Cookie': 'secret' } } }, context).ok).toBe(false);
  });

  it('rejects identity mismatches and chunk/error bodies instead of pretending they are JSON success', () => {
    expect(chatResponseAdapter.convert(response, { ...context, identity: { responseId: 'stable', upstreamResponseId: 'wrong' } }).ok).toBe(false);
    expect(chatResponseAdapter.convert(response, { ...context, identity: { responseId: '' } }).ok).toBe(false);
    expect(chatResponseAdapter.convert({ ...response, object: 'chat.completion.chunk' }, context).ok).toBe(false);
    const adapters = createChatPassthrough();
    const failed = adapters.response.convert({ error: { message: 'PRIVATE PROVIDER BODY' } }, context);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(JSON.stringify(adapters.error.convert(failed.error))).not.toContain('PRIVATE PROVIDER BODY');
  });
});
