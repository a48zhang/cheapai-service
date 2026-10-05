import { describe, expect, it } from "vitest";
import {
  parseMessagesRequest,
  parseMessagesResponse,
  parseMessagesStreamEvent,
} from "../../../packages/apicompat/types/messages.js";
import type {
  MessagesRequest,
  MessagesResponse,
  MessagesStreamEvent,
  MessagesStopReason,
} from "../../../packages/apicompat/types/messages.js";

// Original synthetic examples, not provider recordings or transplanted fixtures.
const request = (): MessagesRequest => ({ model: "fixture-model", max_tokens: 2048, messages: [{ role: "user", content: "Hello" }] });
const response = (): MessagesResponse => ({
  id: "msg_fixture", type: "message", role: "assistant", model: "fixture-model",
  content: [{ type: "text", text: "Hello back" }], stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 3, output_tokens: 2 },
});

describe("Messages request wire validation", () => {
  it.each(["low", "medium", "high", "xhigh", "max", null])("accepts native output_config effort %s", effort => {
    const value = { ...request(), output_config: { effort, format: { type: "json_schema", schema: { type: "object", properties: { result: { type: "string" } } } } } };
    expect(parseMessagesRequest(value)).toEqual({ ok: true, value });
  });
  it("accepts absent/null format and empty output config without inventing defaults", () => {
    for (const output_config of [{}, { format: null }, { effort: null }]) {
      const value = { ...request(), output_config };
      expect(parseMessagesRequest(value)).toEqual({ ok: true, value });
    }
  });
  it.each([null, [], { effort: "none" }, { effort: 10 }, { format: { type: "json_object", schema: {} } },
    { format: { type: "json_schema", schema: [] } }, { format: { type: "json_schema" } },
    { format: { type: "json_schema", schema: {}, strict: true } }, { vendor: true }])("rejects invalid or unknown output config %#", output_config => {
    expect(parseMessagesRequest({ ...request(), output_config }).ok).toBe(false);
  });
  it("preserves explicitly allowed unknown output config fields but never relaxes known value types", () => {
    const value = { ...request(), output_config: { effort: "high", vendor: { setting: true } } };
    expect(parseMessagesRequest(value, { unknownFields: "preserve" })).toEqual({ ok: true, value });
    expect(parseMessagesRequest({ ...request(), output_config: { effort: false } }, { unknownFields: "preserve" }).ok).toBe(false);
  });
  it("accepts strings, system text blocks, multi-image input and parallel tool history unchanged", () => {
    const value: MessagesRequest = {
      ...request(), system: [{ type: "text", text: "Be brief", cache_control: { type: "ephemeral", ttl: "1h" } }],
      tools: [
        { name: "weather", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false }, strict: true },
        { type: "custom", name: "clock", description: "Current time", input_schema: { type: "object" }, cache_control: null },
      ],
      tool_choice: { type: "auto", disable_parallel_tool_use: false },
      messages: [
        { role: "user", content: [
          { type: "text", text: "Compare these pictures" },
          { type: "image", source: { type: "url", url: "https://images.example/first.png" } },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "c3ludGhldGljLWltYWdl" }, cache_control: { type: "ephemeral", ttl: "5m" } },
        ] },
        { role: "assistant", content: [
          { type: "tool_use", id: "call_weather", name: "weather", input: { city: "Shenzhen" } },
          { type: "tool_use", id: "call_clock", name: "clock", input: {} },
        ] },
        { role: "user", content: [
          { type: "tool_result", tool_use_id: "call_weather", content: [{ type: "text", text: "Sunny" }, { type: "image", source: { type: "url", url: "https://images.example/weather.png" } }] },
          { type: "tool_result", tool_use_id: "call_clock", is_error: true, content: "Unavailable" },
        ] },
      ],
    };
    const original = structuredClone(value);
    const parsed = parseMessagesRequest(value);
    expect(parsed).toEqual({ ok: true, value });
    if (parsed.ok) expect(parsed.value).toBe(value);
    expect(value).toEqual(original);
    expect(parseMessagesRequest({ ...request(), system: "Be brief" }).ok).toBe(true);
  });

  it("preserves thinking signatures and redacted data as separate native blocks", () => {
    const value: MessagesRequest = {
      ...request(), thinking: { type: "enabled", budget_tokens: 1024, display: "summarized" },
      messages: [{ role: "assistant", content: [
        { type: "thinking", thinking: "synthetic private reasoning", signature: "opaque-synthetic-signature" },
        { type: "redacted_thinking", data: "opaque-synthetic-data" },
        { type: "text", text: "Visible answer" },
      ] }],
    };
    expect(parseMessagesRequest(value)).toEqual({ ok: true, value });
    expect(parseMessagesRequest({ ...request(), thinking: { type: "adaptive", display: "omitted" } }).ok).toBe(true);
    expect(parseMessagesRequest({ ...request(), thinking: { type: "disabled" } }).ok).toBe(true);
  });

  it.each(["auto", "any", "none"] as const)("accepts %s tool choice", type => {
    expect(parseMessagesRequest({ ...request(), tool_choice: { type } }).ok).toBe(true);
  });

  it("accepts named tools, empty tool results and zero-valued sampling parameters", () => {
    expect(parseMessagesRequest({ ...request(), temperature: 0, top_p: 0, top_k: 0, stream: false, stop_sequences: [], metadata: { user_id: null }, tool_choice: { type: "tool", name: "clock" } }).ok).toBe(true);
    expect(parseMessagesRequest({ ...request(), messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_empty" }] }] }).ok).toBe(true);
  });

  it.each([
    null, [], {}, { ...request(), model: "" }, { ...request(), max_tokens: 0 }, { ...request(), max_tokens: 1.5 },
    { ...request(), messages: [] }, { ...request(), messages: [{ role: "system", content: "wrong role" }] },
    { ...request(), messages: [{ role: "tool", content: "wrong protocol" }] }, { ...request(), messages: [{ role: "user", content: null }] },
    { ...request(), system: [{ type: "image", source: { type: "url", url: "https://images.example/a.png" } }] },
    { ...request(), stream: "true" }, { ...request(), temperature: 2 }, { ...request(), top_k: -1 },
    { ...request(), tools: [{ name: "clock", input_schema: [] }] }, { ...request(), tools: [{ name: "clock", input_schema: { type: "array" } }] },
    { ...request(), tool_choice: { type: "tool" } }, { ...request(), thinking: { type: "enabled" } },
    { ...request(), cache_control: { type: "ephemeral", ttl: "2h" } },
    { ...request(), stop_sequences: [1] }, { ...request(), metadata: { user_id: 42 } },
  ])("rejects malformed request %# without coercion", value => {
    expect(parseMessagesRequest(value).ok).toBe(false);
  });

  it.each([
    { type: "text", text: 1 }, { type: "tool_use", id: "call_x", name: "clock", input: "{}" },
    { type: "tool_use", id: "", name: "clock", input: {} }, { type: "tool_result", tool_use_id: "call_x", is_error: "true" },
    { type: "tool_result", tool_use_id: "call_x", content: [{ type: "tool_use", id: "nested", name: "clock", input: {} }] },
    { type: "image", source: { type: "base64", data: "abc", media_type: "application/pdf" } },
    { type: "image", source: { type: "url", url: 42 } }, { type: "thinking", thinking: "private", signature: 42 },
    { type: "thinking", thinking: "private" }, { type: "redacted_thinking", data: {} },
  ])("rejects malformed known content %#", block => {
    expect(parseMessagesRequest({ ...request(), messages: [{ role: "user", content: [block] }] }).ok).toBe(false);
  });

  it("rejects extensions by default and preserves them only when requested", () => {
    const value = { ...request(), provider_hint: { mode: "native" }, messages: [{ role: "user", content: [{ type: "text", text: "Hi", provider_tag: { value: 1 } }] }] };
    expect(parseMessagesRequest(value)).toMatchObject({ ok: false, error: { kind: "unsupported_feature" } });
    expect(parseMessagesRequest(value, { unknownFields: "preserve" })).toEqual({ ok: true, value });
    // Preserve is not permission to reinterpret malformed known fields.
    expect(parseMessagesRequest({ ...value, max_tokens: "2048" }, { unknownFields: "preserve" }).ok).toBe(false);
  });

  it("reports unknown content/tool types explicitly even in preserve mode", () => {
    for (const unknownFields of ["reject", "preserve"] as const) {
      const unknownBlock = { ...request(), messages: [{ role: "user", content: [{ type: "future_block", data: "retained by caller" }] }] };
      expect(parseMessagesRequest(unknownBlock, { unknownFields })).toMatchObject({ ok: false, error: { kind: "unsupported_feature" } });
      expect(parseMessagesRequest({ ...request(), messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_x", content: [{ type: "future_block" }] }] }] }, { unknownFields })).toMatchObject({ ok: false, error: { kind: "unsupported_feature" } });
      expect(parseMessagesRequest({ ...request(), system: [{ type: "future_system_block" }] }, { unknownFields })).toMatchObject({ ok: false, error: { kind: "unsupported_feature" } });
      expect(parseMessagesRequest({ ...request(), tools: [{ type: "server_tool_future", name: "server" }] }, { unknownFields })).toMatchObject({ ok: false, error: { kind: "unsupported_feature" } });
    }
  });
});

describe("Messages response and usage wire validation", () => {
  it('accepts complete official response metadata shape without treating server-tool counters as priced tokens', () => {
    // Official Message create response shape, fetched 2026-09-06; IDs/text sanitized.
    // https://platform.claude.com/docs/en/api/messages/create
    const full = { id: 'msg_official_fixture', type: 'message', role: 'assistant', model: 'claude-opus-5',
      container: { id: 'container_fixture', expires_at: '2026-09-06T00:00:00.000Z', skills: [{ skill_id: 'pdf', type: 'anthropic', version: 'latest' }] },
      content: [{ type: 'text', text: 'Synthetic reply.', citations: [] }], stop_reason: 'end_turn', stop_sequence: null,
      stop_details: { type: 'refusal', category: 'cyber', explanation: 'Synthetic explanation.' },
      usage: { input_tokens: 2095, output_tokens: 503, cache_creation_input_tokens: 2051, cache_read_input_tokens: 2051,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }, output_tokens_details: { thinking_tokens: 0 },
        inference_geo: 'global', server_tool_use: { web_fetch_requests: 2, web_search_requests: 0 }, service_tier: 'standard' } };
    // Wire shape acceptance is separate from P14's accounting/contradiction checks.
    expect(parseMessagesResponse(full)).toEqual({ ok: true, value: full });
    const neutral = { ...full, container: null, stop_details: null, usage: { ...full.usage, server_tool_use: null, service_tier: null, inference_geo: null } };
    expect(parseMessagesResponse(neutral).ok).toBe(true);
    for (const extra of [{ service_tier: 'imaginary' }, { inference_geo: {} }, { server_tool_use: {} }, { server_tool_use: { web_fetch_requests: -1, web_search_requests: 0 } }, { unknown: true }]) {
      expect(parseMessagesResponse({ ...full, usage: { ...full.usage, ...extra } }).ok).toBe(false);
    }
    expect(parseMessagesResponse({ ...full, container: { id: 'x', expires_at: 'tomorrow' } }).ok).toBe(false);
    expect(parseMessagesResponse({ ...full, stop_details: { type: 'refusal', category: 1, explanation: null } }).ok).toBe(false);
    const delta = { type: 'message_delta', delta: { stop_reason: 'refusal', stop_sequence: null, stop_details: { type: 'refusal', category: null, explanation: null } }, usage: { output_tokens: 0, service_tier: 'priority', inference_geo: 'global', server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 } } };
    expect(parseMessagesStreamEvent(delta)).toEqual({ ok: true, value: delta });
  });
  it.each(["end_turn", "max_tokens", "stop_sequence", "tool_use", "pause_turn", "refusal", "model_context_window_exceeded"] satisfies MessagesStopReason[])("retains %s without mapping it to success", stop_reason => {
    const value = { ...response(), stop_reason, stop_sequence: stop_reason === "stop_sequence" ? "END" : null };
    expect(parseMessagesResponse(value)).toEqual({ ok: true, value });
  });

  it("retains cache TTL and reasoning usage without summing or double counting", () => {
    const value: MessagesResponse = { ...response(), usage: {
      input_tokens: 0, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 50,
      cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30 }, output_tokens_details: { thinking_tokens: 4 },
    } };
    expect(parseMessagesResponse(value)).toEqual({ ok: true, value });
  });

  it("keeps missing usage missing and permits an empty content list", () => {
    const { usage: _unused, ...value } = response();
    const parsed = parseMessagesResponse({ ...value, content: [] });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(Object.hasOwn(parsed.value, "usage")).toBe(false);
  });

  it.each([
    { ...response(), role: "user" }, { ...response(), content: "text" }, { ...response(), stop_reason: "finish" },
    { ...response(), usage: { input_tokens: -1, output_tokens: 0 } }, { ...response(), usage: { input_tokens: 0, output_tokens: 1.2 } },
    { ...response(), usage: { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 0 } },
    { ...response(), usage: { input_tokens: 0 } }, { ...response(), usage: null },
    { ...response(), usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: -1 } },
    { ...response(), usage: { input_tokens: 0, output_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 2 } } },
  ])("rejects malformed response %#", value => expect(parseMessagesResponse(value).ok).toBe(false));

  it("preserves response extensions explicitly and reports invalid response errors", () => {
    const value = { ...response(), vendor_finish: "opaque" };
    expect(parseMessagesResponse(value)).toMatchObject({ ok: false, error: { kind: "unsupported_feature" } });
    expect(parseMessagesResponse(value, { unknownFields: "preserve" })).toEqual({ ok: true, value });
    expect(parseMessagesResponse({})).toMatchObject({ ok: false, error: { kind: "invalid_response" } });
  });
});

