import { describe, expect, it } from "vitest";
import { checkRequestCapabilities, identifyRequestFeatures } from "../../../packages/apicompat/capabilities/check.js";
import type { CapabilityFeature, ChannelCapabilities, ProtocolRequest } from "../../../packages/apicompat/capabilities/check.js";
import type { ChatRequest } from "../../../packages/apicompat/types/chat.js";
import type { ResponsesRequest } from "../../../packages/apicompat/types/responses.js";
import type { MessagesRequest } from "../../../packages/apicompat/types/messages.js";
import type { Protocol } from "../../../packages/apicompat/types/shared.js";

// Original synthetic requests. Capability sets below are scenario-specific, not
// a global all-true matrix or evidence about any real vendor/model.
const chat = (patch: Partial<ChatRequest> = {}): ProtocolRequest => ({ protocol: "chat", request: { model: "fixture", max_completion_tokens: 64, messages: [{ role: "user", content: "Synthetic prompt" }], ...patch } });
const responses = (patch: Partial<ResponsesRequest> = {}): ProtocolRequest => ({ protocol: "responses", request: { model: "fixture", max_output_tokens: 64, input: "Synthetic prompt", ...patch } });
const messages = (patch: Partial<MessagesRequest> = {}): ProtocolRequest => ({ protocol: "messages", request: { model: "fixture", max_tokens: 64, messages: [{ role: "user", content: "Synthetic prompt" }], ...patch } });
const factories = { chat, responses, messages };
const protocols: Protocol[] = ["chat", "responses", "messages"];
const pairs = protocols.flatMap(from => protocols.map(to => ({ from, to })));
const channel = (protocol: Protocol, features: readonly CapabilityFeature[] = []): ChannelCapabilities => ({ protocol, features, maxOutputTokens: 4096 });

describe('P10-RM-CACHE explicit cache extension semantics',()=>{
  const target:ChannelCapabilities={...channel('messages',['tools','cache_control','image_url']),cacheTtls:['5m','1h']};
  it('recognizes request, tool and input/output text/image block markers for Messages',()=>{
    const input=responses({cache_control:{type:'ephemeral'},tools:[{type:'function',name:'f',parameters:{type:'object'},cache_control:{type:'ephemeral',ttl:'1h'}}],
      input:[{role:'system',content:[{type:'input_text',text:'cached',cache_control:{type:'ephemeral'}}]},{role:'user',content:[{type:'input_image',image_url:'https://image.example/x',cache_control:{type:'ephemeral'}}]}]});
    expect(checkRequestCapabilities(input,target).supported).toBe(true);
    expect(checkRequestCapabilities(input,{...target,cacheTtls:['5m']}).supported).toBe(false);
    expect(checkRequestCapabilities(input,{...channel('chat',['tools','cache_control','image_url']),cacheTtls:['5m','1h']}).supported).toBe(false);
  });
  it.each([{type:'persistent'},{type:'ephemeral',ttl:'24h'},{type:'ephemeral',extra:true},true])('rejects malformed cache marker %#',cache_control=>{
    expect(checkRequestCapabilities(responses({cache_control}),target).supported).toBe(false);
  });
  it('does not authorize message-level markers, arbitrary caches or hidden payload-schema properties',()=>{
    expect(checkRequestCapabilities(responses({input:[{role:'user',content:'x',cache_control:{type:'ephemeral'}}]}),target).supported).toBe(false);
    expect(checkRequestCapabilities(responses({vendor_cache:{type:'ephemeral'}}),target).supported).toBe(false);
    expect(checkRequestCapabilities(responses({tools:[{type:'function',name:'f',parameters:{type:'object',properties:{cache_control:{type:'boolean'}}}}]}),channel('messages',['tools'])).supported).toBe(true);
  });
});

