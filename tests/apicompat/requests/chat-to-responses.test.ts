import { describe, expect, it, vi } from "vitest";
import { chatToResponsesRequest, chatToResponsesRequestAdapter } from "../../../packages/apicompat/requests/chat-to-responses.js";
import { validateResponsesRequest } from "../../../packages/apicompat/types/responses.js";
import type { ChatRequest } from "../../../packages/apicompat/types/chat.js";
import type { ResponsesInputMessage } from "../../../packages/apicompat/types/responses.js";

// Original synthetic examples. No upstream test/fixture or provider recording copied.
const basic = (): ChatRequest => ({ model: "public-model", messages: [{ role: "user", content: "Hello" }] });
const context = { targetModel: "provider-model" };

describe("Chat -> Responses Q1 text request conversion", () => {
  it("implements the direct RequestAdapter contract and replaces the public model", () => {
    expect(chatToResponsesRequestAdapter.from).toBe("chat");
    expect(chatToResponsesRequestAdapter.to).toBe("responses");
    const result = chatToResponsesRequestAdapter.convert(basic(), context);
    expect(result).toEqual({ ok: true, value: { model: "provider-model", input: [{ type: "message", role: "user", content: "Hello" }] } });
    if (result.ok) expect(validateResponsesRequest(result.value).ok).toBe(true);
  });

  it("preserves separate system/developer instructions in their original history positions", () => {
    const input: ChatRequest = { model: "public-model", messages: [
      { role: "system", content: "System level instruction" },
      { role: "developer", content: "Developer level instruction" },
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "developer", content: "Later developer instruction" },
      { role: "system", content: "Later system instruction" },
      { role: "user", content: "Follow-up" },
    ] };
    const result = chatToResponsesRequest(input, context);
    expect(result).toEqual({ ok: true, value: { model: context.targetModel, input: [
      { type: "message", role: "system", content: "System level instruction" },
      { type: "message", role: "developer", content: "Developer level instruction" },
      { type: "message", role: "user", content: "First question" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "First answer", annotations: [] }] },
      { type: "message", role: "developer", content: "Later developer instruction" },
      { type: "message", role: "system", content: "Later system instruction" },
      { type: "message", role: "user", content: "Follow-up" },
    ] } });
    if (result.ok) {
      expect(Object.hasOwn(result.value, "instructions")).toBe(false);
      expect(validateResponsesRequest(result.value).ok).toBe(true);
    }
  });

  it("keeps Unicode, whitespace, empty text and every content-block boundary", () => {
    const input: ChatRequest = { model: "public-model", messages: [
      { role: "system", content: [{ type: "text", text: " 规则一\n" }, { type: "text", text: "" }] },
      { role: "developer", content: [{ type: "text", text: "规则二🧪" }] },
      { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
      { role: "assistant", content: [{ type: "text", text: "甲" }, { type: "text", text: "" }, { type: "text", text: "乙" }] },
      { role: "user", content: "" }, { role: "assistant", content: "" },
    ] };
    const result = chatToResponsesRequest(input, context);
    expect(result).toEqual({ ok: true, value: { model: context.targetModel, input: [
      { type: "message", role: "system", content: [{ type: "input_text", text: " 规则一\n" }, { type: "input_text", text: "" }] },
      { type: "message", role: "developer", content: [{ type: "input_text", text: "规则二🧪" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "a" }, { type: "input_text", text: "b" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "甲", annotations: [] }, { type: "output_text", text: "", annotations: [] }, { type: "output_text", text: "乙", annotations: [] }] },
      { type: "message", role: "user", content: "" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "", annotations: [] }] },
    ] } });
    if (result.ok) expect(validateResponsesRequest(result.value).ok).toBe(true);
  });

  it.each([false, true])("retains explicit stream=%s without forcing provider options", stream => {
    const result = chatToResponsesRequest({ ...basic(), stream }, context);
    expect(result).toMatchObject({ ok: true, value: { stream } });
    if (result.ok) {
      expect(Object.keys(result.value).sort()).toEqual(["input", "model", "stream"]);
    }
  });

  it("does not mutate or reuse mutable source message/content containers", () => {
    const input: ChatRequest = { model: "public-model", messages: [{ role: "user", content: [{ type: "text", text: "source" }] }] };
    const original = structuredClone(input);
    const result = chatToResponsesRequest(input, context);
    expect(input).toEqual(original);
    if (!result.ok) throw new Error("Expected synthetic text request to convert");
    const items = result.value.input as ResponsesInputMessage[];
    expect(items).not.toBe(input.messages);
    expect(items[0]).not.toBe(input.messages[0]);
    expect(items[0]?.content).not.toBe(input.messages[0]?.content);
    expect(Object.hasOwn(result.value, "stream")).toBe(false);
  });

  it("does not collapse consecutive same-role messages or require an alternating history", () => {
    const input: ChatRequest = { model: "public-model", messages: [{ role: "user", content: "one" }, { role: "user", content: "two" }, { role: "assistant", content: "three" }] };
    const result = chatToResponsesRequest(input, context);
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.value.input as ResponsesInputMessage[]).map(message => message.role)).toEqual(["user", "user", "assistant"]);
  });
});

