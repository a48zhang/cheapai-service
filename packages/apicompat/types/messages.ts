import type { ConversionResult, JsonObject } from "./shared.js";

/**
 * Original Messages wire subset (not OAuth or a conversion layer).
 * Reference: https://platform.claude.com/docs/en/api/http/messages/create
 * SSE: https://platform.claude.com/docs/en/build-with-claude/streaming
 * Unknown fields are rejected by default. Explicit preserve mode retains them
 * for later capability decisions, never authorizes cross-protocol forwarding.
 */
interface MessagesFields { readonly [key: string]: unknown }

export interface MessagesCacheControl extends MessagesFields {
  readonly type: "ephemeral";
  readonly ttl?: "5m" | "1h";
}

interface MessagesCacheable extends MessagesFields {
  readonly cache_control?: MessagesCacheControl | null;
}

export interface MessagesTextBlock extends MessagesCacheable {
  readonly type: "text";
  readonly text: string;
  /** Citation variants remain native JSON; this subset does not interpret them. */
  readonly citations?: readonly JsonObject[] | null;
}

export type MessagesImageSource =
  | { readonly type: "url"; readonly url: string }
  | { readonly type: "base64"; readonly media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; readonly data: string };

export interface MessagesImageBlock extends MessagesCacheable {
  readonly type: "image";
  readonly source: MessagesImageSource;
}

export interface MessagesToolUseBlock extends MessagesCacheable {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject;
}

export interface MessagesToolResultBlock extends MessagesCacheable {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content?: string | readonly (MessagesTextBlock | MessagesImageBlock)[];
  readonly is_error?: boolean;
}

/** Preserve thinking and its opaque signature verbatim; no authenticity claim. */
export interface MessagesThinkingBlock extends MessagesFields {
  readonly type: "thinking";
  readonly thinking: string;
  readonly signature: string;
}

export interface MessagesRedactedThinkingBlock extends MessagesFields {
  readonly type: "redacted_thinking";
  readonly data: string;
}

export type MessagesOutputBlock = MessagesTextBlock | MessagesToolUseBlock | MessagesThinkingBlock | MessagesRedactedThinkingBlock;
export type MessagesContentBlock = MessagesOutputBlock | MessagesImageBlock | MessagesToolResultBlock;

export interface MessagesMessage extends MessagesFields {
  readonly role: "user" | "assistant";
  readonly content: string | readonly MessagesContentBlock[];
}

export interface MessagesTool extends MessagesCacheable {
  readonly type?: "custom";
  readonly name: string;
  readonly description?: string;
  readonly input_schema: JsonObject & { readonly type: "object" };
  readonly strict?: boolean;
}

export type MessagesToolChoice =
  | { readonly type: "auto" | "any"; readonly disable_parallel_tool_use?: boolean }
  | { readonly type: "tool"; readonly name: string; readonly disable_parallel_tool_use?: boolean }
  | { readonly type: "none" };

export type MessagesThinkingConfig =
  | { readonly type: "enabled"; readonly budget_tokens: number; readonly display?: "summarized" | "omitted" | null }
  | { readonly type: "adaptive"; readonly display?: "summarized" | "omitted" | null }
  | { readonly type: "disabled" };

/** Current native request shape, checked 2026-09-06:
 * https://platform.claude.com/docs/en/api/messages/create#body-output-config
 * Effort is a model-dependent behavior control, not a fixed thinking budget.
 */
export interface MessagesOutputConfig extends MessagesFields {
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
  readonly format?: { readonly type: "json_schema"; readonly schema: JsonObject } | null;
}

export interface MessagesRequest extends MessagesCacheable {
  readonly model: string;
  readonly max_tokens: number;
  readonly messages: readonly MessagesMessage[];
  readonly system?: string | readonly MessagesTextBlock[];
  readonly stream?: boolean;
  readonly tools?: readonly MessagesTool[];
  readonly tool_choice?: MessagesToolChoice;
  readonly thinking?: MessagesThinkingConfig;
  readonly output_config?: MessagesOutputConfig;
  readonly temperature?: number;
  readonly top_p?: number;
  readonly top_k?: number;
  readonly stop_sequences?: readonly string[];
  readonly metadata?: { readonly user_id?: string | null };
}

export type MessagesStopReason = "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "pause_turn" | "refusal" | "model_context_window_exceeded";