describe('P10-MAPPINGS known Messages output/cache semantics', () => {
  const target = (features: readonly CapabilityFeature[]): ChannelCapabilities => ({ ...channel('messages', features), reasoningEfforts: ['low', 'medium', 'high'], cacheTtls: ['5m', '1h'] });
  it.each(['low', 'medium', 'high'])('allows declared common effort %s without a budget substitution', reasoning_effort => {
    expect(checkRequestCapabilities(chat({ reasoning_effort }), target(['reasoning_effort'])).supported).toBe(true);
    expect(checkRequestCapabilities(chat({ reasoning_effort }), target([])).supported).toBe(false);
  });
  it.each(['none', 'minimal', 'xhigh', 'max'])('does not guess a CM mapping for effort %s', reasoning_effort => {
    expect(checkRequestCapabilities(chat({ reasoning_effort }), { ...target(['reasoning_effort']), reasoningEfforts: [reasoning_effort] }).supported).toBe(false);
  });
  it('allows strict JSON schema to native Messages but rejects advisory schema/JSON-only mode', () => {
    const json_schema = { name: 'out', schema: { type: 'object' }, strict: true };
    expect(checkRequestCapabilities(chat({ response_format: { type: 'json_schema', json_schema } }), target(['json_schema'])).supported).toBe(true);
    expect(checkRequestCapabilities(chat({ response_format: { type: 'json_schema', json_schema: { ...json_schema, strict: false } } }), target(['json_schema'])).supported).toBe(false);
    expect(checkRequestCapabilities(chat({ response_format: { type: 'json_object' } }), target(['json_object'])).supported).toBe(false);
  });
  it('recognizes native Messages output_config fields and checks actual capabilities', () => {
    const input = messages({ output_config: { effort: 'high', format: { type: 'json_schema', schema: { type: 'object' } } } });
    expect(checkRequestCapabilities(input, target(['reasoning_effort', 'json_schema'])).supported).toBe(true);
    expect(checkRequestCapabilities(input, target(['reasoning_effort'])).supported).toBe(false);
    expect(checkRequestCapabilities(messages({ output_config: { effort: 'max' } }), { ...channel('chat', ['reasoning_effort']), reasoningEfforts: ['max'] }).supported).toBe(false);
  });
  it('recognizes request/content/tool Chat cache_control at explicit scopes', () => {
    const input = chat({ cache_control: { type: 'ephemeral' }, tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } }, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'system', content: [{ type: 'text', text: 'cached', cache_control: { type: 'ephemeral', ttl: '5m' } }] }] });
    expect(checkRequestCapabilities(input, target(['tools', 'cache_control'])).supported).toBe(true);
    expect(checkRequestCapabilities(input, { ...target(['tools', 'cache_control']), cacheTtls: ['5m'] }).supported).toBe(false);
    expect(checkRequestCapabilities(input, target(['tools'])).supported).toBe(false);
    expect(checkRequestCapabilities(input, { ...channel('responses', ['tools', 'cache_control']), cacheTtls: ['5m', '1h'] }).supported).toBe(false);
  });
  it.each([{ type: 'persistent' }, { type: 'ephemeral', ttl: '2h' }, { type: 'ephemeral', vendor: true }, true, []])('validates known Chat cache marker %# instead of trusting extensions', cache_control => {
    const result = checkRequestCapabilities(chat({ cache_control }), target(['cache_control']));
    expect(result.supported).toBe(false);
    if (!result.supported) expect(result.reasons.some(reason => reason.code === 'invalid_request')).toBe(true);
  });
  it('leaves message-level cache placement and unknown fields unapproved', () => {
    expect(checkRequestCapabilities(chat({ messages: [{ role: 'user', content: 'x', cache_control: { type: 'ephemeral' } }] }), target(['cache_control'])).supported).toBe(false);
    expect(checkRequestCapabilities(chat({ vendor_cache: { type: 'ephemeral' } }), target(['cache_control'])).supported).toBe(false);
  });
  it('counts cache breakpoints without mistaking schema properties for markers', () => {
    expect(checkRequestCapabilities(chat({ messages: [{ role: 'system', content: Array.from({ length: 5 }, () => ({ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } })) }] }), target(['cache_control'])).supported).toBe(false);
    expect(checkRequestCapabilities(chat({ tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: { cache_control: { type: 'boolean' } } } } }] }), target(['tools'])).supported).toBe(true);
  });
});

function toolRequest(protocol: Protocol): ProtocolRequest {
  if (protocol === "chat") return chat({ tools: [{ type: "function", function: { name: "clock", parameters: { type: "object" } } }] });
  if (protocol === "responses") return responses({ tools: [{ type: "function", name: "clock", parameters: { type: "object" } }] });
  return messages({ tools: [{ name: "clock", input_schema: { type: "object" } }] });
}