describe('P-CR-Q3 images', () => {
  const request = (url: string, detail?: 'auto' | 'low' | 'high') => ({ model: 'm', messages: [{ role: 'user', content: [
    { type: 'text', text: 'before' }, { type: 'image_url', image_url: { url, ...(detail ? { detail } : {}) } }, { type: 'text', text: 'after' },
  ] }] });
  const policy = { channelCapabilities: { protocol: 'responses' as const, features: ['image_url', 'image_base64', 'image_detail'] as const } };
  it.each(['auto', 'low', 'high'] as const)('preserves detail %s and URL without a network fetch', detail => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('no fetch'); });
    try {
      const result = chatToResponsesRequest(request('https://image.example/x', detail), context, policy);
      expect(result).toMatchObject({ ok: true, value: { input: [{ content: [{ text: 'before' }, { type: 'input_image', image_url: 'https://image.example/x', detail }, { text: 'after' }] }] } });
      if (result.ok) expect(validateResponsesRequest(result.value).ok).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it.each(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'])('preserves %s declared data URL', mime => {
    const url = `data:${mime};base64,AQID`;
    expect(chatToResponsesRequest(request(url), context, policy)).toMatchObject({ ok: true, value: { input: [{ content: [{ text: 'before' }, { image_url: url }, { text: 'after' }] }] } });
  });
  it('preserves HTTP image URLs with query and fragment', () => {
    const url = 'http://images.local/photo?format=original#part';
    expect(chatToResponsesRequest(request(url), context)).toMatchObject({ ok: true, value: { input: [{ content: [{ text: 'before' }, { image_url: url }, { text: 'after' }] }] } });
  });
  it('preserves image transport and detail without capability declarations', () => {
    expect(chatToResponsesRequest(request('https://image.example/x'), context).ok).toBe(true);
    expect(chatToResponsesRequest(request('https://image.example/x', 'high'), context, { channelCapabilities: { protocol: 'responses', features: ['image_url'] } }).ok).toBe(true);
  });
  it.each(['data:image/png;base64,AR==', 'data:image/png;base64,', 'file:///x', 'https://u:p@image.example/x'])('rejects malformed/unrepresentable envelope %#', url => {
    expect(chatToResponsesRequest(request(url), context, policy).ok).toBe(false);
  });
});

