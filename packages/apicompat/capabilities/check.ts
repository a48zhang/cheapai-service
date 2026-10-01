import { parseChatRequest } from "../types/chat.js";
import type { ChatRequest } from "../types/chat.js";
import { validateResponsesRequest } from "../types/responses.js";
import type { ResponsesRequest } from "../types/responses.js";
import { parseMessagesRequest } from "../types/messages.js";
import type { MessagesRequest } from "../types/messages.js";
import type { ConversionDirection, ConversionResult, Protocol, ProtocolError } from "../types/shared.js";

export type ProtocolRequest =
  | { readonly protocol: "chat"; readonly request: ChatRequest }
  | { readonly protocol: "responses"; readonly request: ResponsesRequest }
  | { readonly protocol: "messages"; readonly request: MessagesRequest };

/** Each entry is a model/channel assertion, never inferred from its protocol. */
export type CapabilityFeature =
  | "streaming" | "stream_usage" | "tools" | "tool_choice" | "parallel_tools" | "parallel_tool_control" | "strict_tools"
  | "image_url" | "image_base64" | "image_file_id" | "image_detail" | "tool_result_images" | "tool_result_error" | "refusal_history"
  | "json_object" | "json_schema" | "reasoning_effort" | "reasoning_summary"
  | "reasoning_history" | "thinking_budget" | "thinking_adaptive" | "thinking_control"
  | "signed_thinking" | "redacted_thinking" | "encrypted_reasoning" | "cache_control"
  | "response_history" | "item_references" | "file_inputs" | "file_references"
  | "temperature" | "top_p" | "top_k" | "stop_sequences" | "seed" | "penalties"
  | "multiple_choices" | "service_tier" | "metadata" | "message_names" | "store"
  | "verbosity" | "citations" | "logprobs" | "system_developer_priority";

export type ExtensionScope = "request" | "message" | "content" | "image_source" | "tool" | "tool_function"
  | "tool_call" | "tool_choice" | "response_format" | "reasoning" | "text" | "thinking" | "cache_control" | "stream_options" | "metadata" | "output_config";

export interface NativeExtensionPermission {
  readonly scope: ExtensionScope;
  readonly name: string;
}

export interface ChannelCapabilities {
  readonly protocol: Protocol;
  /** Absent entries are unsupported. Basic text needs no feature flag. */
  readonly features: readonly CapabilityFeature[];
  readonly maxOutputTokens?: number;
  /** Explicit policy default needed when converting an uncapped request to Messages. */
  readonly reasoningEfforts?: readonly string[];
  readonly cacheTtls?: readonly ("5m" | "1h")[];
  /** Exact structural scope/name allowlist, effective only for same-protocol data. */
  readonly nativeExtensions?: readonly NativeExtensionPermission[];
}

export interface FeatureRequirement {
  readonly feature: CapabilityFeature;
  readonly path: string;
  readonly mapping: "portable" | "native";
  readonly targets?: readonly Protocol[];
}

export interface RequestFeatures {
  readonly protocol: Protocol;
  readonly required: readonly FeatureRequirement[];
  readonly extensions: readonly (NativeExtensionPermission & { readonly path: string })[];
  readonly outputTokenLimit?: number;
  readonly temperature?: number;
  readonly reasoningEffort?: string;
  readonly cacheTtls: readonly ("5m" | "1h")[];
  readonly requiresHistoryBinding: boolean;
  readonly requiresFileBinding: boolean;
}

export type CapabilityReasonCode = "invalid_request" | "invalid_channel_capabilities" | "missing_capability"
  | "no_protocol_mapping" | "extension_not_allowed" | "output_limit_exceeded" | "output_limit_required"
  | "parameter_not_representable" | "reasoning_effort_not_supported" | "cache_ttl_not_supported";

export interface CapabilityReason {
  readonly code: CapabilityReasonCode;
  readonly path: string;
  readonly feature?: CapabilityFeature;
  /** Stable explanation without prompt, tool arguments, IDs or extension values. */
  readonly message: string;
}

