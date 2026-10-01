import { describe, expect, expectTypeOf, it } from 'vitest';
import { parseChatRequest, parseChatResponse, parseChatStreamChunk } from '../../../packages/apicompat/types/chat.js';
import type { ChatChunk, ChatErrorBody, ChatRequest, ChatResponse } from '../../../packages/apicompat/types/chat.js';

// Original synthetic inputs, not copied from provider recordings or upstream tests.
const basic = () => ({ model: 'synthetic-chat', messages: [{ role: 'user', content: 'hello' }] });

describe('Chat request wire boundary', () => {
  it('accepts the complete sanitized official ordinary Chat response including annotations', () => {
    // Official create Chat completion example, fetched 2026-09-06; IDs/content sanitized.
    // https://developers.openai.com/api/reference/cli/resources/chat/subresources/completions/methods/create
    const response = { id: 'chatcmpl_official_fixture', object: 'chat.completion', created: 1741569952, model: 'gpt-6-astra',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Synthetic greeting.', refusal: null, annotations: [] }, logprobs: null, finish_reason: 'stop' }],
      usage: { prompt_tokens: 19, completion_tokens: 10, total_tokens: 29,
        prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 } }, service_tier: 'default' };
    expect(parseChatResponse(response)).toEqual({ ok: true, value: response });
    const annotated = structuredClone(response) as Record<string, any>;
    annotated.choices[0].message.annotations = [{ type: 'url_citation', url_citation: { start_index: 0, end_index: 9, title: 'Fixture source', url: 'https://example.invalid/source' } }];
    expect(parseChatResponse(annotated).ok).toBe(true);
    for (const annotations of [null, {}, [{ type: 'unknown' }], [{ type: 'url_citation', url_citation: { start_index: 3, end_index: 2, title: 'x', url: 'https://example.invalid' } }]]) {
      annotated.choices[0].message.annotations = annotations;
      expect(parseChatResponse(annotated).ok).toBe(false);
    }
    annotated.choices[0].message.annotations = [];
    annotated.choices[0].message.unknown_field = true;
    expect(parseChatResponse(annotated).ok).toBe(false);
  });
  it('accepts text, system/developer and multimodal multi-turn tool history unchanged', () => {
    const input = {
      ...basic(),
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'instructions' }] },
        { role: 'developer', content: 'format instruction', name: 'app' },
        { role: 'user', content: [
          { type: 'text', text: 'describe' },
          { type: 'image_url', image_url: { url: 'https://example.test/image.png', detail: 'high' } },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ] },
        { role: 'assistant', content: null, tool_calls: [
          { id: 'call-a', type: 'function', function: { name: 'lookup', arguments: '{"q":"a"}' } },
          { id: 'call-b', type: 'function', function: { name: 'lookup', arguments: '' } },
        ] },
        { role: 'tool', tool_call_id: 'call-b', content: [{ type: 'text', text: 'b' }] },
        { role: 'tool', tool_call_id: 'call-a', content: 'a' },
        { role: 'assistant', content: '', reasoning_content: 'private' },
      ],
      tools: [{ type: 'function', function: { name: 'lookup', description: 'lookup', strict: true, parameters: { type: 'object', properties: { q: { type: 'string' } } } } }],
      tool_choice: { type: 'function', function: { name: 'lookup' } }, parallel_tool_calls: true,
      stream: true, stream_options: { include_usage: true }, max_completion_tokens: 128,
      temperature: 0, top_p: 1, stop: ['END'], n: 1, seed: 0,
      frequency_penalty: -2, presence_penalty: 2, metadata: { test: 'synthetic' },
      response_format: { type: 'json_schema', json_schema: { name: 'output', schema: { type: 'object' }, strict: true } },
    };
    const result = parseChatRequest(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(input);
    expectTypeOf(result.value).toEqualTypeOf<ChatRequest>();
  });

  it.each([
    null, [], {}, { ...basic(), model: '' }, { ...basic(), messages: [] },
    { ...basic(), messages: [{ role: 'alien', content: 'x' }] },
    { ...basic(), messages: [{ role: 'user', content: null }] },
    { ...basic(), messages: [{ role: 'assistant' }] },
    { ...basic(), messages: [{ role: 'tool', content: 'x' }] },
    { ...basic(), messages: [{ role: 'tool', tool_call_id: '', content: 'x' }] },
    { ...basic(), messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 7 } }] }] },
    { ...basic(), messages: [{ role: 'system', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] },
    { ...basic(), messages: [{ role: 'assistant', tool_calls: [{ id: 'x', type: 'function', function: { name: 'f', arguments: {} } }] }] },
    { ...basic(), tools: [{ type: 'function', function: { name: 'f', parameters: [] } }] },
    { ...basic(), response_format: { type: 'json_schema', json_schema: { name: 'x' } } },
    { ...basic(), stream: 'true' }, { ...basic(), temperature: 3 }, { ...basic(), top_p: -1 },
    { ...basic(), max_tokens: 0 }, { ...basic(), max_completion_tokens: 1.5 },
    { ...basic(), stop: [42] }, { ...basic(), stop: ['a', 'b', 'c', 'd', 'e'] },
    { ...basic(), stream_options: { include_usage: 'yes' } }, { ...basic(), metadata: { x: 1 } },
    { ...basic(), tool_choice: { type: 'function', function: {} } },
  ])('rejects malformed input %# without coercion', input => {
    const result = parseChatRequest(input);
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_request', code: 'invalid_chat_request' } });
  });

  it('reports the precise unsafe field without reflecting its value', () => {
    const result = parseChatRequest({ ...basic(), messages: [{ role: 'tool', tool_call_id: 19, content: 'secret' }] });
    expect(result).toMatchObject({ ok: false, error: { param: '$.messages[0].tool_call_id' } });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('rejects duplicate tool IDs within one assistant message', () => {
    const call = { id: 'same', type: 'function', function: { name: 'f', arguments: '{}' } };
    expect(parseChatRequest({ ...basic(), messages: [{ role: 'assistant', tool_calls: [call, { ...call, function: { ...call.function } }] }] }))
      .toMatchObject({ ok: false, error: { param: '$.messages[0].tool_calls[1].id' } });
  });

  it('preserves explicit extensions in place, never relaxing known fields', () => {
    const input = { ...basic(), provider_option: { enabled: true, values: [null, 3] } };
    expect(parseChatRequest(input).ok).toBe(false);
    const result = parseChatRequest(input, { allowedExtensions: ['provider_option'] });
    expect(result).toMatchObject({ ok: true, value: input });
    if (result.ok) expect(result.value).toBe(input);
    expect(parseChatRequest({ ...basic(), temperature: 'hot' }, { allowedExtensions: ['temperature'] }).ok).toBe(false);
    expect(parseChatRequest({ ...basic(), messages: [{ role: 'user', content: 'hi', extra: true }] }, { allowedExtensions: ['extra'] }).ok).toBe(false);
    const nested = { ...input, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_hint: { mode: 'provider' } }], extra: true }] };
    expect(parseChatRequest(nested, { unknownFields: 'preserve' })).toEqual({ ok: true, value: nested });
    expect(parseChatRequest({ ...input, stream: 1 }, { unknownFields: 'preserve' }).ok).toBe(false);
    expect(input.provider_option.enabled).toBe(true);
  });

  it('accepts nullable controls, refusal and reasoning-only history without synthesizing content', () => {
    const input = { ...basic(), max_tokens: null, temperature: null, stop: null, service_tier: 'provider-tier', reasoning_effort: 'provider-effort',
      messages: [{ role: 'assistant', refusal: 'declined' }, { role: 'assistant', reasoning: 'private' }] };
    expect(parseChatRequest(input)).toMatchObject({ ok: true, value: input });
  });

  it('leaves model capabilities and cross-turn pairing to later checks', () => {
    expect(parseChatRequest({ ...basic(), max_tokens: 5, max_completion_tokens: 6,
      messages: [{ role: 'tool', tool_call_id: 'external-history-id', content: 'result' }] }).ok).toBe(true);
  });

  it('rejects non-JSON, excessive depth and cycles without executing getters', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    let deep: unknown = {}; for (let i = 0; i < 66; i++) deep = { child: deep };
    const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { throw new Error('getter ran'); } });
    for (const provider_option of [undefined, NaN, Infinity, 1n, () => 0, new Date(), cycle, deep, getter, new Array(2)]) {
      expect(parseChatRequest({ ...basic(), provider_option }, { allowedExtensions: ['provider_option'] }).ok).toBe(false);
    }
    expect(parseChatRequest(JSON.parse('{"model":"x","messages":[{"role":"user","content":"x"}],"__proto__":{}}')).ok).toBe(false);
  });
});