describe("Chat -> Responses Q1 rejects later-node scope", () => {
  it.each([
    { seed: 0 }, { frequency_penalty: 0 }, { presence_penalty: 0 },
    { service_tier: "auto" }, { user: "fixture-user" }, { metadata: { purpose: "fixture" } },
    { instructions: "native extension" }, { vendor_hint: { opaque: "SENSITIVE" } },
  ])("rejects unimplemented top-level field %# with a safe field path", patch => {
    const result = chatToResponsesRequest({ ...basic(), ...patch }, context);
    expect(result).toMatchObject({ ok: false, error: { kind: "unsupported_feature", code: "unsupported_chat_to_responses_request", param: `$.${Object.keys(patch)[0]}` } });
    expect(JSON.stringify(result)).not.toContain("SENSITIVE");
  });

  it.each([
    { role: "user", content: "Hi", name: "named-speaker" },
    { role: "user", content: "Hi", vendor_hint: "SENSITIVE" },
  ])("rejects unimplemented history feature %# rather than erasing it", message => {
    const result = chatToResponsesRequest({ ...basic(), messages: [message] }, context);
    expect(result).toMatchObject({ ok: false, error: { kind: "unsupported_feature" } });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_REASONING|SENSITIVE/);
  });

  it("propagates native Chat parser failures before conversion", () => {
    expect(chatToResponsesRequest({ ...basic(), messages: [{ role: "user", content: 1 }] }, context))
      .toMatchObject({ ok: false, error: { kind: "invalid_request" } });
  });

  it("rejects a blank target model", () => {
    expect(chatToResponsesRequest(basic(), { targetModel: " \n " })).toMatchObject({ ok: false, error: { code: "invalid_target_model", param: "context.targetModel" } });
  });
});

describe('P-CR-Q6 portable options and explicit cache boundaries', () => {
  const policy = { channelCapabilities: { protocol: 'responses' as const,
    features: ['streaming', 'stream_usage', 'refusal_history', 'cache_control', 'metadata', 'service_tier'] as const,
    nativeExtensions: [{ scope: 'content' as const, name: 'cache_control' }, { scope: 'request' as const, name: 'vendor_hint' }],
  } };
  it.each([true, false])('maps upstream streaming with include_usage=%s without mutating downstream options', include_usage => {
    const input = { ...basic(), stream: true, stream_options: { include_usage } };
    const result = chatToResponsesRequest(input, context, policy);
    expect(result).toMatchObject({ ok: true, value: { stream: true } });
    if (result.ok) expect(result.value).not.toHaveProperty('stream_options');
    expect(input.stream_options.include_usage).toBe(include_usage);
  });
  it('requires streaming for include_usage and rejects unknown stream options', () => {
    expect(chatToResponsesRequest({ ...basic(), stream_options: { include_usage: true } }, context, policy).ok).toBe(false);
    expect(chatToResponsesRequest({ ...basic(), stream: true, stream_options: { include_usage: true } }, context).ok).toBe(true);
    expect(chatToResponsesRequest({ ...basic(), stream: true, stream_options: { vendor: true } }, context, policy).ok).toBe(false);
  });
  it('preserves refusal history as native refusal content, not visible text', () => {
    const result = chatToResponsesRequest({ model: 'm', messages: [{ role: 'assistant', content: null, refusal: 'Declined' }] }, context, policy);
    expect(result).toMatchObject({ ok: true, value: { input: [{ role: 'assistant', content: [{ type: 'refusal', refusal: 'Declined' }] }] } });
    if (result.ok) expect(validateResponsesRequest(result.value).ok).toBe(true);
    expect(chatToResponsesRequest({ model: 'm', messages: [{ role: 'assistant', content: [{ type: 'refusal', refusal: 'Declined' }] }] }, context, policy).ok).toBe(true);
    expect(chatToResponsesRequest({ model: 'm', messages: [{ role: 'assistant', content: [{ type: 'refusal', refusal: 'a' }], refusal: 'b' }] }, context, policy).ok).toBe(false);
  });
  it('preserves system block boundaries without cache hints but refuses native cache controls even if allowlisted', () => {
    const messages = [{ role: 'system', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }, ...basic().messages];
    expect(chatToResponsesRequest({ model: 'm', messages }, context, policy)).toMatchObject({ ok: true, value: { input: [{ role: 'system', content: [{ text: 'one' }, { text: 'two' }] }, { role: 'user' }] } });
    for (const cache_control of [null, { type: 'ephemeral' }, { type: 'ephemeral', ttl: '1h' }]) {
      expect(chatToResponsesRequest({ model: 'm', messages: [{ role: 'system', content: [{ type: 'text', text: 'one', cache_control }] }, ...basic().messages] }, context, policy).ok).toBe(false);
    }
  });
  it.each([{ vendor_hint: 'SENSITIVE' }, { prompt_cache_key: 'cache-key' }, { prompt_cache_retention: '24h' },
    { metadata: { key: 'value' } }, { user: 'user-tag' }, { service_tier: 'priority' }])('does not forward unreviewed/native-only extension %#', extra => {
    const result = chatToResponsesRequest({ ...basic(), ...extra }, context, policy);
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('SENSITIVE');
  });
});