describe("Messages decoded SSE event validation", () => {
  const events: MessagesStreamEvent[] = [
    { type: "message_start", message: { ...response(), content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "synthetic private fragment" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "opaque-signature-fragment" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call_x", name: "clock", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"zone\":" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"UTC\"}" } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Visible answer" } },
    { type: "content_block_delta", index: 2, delta: { type: "citations_delta", citation: { type: "synthetic_reference", cited_text: "example" } } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 10, input_tokens: null, cache_creation_input_tokens: null } },
    { type: "message_stop" }, { type: "ping" },
    { type: "error", error: { type: "overloaded_error", message: "Synthetic overload" }, request_id: null },
  ];

  it.each(events)("accepts native event %# without processing the lifecycle", value => {
    expect(parseMessagesStreamEvent(value)).toEqual({ ok: true, value });
  });

  it("does not accumulate message_delta usage or synthesize missing usage", () => {
    const first = { type: "message_delta", delta: { stop_reason: null, stop_sequence: null }, usage: { output_tokens: 3 } };
    const last = { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } };
    expect(parseMessagesStreamEvent(first)).toEqual({ ok: true, value: first });
    expect(parseMessagesStreamEvent(last)).toEqual({ ok: true, value: last });
    const noUsage = { type: "message_delta", delta: { stop_reason: "max_tokens", stop_sequence: null } };
    expect(parseMessagesStreamEvent(noUsage)).toEqual({ ok: true, value: noUsage });
  });

  it.each([
    { type: "content_block_stop", index: -1 }, { type: "content_block_stop", index: 0.5 }, { type: "content_block_stop" },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: 1 } },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: -1 } },
    { type: "message_start", message: { id: "msg_missing_fields" } }, { type: "error", error: { type: "overloaded_error" } },
  ])("rejects malformed known event %#", value => expect(parseMessagesStreamEvent(value).ok).toBe(false));

  it("reports unknown event/delta/block types, including in preserve mode", () => {
    for (const value of [
      { type: "future_event" }, { type: "content_block_delta", index: 0, delta: { type: "future_delta" } },
      { type: "content_block_start", index: 0, content_block: { type: "future_block" } },
    ]) expect(parseMessagesStreamEvent(value, { unknownFields: "preserve" })).toMatchObject({ ok: false, error: { kind: "unsupported_feature" } });
    const value = { type: "ping", vendor_time: 123 };
    expect(parseMessagesStreamEvent(value).ok).toBe(false);
    expect(parseMessagesStreamEvent(value, { unknownFields: "preserve" })).toEqual({ ok: true, value });
  });
});