export interface MessagesUsageDetails extends MessagesFields {
  readonly service_tier?: 'standard' | 'priority' | 'batch' | null;
  readonly inference_geo?: string | null;
  /** Presentation counters only; nonzero server-tool usage is not priced in phase one. */
  readonly server_tool_use?: { readonly web_fetch_requests: number; readonly web_search_requests: number } | null;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
  readonly cache_creation?: {
    readonly ephemeral_5m_input_tokens: number;
    readonly ephemeral_1h_input_tokens: number;
  } | null;
  readonly output_tokens_details?: { readonly thinking_tokens: number } | null;
}

/** Native input_tokens excludes cache reads/writes; do not rewrite these here. */
export interface MessagesUsage extends MessagesUsageDetails {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

/** message_delta usage is cumulative, despite the event's name. */
export interface MessagesDeltaUsage extends MessagesUsageDetails {
  readonly input_tokens?: number | null;
  readonly output_tokens: number;
}

export interface MessagesResponse extends MessagesFields {
  readonly id: string;
  readonly type: "message";
  readonly role: "assistant";
  readonly model: string;
  readonly content: readonly MessagesOutputBlock[];
  /** null is needed for the message_start payload; no completion is inferred. */
  readonly stop_reason: MessagesStopReason | null;
  readonly stop_sequence: string | null;
  /** Compatible providers may omit usage; absence stays absence. */
  readonly usage?: MessagesUsage;
  readonly container?: MessagesContainer | null;
  readonly stop_details?: MessagesStopDetails | null;
}
/** Standard response metadata, not permission to execute containers/server tools. */
export interface MessagesContainer {
  readonly id: string;
  readonly expires_at: string;
  readonly skills?: readonly { readonly skill_id: string; readonly type: 'anthropic' | 'custom'; readonly version: string }[];
}
export interface MessagesStopDetails {
  readonly type: 'refusal';
  readonly category: string | null;
  readonly explanation: string | null;
  readonly recommended_model?: string | null;
}

export interface MessagesError extends MessagesFields {
  readonly type: "error";
  readonly error: { readonly type: string; readonly message: string; readonly [key: string]: unknown };
  readonly request_id?: string | null;
}

export type MessagesContentDelta =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "input_json_delta"; readonly partial_json: string }
  | { readonly type: "thinking_delta"; readonly thinking: string }
  | { readonly type: "signature_delta"; readonly signature: string }
  | { readonly type: "citations_delta"; readonly citation: JsonObject };

/** Decoded SSE data objects. Framing/UTF-8 and ordering belong to streams/. */
export type MessagesStreamEvent = MessagesFields & (
  | { readonly type: "message_start"; readonly message: MessagesResponse }
  | { readonly type: "content_block_start"; readonly index: number; readonly content_block: MessagesOutputBlock }
  | { readonly type: "content_block_delta"; readonly index: number; readonly delta: MessagesContentDelta }
  | { readonly type: "content_block_stop"; readonly index: number }
  | { readonly type: "message_delta"; readonly delta: { readonly stop_reason: MessagesStopReason | null; readonly stop_sequence: string | null; readonly stop_details?: MessagesStopDetails | null }; readonly usage?: MessagesDeltaUsage }
  | { readonly type: "message_stop" }
  | { readonly type: "ping" }
  | MessagesError
);

export interface MessagesValidationOptions {
  readonly unknownFields?: "reject" | "preserve";
}

type ObjectValue = Record<string, unknown>;
type Check = (value: unknown) => boolean;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const string: Check = value => typeof value === "string";
const nonempty: Check = value => typeof value === "string" && value.length > 0;
const boolean: Check = value => typeof value === "boolean";
const count: Check = value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const positive: Check = value => count(value) && (value as number) > 0;
const probability: Check = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const nullable = (check: Check): Check => value => value === null || check(value);
const list = (check: Check): Check => value => Array.isArray(value) && value.every(check);
const oneOf = (...values: readonly string[]): Check => value => typeof value === "string" && values.includes(value);
const optional = (value: ObjectValue, key: string, check: Check): boolean => !Object.hasOwn(value, key) || check(value[key]);