describe('P-CR-Q5 reasoning semantics', () => {
  const options = { channelCapabilities: { protocol: 'responses' as const, features: ['reasoning_effort'] as const,
    reasoningEfforts: ['none', 'low', 'medium', 'high'], maxOutputTokens: 256 } };
  it.each(['none', 'high'])('maps declared effort %s without inventing a token budget', reasoning_effort => {
    const result = chatToResponsesRequest({ ...basic(), reasoning_effort, max_completion_tokens: 128 }, context, options);
    expect(result).toMatchObject({ ok: true, value: { reasoning: { effort: reasoning_effort }, max_output_tokens: 128 } });
    if (result.ok) {
      expect(result.value).not.toHaveProperty('include');
      expect(result.value.reasoning).not.toHaveProperty('summary');
      expect(result.value.reasoning).not.toHaveProperty('budget_tokens');
    }
  });
  it('preserves effort and sampling without capability declarations', () => {
    expect(chatToResponsesRequest({ ...basic(), reasoning_effort: 'high' }, context).ok).toBe(true);
    expect(chatToResponsesRequest({ ...basic(), reasoning_effort: 'vendor_unknown' }, context, options).ok).toBe(true);
    expect(chatToResponsesRequest({ ...basic(), reasoning_effort: 'high', temperature: 1 }, context, options).ok).toBe(true);
  });
  it('treats null effort as unspecified without imposing a target default', () => {
    const result = chatToResponsesRequest({ ...basic(), reasoning_effort: null }, context);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).not.toHaveProperty('reasoning');
  });
  it.each([{ reasoning_content: 'PRIVATE_REASONING' }, { reasoning: 'PRIVATE_REASONING' }, { signature: 'PRIVATE_SIGNATURE' },
    { thinking: [{ text: 'PRIVATE_REASONING', signature: 'PRIVATE_SIGNATURE' }] }])('rejects unrepresentable private history %# without surfacing it as text', fields => {
    const result = chatToResponsesRequest({ model: 'm', messages: [{ role: 'assistant', content: 'visible', ...fields }] }, context, options);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  });
  it('does not reinterpret an unknown Chat thinking extension as native Responses configuration', () => {
    expect(chatToResponsesRequest({ ...basic(), thinking: { type: 'enabled', budget_tokens: 1000 } }, context, options).ok).toBe(false);
    expect(chatToResponsesRequest({ ...basic(), reasoning: { encrypted_content: 'PRIVATE' } }, context, options).ok).toBe(false);
  });
});