it('represents JSON response, incremental tool arguments, usage-only chunk and error wire shapes', () => {
  const response: ChatResponse = { id: 'r', object: 'chat.completion', created: 0, model: 'm', choices: [
    { index: 0, message: { role: 'assistant', content: null, refusal: 'no' }, finish_reason: 'provider_unknown' },
  ], usage: { prompt_tokens: 0, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 2 } } };
  const chunk: ChatChunk = { id: 'r', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [
    { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"' } }] }, finish_reason: null },
  ] };
  const usageOnly: ChatChunk = { ...chunk, choices: [], usage: { completion_tokens: 0 } };
  const error: ChatErrorBody = { error: { message: 'invalid request', type: 'invalid_request_error', param: null, code: 'bad_input' } };
  expect(response.choices[0]?.finish_reason).toBe('provider_unknown');
  expect(parseChatResponse(response)).toEqual({ ok: true, value: response });
  expect(parseChatStreamChunk(chunk)).toEqual({ ok: true, value: chunk });
  expect(parseChatStreamChunk(usageOnly)).toEqual({ ok: true, value: usageOnly });
  expect(chunk.choices[0]?.delta.tool_calls?.[0]?.index).toBe(0);
  expect(usageOnly.choices).toEqual([]);
  expect(error.error.param).toBeNull();
});