/** Decoded JSON only. Bounded recursion also rejects cycles/depth abuse. */
function json(value: unknown): boolean {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (entry: unknown, depth: number): boolean => {
    if (depth > 64 || ++nodes > 100_000) return false;
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return true;
    if (typeof entry === "number") return Number.isFinite(entry);
    if (!object(entry) && !Array.isArray(entry)) return false;
    if (seen.has(entry) || Object.getOwnPropertySymbols(entry).length) return false;
    seen.add(entry);
    if (!Array.isArray(entry) && Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null) return false;
    const names = Object.keys(entry);
    if (names.length > 100_000 || (Array.isArray(entry) && (names.length !== entry.length || names.some((name, index) => name !== String(index))))) return false;
    return names.every(name => {
      const field = Object.getOwnPropertyDescriptor(entry, name);
      return field !== undefined && "value" in field && visit(field.value, depth + 1);
    });
  };
  return visit(value, 0);
}

/** One local validator per call; no mutable state is shared across requests. */
function checks(options: MessagesValidationOptions) {
  let unsupported = false;
  function keys(value: ObjectValue, names: readonly string[]): boolean {
    if (options.unknownFields === "preserve") return true;
    if (Object.keys(value).some(name => !names.includes(name))) { unsupported = true; return false; }
    return true;
  }
  function unknownType(value: ObjectValue): false {
    if (nonempty(value.type)) unsupported = true;
    return false;
  }

  function cache(value: unknown): boolean {
    return value === null || (object(value) && value.type === "ephemeral" && optional(value, "ttl", oneOf("5m", "1h")) && keys(value, ["type", "ttl"]));
  }

  function textBlock(value: unknown): boolean {
    return object(value) && value.type === "text" && string(value.text)
      && optional(value, "cache_control", cache) && optional(value, "citations", nullable(list(object))) && keys(value, ["type", "text", "cache_control", "citations"]);
  }

  function imageBlock(value: unknown): boolean {
    if (!object(value) || value.type !== "image" || !object(value.source) || !optional(value, "cache_control", cache) || !keys(value, ["type", "source", "cache_control"])) return false;
    const source = value.source;
    // Shape only: do not fetch URLs, decode images or claim media validity.
    return source.type === "url" ? nonempty(source.url) && keys(source, ["type", "url"])
      : source.type === "base64" && nonempty(source.data) && oneOf("image/jpeg", "image/png", "image/gif", "image/webp")(source.media_type) && keys(source, ["type", "data", "media_type"]);
  }

  function outputBlock(value: unknown): boolean {
    if (!object(value)) return false;
    switch (value.type) {
      case "text": return textBlock(value);
      case "tool_use": return nonempty(value.id) && nonempty(value.name) && object(value.input) && optional(value, "cache_control", cache) && keys(value, ["type", "id", "name", "input", "cache_control"]);
      case "thinking": return string(value.thinking) && string(value.signature) && keys(value, ["type", "thinking", "signature"]);
      case "redacted_thinking": return nonempty(value.data) && keys(value, ["type", "data"]);
      default: return unknownType(value);
    }
  }

  function contentBlock(value: unknown): boolean {
    if (!object(value)) return false;
    if (value.type === "image") return imageBlock(value);
    if (value.type !== "tool_result") return outputBlock(value);
    return nonempty(value.tool_use_id)
      && optional(value, "is_error", boolean) && optional(value, "cache_control", cache)
      && optional(value, "content", content => string(content) || list(block => {
        if (!object(block)) return false;
        return block.type === "text" ? textBlock(block) : block.type === "image" ? imageBlock(block) : unknownType(block);
      })(content))
      && keys(value, ["type", "tool_use_id", "content", "is_error", "cache_control"]);
  }

  function tool(value: unknown): boolean {
    if (!object(value)) return false;
    if (Object.hasOwn(value, "type") && value.type !== "custom") return unknownType(value);
    if (!nonempty(value.name) || !object(value.input_schema) || value.input_schema.type !== "object") return false;
    return optional(value, "type", oneOf("custom")) && optional(value, "description", string)
      && optional(value, "cache_control", cache) && optional(value, "strict", boolean)
      && optional(value.input_schema, "properties", nullable(object)) && optional(value.input_schema, "required", nullable(list(string)))
      && keys(value, ["type", "name", "description", "input_schema", "cache_control", "strict"]);
  }

  function toolChoice(value: unknown): boolean {
    return object(value) && oneOf("auto", "any", "tool", "none")(value.type)
      && (value.type !== "tool" || nonempty(value.name)) && optional(value, "disable_parallel_tool_use", boolean)
      && keys(value, value.type === "tool" ? ["type", "name", "disable_parallel_tool_use"] : value.type === "none" ? ["type"] : ["type", "disable_parallel_tool_use"]);
  }

  function thinking(value: unknown): boolean {
    return object(value) && oneOf("enabled", "disabled", "adaptive")(value.type)
      && (value.type !== "enabled" || positive(value.budget_tokens))
      && optional(value, "display", nullable(oneOf("summarized", "omitted")))
      && keys(value, value.type === "enabled" ? ["type", "budget_tokens", "display"] : value.type === "disabled" ? ["type"] : ["type", "display"]);
  }

  function usage(value: unknown, delta: boolean): boolean {
    if (!object(value) || !count(value.output_tokens)) return false;
    if (delta ? !optional(value, "input_tokens", nullable(count)) : !count(value.input_tokens)) return false;
    return optional(value, "cache_creation_input_tokens", nullable(count)) && optional(value, "cache_read_input_tokens", nullable(count))
      && optional(value, "cache_creation", nullable(entry => object(entry) && count(entry.ephemeral_5m_input_tokens) && count(entry.ephemeral_1h_input_tokens) && keys(entry, ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"])))
      && optional(value, "output_tokens_details", nullable(entry => object(entry) && count(entry.thinking_tokens) && keys(entry, ["thinking_tokens"])))
      && optional(value, 'service_tier', nullable(oneOf('standard', 'priority', 'batch')))
      && optional(value, 'inference_geo', nullable(string))
      && optional(value, 'server_tool_use', nullable(entry => object(entry) && count(entry.web_fetch_requests) && count(entry.web_search_requests) && keys(entry, ['web_fetch_requests', 'web_search_requests'])))
      && keys(value, ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "cache_creation", "output_tokens_details", 'service_tier', 'inference_geo', 'server_tool_use']);
  }

  function container(value: unknown): boolean {
    return object(value) && nonempty(value.id) && string(value.expires_at)
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value.expires_at as string) && Number.isFinite(Date.parse(value.expires_at as string))
      && optional(value, 'skills', entry => Array.isArray(entry) && entry.length <= 20 && entry.every(skill => object(skill)
        && nonempty(skill.skill_id) && oneOf('anthropic', 'custom')(skill.type) && nonempty(skill.version) && keys(skill, ['skill_id', 'type', 'version'])))
      && keys(value, ['id', 'expires_at', 'skills']);
  }
  function stopDetails(value: unknown): boolean {
    return object(value) && value.type === 'refusal' && nullable(string)(value.category) && nullable(string)(value.explanation)
      && optional(value, 'recommended_model', nullable(nonempty)) && keys(value, ['type', 'category', 'explanation', 'recommended_model']);
  }

  const stopReason = nullable(oneOf("end_turn", "max_tokens", "stop_sequence", "tool_use", "pause_turn", "refusal", "model_context_window_exceeded"));

  function response(value: unknown): boolean {
    return object(value) && value.type === "message" && value.role === "assistant" && nonempty(value.id) && nonempty(value.model)
      && list(outputBlock)(value.content) && stopReason(value.stop_reason) && nullable(string)(value.stop_sequence)
      && optional(value, "usage", entry => usage(entry, false))
      && optional(value, 'container', nullable(container)) && optional(value, 'stop_details', nullable(stopDetails))
      && keys(value, ["id", "type", "role", "model", "content", "stop_reason", "stop_sequence", "usage", 'container', 'stop_details']);
  }

  function delta(value: unknown): boolean {
    if (!object(value)) return false;
    switch (value.type) {
      case "text_delta": return string(value.text) && keys(value, ["type", "text"]);
      case "input_json_delta": return string(value.partial_json) && keys(value, ["type", "partial_json"]); // Fragments need not parse.
      case "thinking_delta": return string(value.thinking) && keys(value, ["type", "thinking"]);
      case "signature_delta": return string(value.signature) && keys(value, ["type", "signature"]);
      case "citations_delta": return object(value.citation) && keys(value, ["type", "citation"]);
      default: return unknownType(value);
    }
  }

  function streamEvent(value: unknown): boolean {
    if (!object(value)) return false;
    switch (value.type) {
      case "message_start": return response(value.message) && keys(value, ["type", "message"]);
      case "content_block_start": return count(value.index) && outputBlock(value.content_block) && keys(value, ["type", "index", "content_block"]);
      case "content_block_delta": return count(value.index) && delta(value.delta) && keys(value, ["type", "index", "delta"]);
      case "content_block_stop": return count(value.index) && keys(value, ["type", "index"]);
      case "message_delta": return object(value.delta) && stopReason(value.delta.stop_reason) && nullable(string)(value.delta.stop_sequence)
        && optional(value.delta, 'stop_details', nullable(stopDetails)) && keys(value.delta, ["stop_reason", "stop_sequence", 'stop_details'])
        && optional(value, "usage", entry => usage(entry, true)) && keys(value, ["type", "delta", "usage"]);
      case "message_stop": case "ping": return keys(value, ["type"]);
      case "error": return object(value.error) && nonempty(value.error.type) && string(value.error.message)
        && keys(value.error, ["type", "message"]) && optional(value, "request_id", nullable(string)) && keys(value, ["type", "error", "request_id"]);
      default: return unknownType(value);
    }
  }

  function failure<T>(kind: "invalid_request" | "invalid_response", param: string): ConversionResult<T> {
    return { ok: false, error: { kind: unsupported ? "unsupported_feature" : kind, code: unsupported ? "unsupported_messages_feature" : "invalid_messages_shape", message: `Unsupported or invalid Messages structure at ${param}.`, param } };
  }

  function request(value: unknown): ConversionResult<MessagesRequest> {
    if (!json(value) || !object(value)) return failure("invalid_request", "body");
    if (!nonempty(value.model)) return failure("invalid_request", "model");
    if (!positive(value.max_tokens)) return failure("invalid_request", "max_tokens");
    if (!Array.isArray(value.messages) || value.messages.length === 0 || !value.messages.every(message => object(message)
      && oneOf("user", "assistant")(message.role) && (string(message.content) || list(contentBlock)(message.content)) && keys(message, ["role", "content"]))) return failure("invalid_request", "messages");
    const checks: readonly [string, Check][] = [
      ["system", system => string(system) || list(block => object(block) && (block.type === "text" ? textBlock(block) : unknownType(block)))(system)], ["stream", boolean], ["tools", list(tool)],
      ["tool_choice", toolChoice], ["thinking", thinking], ["cache_control", cache], ["temperature", probability],
      ["top_p", probability], ["top_k", count], ["stop_sequences", list(string)],
      ["metadata", entry => object(entry) && optional(entry, "user_id", nullable(string)) && keys(entry, ["user_id"])],
      ["output_config", entry => object(entry)
        && optional(entry, "effort", nullable(oneOf("low", "medium", "high", "xhigh", "max")))
        && optional(entry, "format", format => format === null || (object(format) && format.type === "json_schema"
          && object(format.schema) && keys(format, ["type", "schema"])))
        && keys(entry, ["effort", "format"])],
    ];
    for (const [key, check] of checks) if (!optional(value, key, check)) return failure("invalid_request", key);
    if (!keys(value, ["model", "max_tokens", "messages", ...checks.map(([key]) => key)])) return failure("invalid_request", "body");
    return { ok: true, value: value as unknown as MessagesRequest };
  }

  return { request, response, streamEvent, failure };
}

/** Structural validation only: no model capability, tool-pairing or signature checks. */
export function parseMessagesRequest(value: unknown, options: MessagesValidationOptions = {}): ConversionResult<MessagesRequest> {
  return checks(options).request(value);
}

export function parseMessagesResponse(value: unknown, options: MessagesValidationOptions = {}): ConversionResult<MessagesResponse> {
  const check = checks(options);
  return json(value) && check.response(value) ? { ok: true, value: value as MessagesResponse } : check.failure("invalid_response", "response");
}

export function parseMessagesStreamEvent(value: unknown, options: MessagesValidationOptions = {}): ConversionResult<MessagesStreamEvent> {
  const check = checks(options);
  return json(value) && check.streamEvent(value) ? { ok: true, value: value as MessagesStreamEvent } : check.failure("invalid_response", "event");
}