describe('P-CR-Q4-O structured output constraints', () => {
  const options = { channelCapabilities: { protocol: 'responses' as const, features: ['json_object', 'json_schema'] as const } };
  it.each(['text', 'json_object'] as const)('maps %s into text.format', type => {
    expect(chatToResponsesRequest({ ...basic(), response_format: { type } }, context, options)).toMatchObject({ ok: true, value: { text: { format: { type } } } });
  });
  it.each([true, false, null, undefined])('keeps strict semantics %s and exact schema/description', strict => {
    const schema = { type: 'object', properties: { result: { type: ['string', 'null'] } }, required: ['result'], additionalProperties: false };
    const json_schema = { name: 'result_schema', description: 'Exact requested output', schema, ...(strict === undefined ? {} : { strict }) };
    const result = chatToResponsesRequest({ ...basic(), response_format: { type: 'json_schema', json_schema } }, context, options);
    expect(result).toMatchObject({ ok: true, value: { text: { format: { type: 'json_schema', name: json_schema.name, description: json_schema.description, schema, strict: strict ?? false } } } });
    if (result.ok) {
      expect(validateResponsesRequest(result.value).ok).toBe(true);
      expect((result.value.text?.format as { schema: unknown }).schema).not.toBe(schema);
    }
  });
  it('accepts undeclared output formats but rejects unrepresentable extensions', () => {
    const response_format = { type: 'json_schema', json_schema: { name: 'out', schema: { type: 'object' }, strict: true } };
    expect(chatToResponsesRequest({ ...basic(), response_format }, context).ok).toBe(true);
    expect(chatToResponsesRequest({ ...basic(), response_format }, context, { channelCapabilities: { protocol: 'responses', features: ['json_object'] } }).ok).toBe(true);
    expect(chatToResponsesRequest({ ...basic(), response_format: { ...response_format, vendor: 'must-not-drop' } }, context, options).ok).toBe(false);
    expect(chatToResponsesRequest({ ...basic(), response_format: { type: 'json_schema', json_schema: { ...response_format.json_schema, vendor: true } } }, context, options).ok).toBe(false);
  });
  it('keeps literal JSON schema property names as data without treating them as tool extensions', () => {
    const schema = { type: 'object', properties: { tools: { type: 'string' }, reasoning: { type: 'string' } } };
    expect(chatToResponsesRequest({ ...basic(), response_format: { type: 'json_schema', json_schema: { name: 'literal', schema, strict: false } } }, context, options))
      .toMatchObject({ ok: true, value: { text: { format: { schema } } } });
  });
});

describe('P-CR-Q4 output controls', () => {
  const options = { channelCapabilities: { protocol: 'responses' as const, features: ['temperature', 'top_p'] as const, maxOutputTokens: 256 } };
  it.each(['max_tokens', 'max_completion_tokens'])('maps %s without clamping', field => {
    expect(chatToResponsesRequest({ ...basic(), [field]: 128 }, context, options)).toMatchObject({ ok: true, value: { max_output_tokens: 128 } });
    expect(chatToResponsesRequest({ ...basic(), [field]: 257 }, context, options).ok).toBe(false);
  });
  it('preserves temperature/top_p including zero and target-supported boundary values', () => {
    expect(chatToResponsesRequest({ ...basic(), temperature: 0, top_p: 1 }, context, options)).toMatchObject({ ok: true, value: { temperature: 0, top_p: 1 } });
    expect(chatToResponsesRequest({ ...basic(), temperature: 2, top_p: 0 }, context, options)).toMatchObject({ ok: true, value: { temperature: 2, top_p: 0 } });
  });
  it('accepts undeclared sampling but rejects conflicting output limits', () => {
    expect(chatToResponsesRequest({ ...basic(), temperature: 0.5 }, context).ok).toBe(true);
    expect(chatToResponsesRequest({ ...basic(), temperature: 0.5 }, context, { channelCapabilities: { protocol: 'responses', features: [] } }).ok).toBe(true);
    expect(chatToResponsesRequest({ ...basic(), max_tokens: 5, max_completion_tokens: 5 }, context, options)).toMatchObject({ ok: false, error: { code: 'conflicting_output_limits' } });
  });
  it('allows null controls as absent and n=1, without synthesizing target defaults', () => {
    const result = chatToResponsesRequest({ ...basic(), max_tokens: null, max_completion_tokens: null, temperature: null, top_p: null, stop: null, n: 1 }, context);
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.value).sort()).toEqual(['input', 'model']);
  });
  it.each(['END', ['END'], ''])('rejects unrepresentable stop sequences %#', stop => {
    expect(chatToResponsesRequest({ ...basic(), stop }, context, options)).toMatchObject({ ok: false, error: { param: '$.stop' } });
  });
  it('rejects multiple choices that Responses cannot represent', () => {
    expect(chatToResponsesRequest({ ...basic(), n: 2 }, context, options).ok).toBe(false);
  });
});