describe('Chat response and stream parsers', () => {
  const response = () => ({ id: 'r', object: 'chat.completion', created: 0, model: 'm', choices: [
    { index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' },
  ] });
  const chunk = () => ({ id: 'r', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [
    { index: 0, delta: {}, finish_reason: null },
  ] });
  it.each([
    null, {}, { ...response(), object: 'chat.completion.chunk' }, { ...response(), choices: [] },
    { ...response(), created: -1 }, { ...response(), usage: { prompt_tokens: 1.5 } },
    { ...response(), choices: [{ index: 0, message: { role: 'user', content: 'x' }, finish_reason: 'stop' }] },
    { ...response(), choices: [{ index: -1, message: { role: 'assistant', content: null }, finish_reason: null }] },
  ])('rejects malformed complete response %#', input => {
    expect(parseChatResponse(input)).toMatchObject({ ok: false, error: { kind: 'invalid_response' } });
  });
  it.each([
    '[DONE]', { ...chunk(), object: 'chat.completion' },
    { ...chunk(), choices: [{ index: 0, delta: { content: 3 }, finish_reason: null }] },
    { ...chunk(), choices: [{ index: 0, delta: { role: 'user' }, finish_reason: null }] },
    { ...chunk(), choices: [{ index: 0, delta: { tool_calls: [{ function: { arguments: '{' } }] }, finish_reason: null }] },
    { ...chunk(), choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: {} } }] }, finish_reason: null }] },
    { ...chunk(), usage: { completion_tokens_details: { reasoning_tokens: -1 } } },
  ])('rejects malformed chunk %#', input => {
    expect(parseChatStreamChunk(input)).toMatchObject({ ok: false, error: { kind: 'invalid_response' } });
  });
  it('applies reject/preserve at nested response and delta boundaries', () => {
    const output = { ...response(), choices: [{ index: 0, message: { role: 'assistant', content: 'x', vendor: [true] }, finish_reason: 'new_reason' }] };
    expect(parseChatResponse(output).ok).toBe(false);
    expect(parseChatResponse(output, { unknownFields: 'preserve' })).toEqual({ ok: true, value: output });
    const event = { ...chunk(), choices: [{ index: 0, delta: { vendor: { arbitrary: null } }, finish_reason: null }] };
    expect(parseChatStreamChunk(event).ok).toBe(false);
    expect(parseChatStreamChunk(event, { unknownFields: 'preserve' })).toEqual({ ok: true, value: event });
    expect(parseChatStreamChunk({ ...event, usage: { prompt_tokens: 'bad' } }, { unknownFields: 'preserve' }).ok).toBe(false);
    expect(parseChatResponse({ ...output, vendor: undefined }, { unknownFields: 'preserve' }).ok).toBe(false);
  });
});