export type RequiredCapabilityCheck = "response_history_binding" | "file_reference_binding";
export type CapabilityCheckResult = ConversionDirection & (
  | { readonly supported: true; readonly features: RequestFeatures; readonly requiredChecks: readonly RequiredCapabilityCheck[]; readonly outputTokenLimit?: number }
  | { readonly supported: false; readonly reasons: readonly CapabilityReason[]; readonly features?: RequestFeatures }
);

type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);
const records = (value: unknown): RecordValue[] => Array.isArray(value) ? value.filter(object) : [];
const present = (value: unknown): boolean => value !== undefined && value !== null;
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * Uses the existing wire validators, then examines protocol fields only. Tool
 * input/schema, arbitrary metadata and text are data, never traversed as wire.
 * This is a semantic prerequisite check, not a claim that a converter is shipped.
 */
export function identifyRequestFeatures(input: ProtocolRequest): ConversionResult<RequestFeatures> {
  const parsed = input.protocol === "chat" ? parseChatRequest(input.request, { unknownFields: "preserve" })
    : input.protocol === "responses" ? validateResponsesRequest(input.request, { unknownFields: "preserve" })
      : parseMessagesRequest(input.request, { unknownFields: "preserve" });
  if (!parsed.ok) return parsed;

  const request = input.request as RecordValue;
  const required: FeatureRequirement[] = [];
  const extensions: (NativeExtensionPermission & { path: string })[] = [];
  const cacheTtls = new Set<"5m" | "1h">();
  let cacheBreakpoints = 0;
  const invalid: ProtocolError[] = [];
  let outputTokenLimit: number | undefined;
  let reasoningEffort: string | undefined;
  let hasSystem = false;
  let hasDeveloper = false;
  let requiresHistoryBinding = false;
  let requiresFileBinding = false;

  const need = (feature: CapabilityFeature, path: string, native = false, targets?: readonly Protocol[]): void => {
    required.push({ feature, path, mapping: native ? "native" : "portable", ...(targets ? { targets } : {}) });
  };
  const bad = (path: string): void => { invalid.push({ kind: "invalid_request", code: "invalid_capability_constraint", param: path, message: "Invalid or conflicting request capability constraint." }); };
  const fields = (value: RecordValue, known: readonly string[], scope: ExtensionScope, path: string): void => {
    for (const name of Object.keys(value)) if (!known.includes(name)) extensions.push({ scope, name, path: `${path}.${name}` });
  };
  const effort = (value: unknown, path: string): void => {
    if (!present(value)) return;
    if (typeof value !== "string" || value.length === 0) { bad(path); return; }
    reasoningEffort = value;
    // Common named effort is a portable qualitative signal, never a token budget.
    // Other levels remain native to their source family; no max/xhigh guessing.
    need("reasoning_effort", path, false, ["low", "medium", "high"].includes(value)
      ? ["chat", "responses", "messages"] : input.protocol === "messages" ? ["messages"] : ["chat", "responses"]);
  };
  // Known Chat/Responses cache extension -> native Messages. Primary contract checked
  // 2026-09-06: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
  // Scope is request, tool definition or content block; not arbitrary JSON data.
  const cache = (value: unknown, path: string, chatExtension = false): void => {
    if (!present(value)) return;
    if (!object(value) || value.type !== "ephemeral" || (value.ttl !== undefined && value.ttl !== "5m" && value.ttl !== "1h")
      || Object.keys(value).some(key => key !== "type" && key !== "ttl")) { bad(path); return; }
    if (++cacheBreakpoints > 4) bad(path);
    need("cache_control", path, !chatExtension, chatExtension ? [input.protocol, "messages"] : undefined);
    cacheTtls.add(value.ttl === "1h" ? "1h" : "5m");
    fields(value, ["type", "ttl"], "cache_control", path);
  };
  const image = (url: unknown, path: string): void => {
    need(typeof url === "string" && url.startsWith("data:") ? "image_base64" : "image_url", path);
  };
  const format = (value: unknown, path: string, chat: boolean): void => {
    if (!object(value)) { bad(path); return; }
    if (value.type === "text") fields(value, ["type"], "response_format", path);
    else if (value.type === "json_object") { need("json_object", path, false, ["chat", "responses"]); fields(value, ["type"], "response_format", path); }
    else if (value.type === "json_schema") {
      const schema = chat ? value.json_schema : value;
      if (!object(schema) || !object(schema.schema) || typeof schema.name !== "string" || !schema.name) { bad(path); return; }
      if (present(schema.strict) && typeof schema.strict !== "boolean") bad(`${path}.strict`);
      if (present(schema.description) && typeof schema.description !== "string") bad(`${path}.description`);
      need("json_schema", path, false, schema.strict === true ? ["chat", "responses", "messages"] : ["chat", "responses"]);
      fields(schema, chat ? ["name", "schema", "description", "strict"] : ["type", "name", "schema", "description", "strict"], "response_format", `${path}${chat ? ".json_schema" : ""}`);
      if (chat) fields(value, ["type", "json_schema"], "response_format", path);
    } else bad(`${path}.type`);
  };
  const toolChoice = (value: unknown, path: string, messages = false): void => {
    if (!present(value)) return;
    // Even 'none' is a real constraint that an adapter must preserve.
    need("tool_choice", path);
    if (value === "required" || (object(value) && (value.type === "tool" || value.type === "function" || value.type === "any"))) need("tools", path);
    if (object(value)) {
      fields(value, messages ? ["type", "name", "disable_parallel_tool_use"] : input.protocol === "chat" ? ["type", "function"] : ["type", "name"], "tool_choice", path);
      if (object(value.function)) fields(value.function, ["name"], "tool_function", `${path}.function`);
      if (messages && typeof value.disable_parallel_tool_use === "boolean") need("parallel_tool_control", `${path}.disable_parallel_tool_use`);
      if (messages && value.disable_parallel_tool_use === false) need("parallel_tools", `${path}.disable_parallel_tool_use`);
    }
  };

  if (request.stream === true) need("streaming", "$.stream");
  if (present(request.temperature)) need("temperature", "$.temperature");
  if (present(request.top_p)) need("top_p", "$.top_p");
  if (present(request.metadata)) need("metadata", "$.metadata", true);

  if (input.protocol === "chat") {
    fields(request, ["model", "messages", "stream", "stream_options", "tools", "tool_choice", "parallel_tool_calls", "max_tokens", "max_completion_tokens", "temperature", "top_p", "stop", "n", "seed", "frequency_penalty", "presence_penalty", "response_format", "reasoning_effort", "service_tier", "user", "metadata", "cache_control"], "request", "$");
    cache(request.cache_control, "$.cache_control", true);
    if (positive(request.max_tokens) && positive(request.max_completion_tokens) && request.max_tokens !== request.max_completion_tokens) bad("$.max_completion_tokens");
    outputTokenLimit = positive(request.max_completion_tokens) ? request.max_completion_tokens : positive(request.max_tokens) ? request.max_tokens : undefined;
    if (request.parallel_tool_calls === true) need("parallel_tools", "$.parallel_tool_calls");
    if (typeof request.parallel_tool_calls === "boolean") need("parallel_tool_control", "$.parallel_tool_calls");
    if (present(request.stop) && (typeof request.stop === "string" || (Array.isArray(request.stop) && request.stop.length > 0))) need("stop_sequences", "$.stop", false, ["chat", "messages"]);
    for (const key of ["seed", "service_tier", "user"] as const) if (present(request[key])) need(key === "user" ? "metadata" : key, `$.${key}`, true);
    for (const key of ["frequency_penalty", "presence_penalty"] as const) if (present(request[key])) need("penalties", `$.${key}`, true);
    if (typeof request.n === "number" && request.n > 1) need("multiple_choices", "$.n", true);
    if (object(request.stream_options)) {
      fields(request.stream_options, ["include_usage"], "stream_options", "$.stream_options");
      if (request.stream_options.include_usage === true) need("stream_usage", "$.stream_options.include_usage");
    }
    if (present(request.response_format)) format(request.response_format, "$.response_format", true);
    effort(request.reasoning_effort, "$.reasoning_effort");
    records(request.tools).forEach((tool, i) => {
      const path = `$.tools[${i}]`; need("tools", path); fields(tool, ["type", "function", "cache_control"], "tool", path);
      cache(tool.cache_control, `${path}.cache_control`, true);
      if (object(tool.function)) {
        fields(tool.function, ["name", "description", "parameters", "strict"], "tool_function", `${path}.function`);
        if (tool.function.strict === true) need("strict_tools", `${path}.function.strict`);
      }
    });
    toolChoice(request.tool_choice, "$.tool_choice");
    records(request.messages).forEach((message, i) => {
      const path = `$.messages[${i}]`;
      fields(message, message.role === "assistant" ? ["role", "content", "name", "tool_calls", "refusal", "reasoning_content", "reasoning"]
        : message.role === "tool" ? ["role", "content", "tool_call_id"] : ["role", "content", "name"], "message", path);
      hasSystem ||= message.role === "system"; hasDeveloper ||= message.role === "developer";
      if (present(message.name)) need("message_names", `${path}.name`, true);
      if (message.role === "tool") need("tools", path);
      if (present(message.refusal)) need("refusal_history", `${path}.refusal`, false, ["chat", "responses"]);
      for (const key of ["reasoning", "reasoning_content"] as const) if (present(message[key])) need("reasoning_history", `${path}.${key}`, true);
      const calls = records(message.tool_calls);
      if (calls.length > 1) need("parallel_tools", `${path}.tool_calls`);
      calls.forEach((call, j) => {
        const p = `${path}.tool_calls[${j}]`; need("tools", p); fields(call, ["id", "type", "function"], "tool_call", p);
        if (object(call.function)) fields(call.function, ["name", "arguments"], "tool_function", `${p}.function`);
      });
      records(message.content).forEach((block, j) => {
        const p = `${path}.content[${j}]`;
        fields(block, block.type === "image_url" ? ["type", "image_url", "cache_control"] : block.type === "refusal" ? ["type", "refusal"] : ["type", "text", "cache_control"], "content", p);
        if (block.type !== "refusal") cache(block.cache_control, `${p}.cache_control`, true);
        if (block.type === "refusal") need("refusal_history", p, false, ["chat", "responses"]);
        if (object(block.image_url)) {
          image(block.image_url.url, p); fields(block.image_url, ["url", "detail"], "image_source", `${p}.image_url`);
          if (present(block.image_url.detail) && block.image_url.detail !== "auto") need("image_detail", `${p}.image_url.detail`, false, ["chat", "responses"]);
        }
      });
    });
  } else if (input.protocol === "responses") {
    fields(request, ["model", "input", "instructions", "previous_response_id", "stream", "store", "background", "max_output_tokens", "temperature", "top_p", "tools", "tool_choice", "parallel_tool_calls", "metadata", "reasoning", "text", "cache_control"], "request", "$");
    cache(request.cache_control, "$.cache_control", true);
    outputTokenLimit = positive(request.max_output_tokens) ? request.max_output_tokens : undefined;
    if (request.background === true) { invalid.push({ kind: "unsupported_feature", code: "background_out_of_scope", param: "$.background", message: "Background generation is outside this HTTP gateway's scope." }); }
    if (present(request.store)) need("store", "$.store", true);
    if (present(request.previous_response_id)) { need("response_history", "$.previous_response_id", true); requiresHistoryBinding = true; }
    if (request.parallel_tool_calls === true) need("parallel_tools", "$.parallel_tool_calls");
    if (typeof request.parallel_tool_calls === "boolean") need("parallel_tool_control", "$.parallel_tool_calls");
    if (object(request.reasoning)) {
      effort(request.reasoning.effort, "$.reasoning.effort");
      if (present(request.reasoning.summary)) {
        if (typeof request.reasoning.summary !== "string" || !["auto", "concise", "detailed"].includes(request.reasoning.summary)) bad("$.reasoning.summary");
        need("reasoning_summary", "$.reasoning.summary", true);
      }
      fields(request.reasoning, ["effort", "summary"], "reasoning", "$.reasoning");
    }
    if (object(request.text)) {
      if (present(request.text.format)) format(request.text.format, "$.text.format", false);
      if (present(request.text.verbosity)) {
        if (typeof request.text.verbosity !== "string" || !["low", "medium", "high"].includes(request.text.verbosity)) bad("$.text.verbosity");
        need("verbosity", "$.text.verbosity", true);
      }
      fields(request.text, ["format", "verbosity"], "text", "$.text");
    }
    records(request.tools).forEach((tool, i) => {
      const path = `$.tools[${i}]`; need("tools", path); fields(tool, ["type", "name", "description", "parameters", "strict", "cache_control"], "tool", path);
      cache(tool.cache_control, `${path}.cache_control`, true);
      if (tool.strict === true) need("strict_tools", `${path}.strict`);
    });
    toolChoice(request.tool_choice, "$.tool_choice");
    const contents = (value: unknown, path: string, toolResult: boolean): void => {
      records(value).forEach((block, i) => {
        const p = `${path}[${i}]`;
        if (block.type === "input_image") {
          fields(block, ["type", "image_url", "file_id", "detail", "cache_control"], "content", p);
          cache(block.cache_control, `${p}.cache_control`, true);
          if (present(block.file_id)) { need("image_file_id", p, true); need("file_references", `${p}.file_id`, true); requiresFileBinding = true; }
          else image(block.image_url, p);
          if (toolResult) need("tool_result_images", p, false, ["messages", "responses"]);
          if (present(block.detail) && block.detail !== "auto") need("image_detail", `${p}.detail`, false, block.detail === "original" ? ["responses"] : ["chat", "responses"]);
        } else if (block.type === "input_file") {
          need("file_inputs", p, true); fields(block, ["type", "file_id", "file_url", "file_data", "filename"], "content", p);
          if (present(block.file_id)) { need("file_references", `${p}.file_id`, true); requiresFileBinding = true; }
        } else {
          fields(block, block.type === "refusal" ? ["type", "refusal"] : block.type === "output_text" ? ["type", "text", "annotations", "logprobs", "cache_control"] : ["type", "text", "cache_control"], "content", p);
          if (block.type !== "refusal") cache(block.cache_control, `${p}.cache_control`, true);
          if (block.type === "refusal") need("refusal_history", p, false, ["chat", "responses"]);
          if (Array.isArray(block.annotations) && block.annotations.length) need("citations", `${p}.annotations`, true);
          if (Array.isArray(block.logprobs) && block.logprobs.length) need("logprobs", `${p}.logprobs`, true);
        }
      });
    };
    let pendingCalls = 0;
    records(request.input).forEach((item, i) => {
      const path = `$.input[${i}]`;
      if (item.type === "function_call") {
        need("tools", path); if (++pendingCalls > 1) need("parallel_tools", path);
        fields(item, ["type", "call_id", "name", "arguments", "id", "status"], "tool_call", path);
      } else if (item.type === "function_call_output") {
        need("tools", path); pendingCalls = Math.max(0, pendingCalls - 1);
        fields(item, ["type", "call_id", "output", "id", "status"], "tool_call", path); contents(item.output, `${path}.output`, true);
      } else if (item.type === "reasoning") {
        need("reasoning_history", path, true); fields(item, ["type", "id", "summary", "encrypted_content", "status"], "content", path);
        if (present(item.encrypted_content)) need("encrypted_reasoning", `${path}.encrypted_content`, true);
        records(item.summary).forEach((entry, j) => fields(entry, ["type", "text"], "content", `${path}.summary[${j}]`));
      } else if (item.type === "item_reference") {
        need("item_references", path, true); requiresHistoryBinding = true; fields(item, ["type", "id"], "content", path);
      } else {
        pendingCalls = 0; fields(item, ["type", "role", "content", "id", "status"], "message", path);
        hasSystem ||= item.role === "system"; hasDeveloper ||= item.role === "developer";
        contents(item.content, `${path}.content`, false);
      }
    });
  } else {
    fields(request, ["model", "max_tokens", "messages", "system", "stream", "tools", "tool_choice", "thinking", "output_config", "temperature", "top_p", "top_k", "stop_sequences", "metadata", "cache_control"], "request", "$");
    if (object(request.output_config)) {
      fields(request.output_config, ["effort", "format"], "output_config", "$.output_config");
      effort(request.output_config.effort, "$.output_config.effort");
      if (object(request.output_config.format)) {
        need("json_schema", "$.output_config.format", false, ["messages", "chat", "responses"]);
        fields(request.output_config.format, ["type", "schema"], "response_format", "$.output_config.format");
      }
    }
    outputTokenLimit = request.max_tokens as number;
    if (object(request.metadata)) fields(request.metadata, ["user_id"], "metadata", "$.metadata");
    cache(request.cache_control, "$.cache_control");
    if (present(request.top_k)) need("top_k", "$.top_k", true);
    if (Array.isArray(request.stop_sequences) && request.stop_sequences.length) need("stop_sequences", "$.stop_sequences", false, ["chat", "messages"]);
    if (object(request.thinking)) {
      const thinking = request.thinking;
      need(thinking.type === "enabled" ? "thinking_budget" : thinking.type === "adaptive" ? "thinking_adaptive" : "thinking_control", "$.thinking", true);
      if (thinking.type === "enabled" && (typeof thinking.budget_tokens !== "number" || thinking.budget_tokens < 1024 || thinking.budget_tokens >= outputTokenLimit)) bad("$.thinking.budget_tokens");
      fields(thinking, thinking.type === "enabled" ? ["type", "budget_tokens", "display"] : thinking.type === "adaptive" ? ["type", "display"] : ["type"], "thinking", "$.thinking");
    }
    const blocks = (value: unknown, path: string, toolResult = false): void => {
      const entries = records(value);
      if (entries.filter(entry => entry.type === "tool_use").length > 1) need("parallel_tools", path);
      entries.forEach((block, i) => {
        const p = `${path}[${i}]`; cache(block.cache_control, `${p}.cache_control`);
        switch (block.type) {
          case "text":
            fields(block, ["type", "text", "cache_control", "citations"], "content", p);
            if (Array.isArray(block.citations) && block.citations.length) need("citations", `${p}.citations`, true);
            break;
          case "image":
            fields(block, ["type", "source", "cache_control"], "content", p);
            if (object(block.source)) {
              need(block.source.type === "base64" ? "image_base64" : "image_url", p);
              fields(block.source, block.source.type === "base64" ? ["type", "data", "media_type"] : ["type", "url"], "image_source", `${p}.source`);
            }
            if (toolResult) need("tool_result_images", p, false, ["messages", "responses"]);
            break;
          case "tool_use": need("tools", p); fields(block, ["type", "id", "name", "input", "cache_control"], "tool_call", p); break;
          case "tool_result":
            need("tools", p); if (block.is_error === true) need("tool_result_error", `${p}.is_error`, true);
            fields(block, ["type", "tool_use_id", "content", "is_error", "cache_control"], "tool_call", p); blocks(block.content, `${p}.content`, true); break;
          case "thinking": need("signed_thinking", p, true); fields(block, ["type", "thinking", "signature"], "content", p); break;
          case "redacted_thinking": need("redacted_thinking", p, true); fields(block, ["type", "data"], "content", p); break;
        }
      });
    };
    blocks(request.system, "$.system");
    records(request.messages).forEach((message, i) => { const p = `$.messages[${i}]`; fields(message, ["role", "content"], "message", p); blocks(message.content, `${p}.content`); });
    records(request.tools).forEach((tool, i) => {
      const p = `$.tools[${i}]`; need("tools", p); cache(tool.cache_control, `${p}.cache_control`);
      fields(tool, ["type", "name", "description", "input_schema", "cache_control", "strict"], "tool", p);
      if (tool.strict === true) need("strict_tools", `${p}.strict`);
    });
    toolChoice(request.tool_choice, "$.tool_choice", true);
  }
  if (hasSystem && hasDeveloper) need("system_developer_priority", "$.messages", false, ["chat", "responses"]);
  if (invalid[0]) return { ok: false, error: invalid[0] };
  return { ok: true, value: {
    protocol: input.protocol, required, extensions, cacheTtls: [...cacheTtls], requiresHistoryBinding, requiresFileBinding,
    ...(outputTokenLimit !== undefined ? { outputTokenLimit } : {}),
    ...(typeof request.temperature === "number" ? { temperature: request.temperature } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  } };
}

/**
 * Request direction is downstream -> upstream. No routing, forwarding, history
 * lookup or billing. Successful native references still require caller checks;
 * the gateway must also select an implemented direct converter (P22).
 */
export function checkRequestCapabilities(input: ProtocolRequest, channel: ChannelCapabilities): CapabilityCheckResult {
  const direction = { from: input.protocol, to: channel.protocol };
  const identified = identifyRequestFeatures(input);
  if (!identified.ok) return { ...direction, supported: false, reasons: [{ code: identified.error.kind === "unsupported_feature" ? "no_protocol_mapping" : "invalid_request", path: identified.error.param ?? "$", message: identified.error.message }] };
  const features = identified.value;
  const reasons: CapabilityReason[] = [];
  const problem = (code: CapabilityReasonCode, path: string, message: string, feature?: CapabilityFeature): void => { reasons.push({ code, path, message, ...(feature ? { feature } : {}) }); };
  if (channel.maxOutputTokens !== undefined && !positive(channel.maxOutputTokens)) {
    problem("invalid_channel_capabilities", "$channel", "Channel maximum output must be a positive safe integer.");
  }
  const supported = new Set(channel.features);
  for (const requirement of features.required) {
    if ((requirement.mapping === "native" && input.protocol !== channel.protocol) || (requirement.targets && !requirement.targets.includes(channel.protocol))) {
      problem("no_protocol_mapping", requirement.path, "This constraint has no equivalent mapping to the target protocol.", requirement.feature);
    } else if (!supported.has(requirement.feature)) {
      problem("missing_capability", requirement.path, "The channel does not declare this required capability.", requirement.feature);
    }
  }
  for (const extension of features.extensions) {
    if (input.protocol !== channel.protocol || !channel.nativeExtensions?.some(allowed => allowed.scope === extension.scope && allowed.name === extension.name)) {
      problem("extension_not_allowed", extension.path, "The extension requires an explicit same-protocol scope/name permission.");
    }
  }
  const outputTokenLimit = features.outputTokenLimit;
  if (channel.protocol === "messages" && outputTokenLimit === undefined) problem("output_limit_required", "$.max_tokens", "Messages requires an explicit output limit in the client request.");
  if (outputTokenLimit !== undefined && channel.maxOutputTokens !== undefined && outputTokenLimit > channel.maxOutputTokens) problem("output_limit_exceeded", "$.max_output_tokens", "Requested output exceeds the channel limit; it cannot be silently clamped.");
  if (channel.protocol === "messages" && features.temperature !== undefined && features.temperature > 1) problem("parameter_not_representable", "$.temperature", "Messages cannot represent this temperature without changing it.", "temperature");
  if (features.reasoningEffort !== undefined && !channel.reasoningEfforts?.includes(features.reasoningEffort)) problem("reasoning_effort_not_supported", "$.reasoning", "The channel does not declare the requested reasoning effort.", "reasoning_effort");
  for (const ttl of features.cacheTtls) if (!channel.cacheTtls?.includes(ttl)) problem("cache_ttl_not_supported", "$.cache_control", "The channel does not declare the requested cache TTL.", "cache_control");
  if (reasons.length) return { ...direction, supported: false, features, reasons };
  const requiredChecks: RequiredCapabilityCheck[] = [];
  if (features.requiresHistoryBinding) requiredChecks.push("response_history_binding");
  if (features.requiresFileBinding) requiredChecks.push("file_reference_binding");
  return { ...direction, supported: true, features, requiredChecks, ...(outputTokenLimit !== undefined ? { outputTokenLimit } : {}) };
}