describe('P-CR-Q2 custom tools and complete paired history', () => {
  const tool = (name = 'lookup') => ({ type: 'function' as const, function: { name, description: 'Synthetic lookup',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: true },
  } });
  const call = (id: string, args = '{"query":"x"}') => ({ id, type: 'function' as const, function: { name: 'lookup', arguments: args } });
  const input = (): ChatRequest => ({ model: 'public', tools: [tool()], messages: [
    { role: 'user', content: 'run both' },
    { role: 'assistant', content: 'Checking', tool_calls: [call('call_a', ' {"query":"a"} '), call('call_b', '{"query":"b"}')] },
    { role: 'tool', tool_call_id: 'call_b', content: 'b-result' },
    { role: 'tool', tool_call_id: 'call_a', content: [{ type: 'text', text: 'a' }, { type: 'text', text: '-result' }] },
    { role: 'assistant', content: 'Done' },
  ] });

  it('flattens definitions and preserves assistant text/call IDs/raw arguments/result order', () => {
    const request = input();
    const converted = chatToResponsesRequest(request, context);
    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    expect(converted.value.tools).toEqual([{ type: 'function', name: 'lookup', description: 'Synthetic lookup', parameters: tool().function.parameters, strict: false }]);
    expect(converted.value.input).toEqual([
      { type: 'message', role: 'user', content: 'run both' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking', annotations: [] }] },
      { type: 'function_call', call_id: 'call_a', name: 'lookup', arguments: ' {"query":"a"} ' },
      { type: 'function_call', call_id: 'call_b', name: 'lookup', arguments: '{"query":"b"}' },
      { type: 'function_call_output', call_id: 'call_b', output: 'b-result' },
      { type: 'function_call_output', call_id: 'call_a', output: [{ type: 'input_text', text: 'a' }, { type: 'input_text', text: '-result' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done', annotations: [] }] },
    ]);
    expect(converted.value.tools?.[0]?.parameters).not.toBe(request.tools?.[0]?.function.parameters);
    expect(validateResponsesRequest(converted.value).ok).toBe(true);
  });

  it.each(['auto', 'none', 'required'] as const)('preserves tool_choice=%s', tool_choice => {
    expect(chatToResponsesRequest({ ...input(), tool_choice }, context)).toMatchObject({ ok: true, value: { tool_choice } });
  });
  it('maps named function choice without promoting function names to native tools', () => {
    const request: ChatRequest = { ...basic(), tools: [tool('web_search')], tool_choice: { type: 'function', function: { name: 'web_search' } } };
    expect(chatToResponsesRequest(request, context)).toMatchObject({ ok: true, value: {
      tools: [{ type: 'function', name: 'web_search' }], tool_choice: { type: 'function', name: 'web_search' },
    } });
    expect(chatToResponsesRequest({ ...basic(), tools: [{ type: 'web_search' }] }, context).ok).toBe(false);
    expect(chatToResponsesRequest({ ...basic(), tool_choice: { type: 'web_search' } }, context).ok).toBe(false);
  });

  it.each([true, false])('retains parallel_tool_calls=%s without rejecting historical parallel calls', parallel_tool_calls => {
    const result = chatToResponsesRequest({ ...input(), parallel_tool_calls }, context);
    expect(result).toMatchObject({ ok: true, value: { parallel_tool_calls } });
    if (result.ok) expect(result.value.input).toHaveLength(7);
  });

  it.each([true, false, null])('maps explicit strict=%s without rewriting schema', strict => {
    const definition = tool();
    const request = { ...basic(), tools: [{ ...definition, function: { ...definition.function, strict } }] };
    expect(chatToResponsesRequest(request, context)).toMatchObject({ ok: true, value: { tools: [{ strict: strict ?? false, parameters: definition.function.parameters }] } });
  });

  it('preserves empty tools, non-strict parameter omission, tool-only turns and empty results', () => {
    expect(chatToResponsesRequest({ ...basic(), tools: [], tool_choice: 'none' }, context)).toMatchObject({ ok: true, value: { tools: [], tool_choice: 'none' } });
    expect(chatToResponsesRequest({ ...basic(), tools: [{ type: 'function', function: { name: 'no_parameters' } }] }, context))
      .toMatchObject({ ok: true, value: { tools: [{ type: 'function', name: 'no_parameters', strict: false }] } });
    const result = chatToResponsesRequest({ model: 'm', messages: [
      { role: 'assistant', content: null, tool_calls: [call('c', '{}')] }, { role: 'tool', tool_call_id: 'c', content: '' },
    ] }, context);
    expect(result).toMatchObject({ ok: true, value: { input: [
      { type: 'function_call', call_id: 'c', name: 'lookup', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c', output: '' },
    ] } });
  });

  it.each([
    [{ role: 'tool', tool_call_id: 'orphan', content: 'result' }],
    [{ role: 'assistant', tool_calls: [call('a')] }],
    [{ role: 'assistant', tool_calls: [call('a')] }, { role: 'user', content: 'interrupted' }],
    [{ role: 'assistant', tool_calls: [call('a'), call('b')] }, { role: 'tool', tool_call_id: 'a', content: 'x' }],
    [{ role: 'assistant', tool_calls: [call('a')] }, { role: 'tool', tool_call_id: 'a', content: 'x' }, { role: 'tool', tool_call_id: 'a', content: 'duplicate' }],
    [{ role: 'assistant', tool_calls: [call('a')] }, { role: 'tool', tool_call_id: 'a', content: 'x' }, { role: 'assistant', tool_calls: [call('a')] }],
  ].map(messages => [messages]))('rejects orphan, unpaired, duplicate and interleaved histories %#', messages => {
    expect(chatToResponsesRequest({ model: 'm', messages }, context)).toMatchObject({ ok: false, error: { kind: 'unsupported_feature' } });
  });

  it.each(['', '{', '[]', 'null', '"scalar"', ' '.repeat(1_048_577)])('rejects malformed/nonobject/oversize arguments %# without repair', args => {
    expect(chatToResponsesRequest({ model: 'm', messages: [
      { role: 'assistant', tool_calls: [call('c', args)] }, { role: 'tool', tool_call_id: 'c', content: 'x' },
    ] }, context).ok).toBe(false);
  });

  it('does not parse/stringify away argument precision or whitespace', () => {
    const args = ' { "n": 9007199254740993, "decimal": 0.1234567890123456789 } ';
    expect(chatToResponsesRequest({ model: 'm', messages: [
      { role: 'assistant', tool_calls: [call('c', args)] }, { role: 'tool', tool_call_id: 'c', content: 'x' },
    ] }, context)).toMatchObject({ ok: true, value: { input: [{ arguments: args }, { output: 'x' }] } });
  });

  it('rejects duplicate definitions, unknown named choice, nonobject schema and missing strict schema', () => {
    for (const tools of [[tool(), tool()], [{ type: 'function', function: { name: 'f', parameters: { type: 'array' } } }],
      [{ type: 'function', function: { name: 'f', strict: true } }]]) expect(chatToResponsesRequest({ ...basic(), tools }, context).ok).toBe(false);
    expect(chatToResponsesRequest({ ...basic(), tools: [tool()], tool_choice: { type: 'function', function: { name: 'missing' } } }, context).ok).toBe(false);
    expect(chatToResponsesRequest({ ...basic(), tool_choice: 'required' }, context).ok).toBe(false);
  });

  it('rejects ID guessing and unknown tool/call/schema-wrapper extensions', () => {
    for (const id of ['../id', 'x'.repeat(129)]) expect(chatToResponsesRequest({ model: 'm', messages: [
      { role: 'assistant', tool_calls: [call(id)] }, { role: 'tool', tool_call_id: id, content: 'x' },
    ] }, context).ok).toBe(false);
    const definition = tool();
    expect(chatToResponsesRequest({ ...basic(), tools: [{ ...definition, vendor: true }] }, context).ok).toBe(false);
    expect(chatToResponsesRequest({ ...basic(), tools: [{ ...definition, function: { ...definition.function, vendor: true } }] }, context).ok).toBe(false);
  });
});