function imageRequest(protocol: Protocol, base64 = false): ProtocolRequest {
  const url = base64 ? "data:image/png;base64,c3ludGhldGlj" : "https://images.example/synthetic.png";
  if (protocol === "chat") return chat({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }] });
  if (protocol === "responses") return responses({ input: [{ role: "user", content: [{ type: "input_image", image_url: url }] }] });
  return messages({ messages: [{ role: "user", content: [{ type: "image", source: base64 ? { type: "base64", media_type: "image/png", data: "c3ludGhldGlj" } : { type: "url", url } }] }] });
}

const reason = (input: ProtocolRequest, target: ChannelCapabilities, code: string, feature?: string): void => {
  const result = checkRequestCapabilities(input, target);
  expect(result.supported).toBe(false);
  if (!result.supported) expect(result.reasons).toEqual(expect.arrayContaining([expect.objectContaining({ code, ...(feature ? { feature } : {}) })]));
};

describe("request direction and actual portable features", () => {
  it.each(pairs)("accepts bounded plain text $from -> $to with no optional model features", ({ from, to }) => {
    const result = checkRequestCapabilities(factories[from](), channel(to));
    expect(result).toMatchObject({ supported: true, from, to, outputTokenLimit: 64, requiredChecks: [] });
  });

  it.each(pairs)("requires tools for $from -> $to", ({ from, to }) => {
    const request = toolRequest(from);
    reason(request, channel(to), "missing_capability", "tools");
    expect(checkRequestCapabilities(request, channel(to, ["tools"])).supported).toBe(true);
  });

  it.each(pairs)("requires the actual URL/base64 image source for $from -> $to", ({ from, to }) => {
    for (const base64 of [false, true]) {
      const feature = base64 ? "image_base64" : "image_url";
      const input = imageRequest(from, base64);
      reason(input, channel(to), "missing_capability", feature);
      expect(checkRequestCapabilities(input, channel(to, [feature])).supported).toBe(true);
    }
  });

  it("does not mistake words or tool schema/input JSON for protocol features", () => {
    const input = chat({ messages: [
      { role: "user", content: "image_url tools thinking previous_response_id" },
      { role: "assistant", tool_calls: [{ id: "call_x", type: "function", function: { name: "echo", arguments: '{"type":"image","cache_control":true}' } }] },
    ], tools: [{ type: "function", function: { name: "echo", parameters: { type: "object", properties: { vendor_field: { type: "string" } }, additionalProperties: false } } }] });
    const identified = identifyRequestFeatures(input);
    expect(identified.ok).toBe(true);
    if (identified.ok) {
      expect(new Set(identified.value.required.map(entry => entry.feature))).toEqual(new Set(["tools"]));
      expect(identified.value.extensions).toEqual([]);
    }
    expect(checkRequestCapabilities(input, channel("messages", ["tools"])).supported).toBe(true);
  });

  it("detects parallel tool history even with no tool definitions or parallel flag", () => {
    const histories: ProtocolRequest[] = [
      chat({ messages: [{ role: "assistant", tool_calls: ["a", "b"].map(id => ({ id, type: "function", function: { name: "clock", arguments: "{}" } })) }] }),
      responses({ input: ["a", "b"].map(call_id => ({ type: "function_call", call_id, name: "clock", arguments: "{}" })) }),
      messages({ messages: [{ role: "assistant", content: ["a", "b"].map(id => ({ type: "tool_use", id, name: "clock", input: {} })) }] }),
    ];
    for (const input of histories) {
      reason(input, channel("responses", ["tools"]), "missing_capability", "parallel_tools");
      expect(checkRequestCapabilities(input, channel("responses", ["tools", "parallel_tools"])).supported).toBe(true);
    }
  });

  it("distinguishes a parallel allowance from an explicit prohibition", () => {
    for (const input of [chat({ parallel_tool_calls: false }), responses({ parallel_tool_calls: false })]) {
      reason(input, channel("messages"), "missing_capability", "parallel_tool_control");
      expect(checkRequestCapabilities(input, channel("messages", ["parallel_tool_control"])).supported).toBe(true);
    }
    reason(chat({ parallel_tool_calls: true }), channel("responses", ["parallel_tool_control"]), "missing_capability", "parallel_tools");
    const input = messages({ tool_choice: { type: "auto", disable_parallel_tool_use: true } });
    expect(checkRequestCapabilities(input, channel("chat", ["tool_choice", "parallel_tool_control"])).supported).toBe(true);
  });
});

describe("feature-specific channel declarations", () => {
  const cases: { name: string; input: ProtocolRequest; target: Protocol; needed: CapabilityFeature[] }[] = [
    { name: "SSE", input: chat({ stream: true }), target: "messages", needed: ["streaming"] },
    { name: "stream usage", input: chat({ stream: true, stream_options: { include_usage: true } }), target: "responses", needed: ["streaming", "stream_usage"] },
    { name: "named tool", input: chat({ tool_choice: { type: "function", function: { name: "clock" } } }), target: "messages", needed: ["tools", "tool_choice"] },
    { name: "strict tools", input: responses({ tools: [{ type: "function", name: "clock", strict: true }] }), target: "messages", needed: ["tools", "strict_tools"] },
    { name: "JSON object", input: chat({ response_format: { type: "json_object" } }), target: "responses", needed: ["json_object"] },
    { name: "JSON schema", input: responses({ text: { format: { type: "json_schema", name: "result", schema: { type: "object" }, strict: true } } }), target: "chat", needed: ["json_schema"] },
    { name: "temperature", input: chat({ temperature: 0 }), target: "messages", needed: ["temperature"] },
    { name: "top-p", input: messages({ top_p: 0 }), target: "responses", needed: ["top_p"] },
    { name: "stop", input: messages({ stop_sequences: ["END"] }), target: "chat", needed: ["stop_sequences"] },
    { name: "native top-k", input: messages({ top_k: 10 }), target: "messages", needed: ["top_k"] },
    { name: "native seed", input: chat({ seed: 0 }), target: "chat", needed: ["seed"] },
    { name: "native penalty", input: chat({ frequency_penalty: 0.3 }), target: "chat", needed: ["penalties"] },
    { name: "native n", input: chat({ n: 2 }), target: "chat", needed: ["multiple_choices"] },
    { name: "native tier", input: chat({ service_tier: "auto" }), target: "chat", needed: ["service_tier"] },
    { name: "native metadata", input: responses({ metadata: { label: "fixture" } }), target: "responses", needed: ["metadata"] },
    { name: "native name", input: chat({ messages: [{ role: "user", content: "Hi", name: "fixture" }] }), target: "chat", needed: ["message_names"] },
    { name: "native store", input: responses({ store: false }), target: "responses", needed: ["store"] },
    { name: "native verbosity", input: responses({ text: { verbosity: "low" } }), target: "responses", needed: ["verbosity"] },
    { name: "reasoning summary", input: responses({ reasoning: { summary: "auto" } }), target: "responses", needed: ["reasoning_summary"] },
    { name: "thinking budget", input: messages({ max_tokens: 2048, thinking: { type: "enabled", budget_tokens: 1024 } }), target: "messages", needed: ["thinking_budget"] },
    { name: "adaptive thinking", input: messages({ thinking: { type: "adaptive" } }), target: "messages", needed: ["thinking_adaptive"] },
    { name: "disabled thinking", input: messages({ thinking: { type: "disabled" } }), target: "messages", needed: ["thinking_control"] },
    { name: "signed thinking", input: messages({ messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE", signature: "OPAQUE" }] }] }), target: "messages", needed: ["signed_thinking"] },
    { name: "redacted thinking", input: messages({ messages: [{ role: "assistant", content: [{ type: "redacted_thinking", data: "OPAQUE" }] }] }), target: "messages", needed: ["redacted_thinking"] },
    { name: "Chat private history", input: chat({ messages: [{ role: "assistant", reasoning_content: "PRIVATE" }] }), target: "chat", needed: ["reasoning_history"] },
    { name: "encrypted history", input: responses({ input: [{ type: "reasoning", id: "rs_fixture", summary: [], encrypted_content: "OPAQUE" }] }), target: "responses", needed: ["reasoning_history", "encrypted_reasoning"] },
    { name: "native citations", input: messages({ messages: [{ role: "assistant", content: [{ type: "text", text: "quote", citations: [{ type: "fixture" }] }] }] }), target: "messages", needed: ["citations"] },
    { name: "native logprobs", input: responses({ input: [{ role: "assistant", content: [{ type: "output_text", text: "answer", annotations: [], logprobs: [{}] }] }] }), target: "responses", needed: ["logprobs"] },
    { name: "system/developer priority", input: chat({ messages: [{ role: "system", content: "One" }, { role: "developer", content: "Two" }, { role: "user", content: "Hi" }] }), target: "responses", needed: ["system_developer_priority"] },
    { name: "native tool error marker", input: messages({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_x", is_error: true, content: "error" }] }] }), target: "messages", needed: ["tools", "tool_result_error"] },
    { name: "refusal history", input: chat({ messages: [{ role: "assistant", refusal: "Declined" }] }), target: "responses", needed: ["refusal_history"] },
  ];

  it.each(cases)("requires every declared part of $name", ({ input, target, needed }) => {
    expect(checkRequestCapabilities(input, channel(target, needed)).supported).toBe(true);
    for (const missing of needed) reason(input, channel(target, needed.filter(entry => entry !== missing)), "missing_capability", missing);
  });

  it("does not use native feature declarations to bypass absent cross-protocol mappings", () => {
    for (const { input, needed } of cases.filter(entry => entry.name.startsWith("native") || ["thinking budget", "adaptive thinking", "disabled thinking", "signed thinking", "redacted thinking", "encrypted history", "Chat private history", "reasoning summary"].includes(entry.name))) {
      const to = input.protocol === "messages" ? "chat" : "messages";
      reason(input, channel(to, needed), "no_protocol_mapping");
    }
    reason(chat({ response_format: { type: "json_schema", json_schema: { name: "result", schema: { type: "object" } } } }), channel("messages", ["json_schema"]), "no_protocol_mapping", "json_schema");
    reason(chat({ stop: "END" }), channel("responses", ["stop_sequences"]), "no_protocol_mapping", "stop_sequences");
    reason(chat({ messages: [{ role: "system", content: "One" }, { role: "developer", content: "Two" }] }), channel("messages", ["system_developer_priority"]), "no_protocol_mapping", "system_developer_priority");
  });

  it("requires exact reasoning effort and cache TTL declarations", () => {
    const effort = chat({ reasoning_effort: "high" });
    reason(effort, channel("responses", ["reasoning_effort"]), "reasoning_effort_not_supported");
    expect(checkRequestCapabilities(effort, { ...channel("responses", ["reasoning_effort"]), reasoningEfforts: ["high"] }).supported).toBe(true);
    expect(checkRequestCapabilities(effort, { ...channel("messages", ["reasoning_effort"]), reasoningEfforts: ["high"] }).supported).toBe(true);
    const cached = messages({ system: [{ type: "text", text: "Cache me", cache_control: { type: "ephemeral", ttl: "1h" } }] });
    reason(cached, { ...channel("messages", ["cache_control"]), cacheTtls: ["5m"] }, "cache_ttl_not_supported");
    reason(cached, { ...channel("messages"), cacheTtls: ["1h"] }, "missing_capability", "cache_control");
    expect(checkRequestCapabilities(cached, { ...channel("messages", ["cache_control"]), cacheTtls: ["1h"] }).supported).toBe(true);
    reason(cached, { ...channel("chat", ["cache_control"]), cacheTtls: ["1h"] }, "no_protocol_mapping");
  });
});

describe("references, extensions and non-lossy limits", () => {
  it("allows native previous_response_id only with capability and a pending G13 binding check", () => {
    const input = responses({ previous_response_id: "resp_private" });
    reason(input, channel("responses"), "missing_capability", "response_history");
    expect(checkRequestCapabilities(input, channel("responses", ["response_history"]))).toMatchObject({ supported: true, requiredChecks: ["response_history_binding"] });
    for (const to of ["chat", "messages"] as const) reason(input, channel(to, ["response_history"]), "no_protocol_mapping", "response_history");
    const item = responses({ input: [{ type: "item_reference", id: "item_private" }] });
    expect(checkRequestCapabilities(item, channel("responses", ["item_references"]))).toMatchObject({ supported: true, requiredChecks: ["response_history_binding"] });
    reason(item, channel("messages", ["item_references"]), "no_protocol_mapping");
  });

  it("keeps provider file references native and requires independent reference binding", () => {
    const input = responses({ input: [{ role: "user", content: [{ type: "input_image", file_id: "file_private" }] }] });
    reason(input, channel("responses", ["file_references"]), "missing_capability", "image_file_id");
    expect(checkRequestCapabilities(input, channel("responses", ["file_references", "image_file_id"]))).toMatchObject({ supported: true, requiredChecks: ["file_reference_binding"] });
    reason(input, channel("chat", ["file_references", "image_file_id"]), "no_protocol_mapping");
    const file = responses({ input: [{ role: "user", content: [{ type: "input_file", file_url: "https://files.example/a.pdf" }] }] });
    reason(file, channel("responses"), "missing_capability", "file_inputs");
    expect(checkRequestCapabilities(file, channel("responses", ["file_inputs"])).supported).toBe(true);
  });

  it("requires a target capable of representing image tool results", () => {
    const input = messages({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_x", content: [{ type: "image", source: { type: "url", url: "https://images.example/tool.png" } }] }] }] });
    const needed: CapabilityFeature[] = ["tools", "image_url", "tool_result_images"];
    expect(checkRequestCapabilities(input, channel("responses", needed)).supported).toBe(true);
    reason(input, channel("chat", needed), "no_protocol_mapping", "tool_result_images");
  });

  it("requires exact native extension scope/name and never grants cross-protocol permission", () => {
    const input = messages({ native_hint: { secret: "OPAQUE" }, messages: [{ role: "user", content: [{ type: "text", text: "PRIVATE", native_hint: 1 }] }] });
    const original = structuredClone(input);
    reason(input, channel("messages"), "extension_not_allowed");
    reason(input, { ...channel("messages"), nativeExtensions: [{ scope: "request", name: "native_hint" }] }, "extension_not_allowed");
    const nativeExtensions = [{ scope: "request", name: "native_hint" }, { scope: "content", name: "native_hint" }] as const;
    expect(checkRequestCapabilities(input, { ...channel("messages"), nativeExtensions }).supported).toBe(true);
    reason(input, { ...channel("chat"), nativeExtensions }, "extension_not_allowed");
    expect(JSON.stringify(checkRequestCapabilities(input, channel("chat")))).not.toMatch(/OPAQUE|PRIVATE/);
    expect(input).toEqual(original);
  });

  it("does not silently clamp, rescale or invent an output limit", () => {
    reason(chat({ max_completion_tokens: 65 }), { ...channel("responses"), maxOutputTokens: 64 }, "output_limit_exceeded");
    reason(chat({ temperature: 1.5 }), channel("messages", ["temperature"]), "parameter_not_representable");
    reason(chat({ max_tokens: 32, max_completion_tokens: 64 }), channel("chat"), "invalid_request");
    const uncapped: ProtocolRequest = { protocol: "chat", request: { model: "fixture", messages: [{ role: "user", content: "Hi" }] } };
    reason(uncapped, channel("messages"), "output_limit_required");
    expect(checkRequestCapabilities(uncapped, channel("chat"))).toMatchObject({ supported: true });
    expect(checkRequestCapabilities(uncapped, channel("responses"))).not.toHaveProperty('outputTokenLimit');
    reason(chat(), { ...channel("chat"), maxOutputTokens: -1 }, "invalid_channel_capabilities");
  });

  it("rejects malformed opaque constraints and out-of-scope background generation", () => {
    for (const input of [
      responses({ text: { format: { type: "json_schema", name: "result" } } }),
      responses({ text: { verbosity: { toString: "high" } } }),
      responses({ reasoning: { summary: { toString: "auto" } } }),
      messages({ max_tokens: 2048, thinking: { type: "enabled", budget_tokens: 2048 } }),
    ]) reason(input, channel(input.protocol), "invalid_request");
    reason(responses({ background: true }), channel("responses"), "no_protocol_mapping");
    expect(checkRequestCapabilities(responses({ background: false }), channel("chat")).supported).toBe(true);
    // Parsed content validators reject unknown variants; the checker does not hide them.
    const malformed = { protocol: "messages", request: { model: "fixture", max_tokens: 10, messages: [{ role: "user", content: [{ type: "unknown_block" }] }] } } as unknown as ProtocolRequest;
    reason(malformed, channel("messages"), "no_protocol_mapping");
  });
});
