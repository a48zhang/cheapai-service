/**
 * SPDX-License-Identifier: LGPL-3.0-only
 * Behavioral adaptation of Wei-Shaw/sub2api, commit
 * ab99d56e9626e6cd731592dae8553c9758a0efa2,
 * backend/internal/pkg/apicompat/chatcompletions_to_responses.go
 * (ChatCompletionsToResponses / chatMessageToResponsesItems).
 * Full license texts: repository LICENSES/LGPL-3.0.txt and LICENSES/GPL-3.0.txt.
 *
 * Changes (2026-09-05): independent TypeScript text-only implementation using
 * the local wire validators and RequestAdapter contract. Preserve developer
 * roles, empty text and block boundaries; reject unimplemented fields. Use the
 * caller's target model and retain stream mode instead of forcing streaming,
 * store=false or encrypted reasoning. No Go source or fixtures are copied.
 * Q2 (2026-09-06): original synthetic tool implementation/tests preserve native
 * function definitions, explicit strictness, IDs, raw JSON arguments and result
 * order. Validate complete paired history instead of silently dropping items.
 */
import { parseChatRequest } from "../types/chat.js";
import type { ChatRequest } from "../types/chat.js";
import type { ResponsesInputItem, ResponsesInputText, ResponsesInputContent, ResponsesOutputContent, ResponsesRequest, ResponsesFunctionTool } from "../types/responses.js";
import { checkRequestCapabilities } from "../capabilities/check.js";
import type { ChannelCapabilities } from "../capabilities/check.js";
import { isRepresentableWireId } from "../ids.js";
import type { RequestAdapter, RequestContext } from "../types/adapter.js";
import type { ConversionResult, JsonObject } from "../types/shared.js";

function unsupported(param: string): ConversionResult<ResponsesRequest> {
  return { ok: false, error: {
    kind: "unsupported_feature", code: "unsupported_chat_to_responses_request",
    message: "This Chat request feature is not implemented by the Chat-to-Responses adapter.", param,
  } };
}

/**
 * P-CR-Q1–Q6: native roles remain ordered input messages;
 * system/developer messages are not concatenated into a top-level instruction.
 * Portable controls/images/formats/refusal/effort require declared capabilities.
 * Provider cache_control, metadata/user/service-tier semantics and unknown
 * extensions remain explicitly unsupported across protocols under P10.
 */
export interface ChatToResponsesRequestOptions { readonly channelCapabilities?: ChannelCapabilities }
export function chatToResponsesRequest(input: unknown, context: RequestContext, options: ChatToResponsesRequestOptions = {}): ConversionResult<ResponsesRequest> {
  const parsed = parseChatRequest(input, { unknownFields: "preserve" });
  if (!parsed.ok) return parsed;
  if (typeof context?.targetModel !== "string" || context.targetModel.trim().length === 0) {
    return { ok: false, error: { kind: "invalid_request", code: "invalid_target_model", message: "A target model is required for request conversion.", param: "context.targetModel" } };
  }
  const request = parsed.value;
  if (request.max_tokens != null && request.max_completion_tokens != null) return { ok: false, error: {
    kind: "invalid_request", code: "conflicting_output_limits", message: "Specify only one output-token limit.", param: "$.max_completion_tokens",
  } };
  if (request.stop != null) return unsupported("$.stop"); // Responses has no native stop-sequence field.
  if (request.n != null && request.n !== 1) return unsupported("$.n");
  if (request.stream_options != null) {
    if (request.stream !== true) return unsupported("$.stream_options");
    for (const field of Object.keys(request.stream_options)) if (field !== "include_usage") return unsupported(`$.stream_options.${field}`);
    // Responses emits native usage without a request switch. The gateway MUST
    // retain the original Chat include_usage option for downstream presentation;
    // dropping this upstream-only field never authorizes dropping billable usage.
  }
  const outputLimit = request.max_completion_tokens ?? request.max_tokens;
  const hasImages = request.messages.some(message => typeof message.content !== "string" && message.content != null && message.content.some(part => part.type === "image_url"));
  const hasRefusal = request.messages.some(message => message.role === "assistant" && (message.refusal != null
    || (typeof message.content !== "string" && message.content != null && message.content.some(part => part.type === "refusal"))));
  if (hasImages || outputLimit != null || request.temperature != null || request.top_p != null
    || hasRefusal || request.stream_options?.include_usage === true || request.reasoning_effort != null
    || (request.response_format !== undefined && request.response_format.type !== "text")) {
    if (!options.channelCapabilities || options.channelCapabilities.protocol !== "responses") return unsupported("channelCapabilities");
    const check = checkRequestCapabilities({ protocol: "chat", request }, options.channelCapabilities);
    if (!check.supported) return unsupported(check.reasons[0]?.path ?? "messages");
  }
  for (const key of Object.keys(request)) if (!["model", "messages", "stream", "tools", "tool_choice", "parallel_tool_calls",
    "max_tokens", "max_completion_tokens", "temperature", "top_p", "stop", "n", "response_format", "reasoning_effort", "stream_options"].includes(key)) return unsupported(`$.${key}`);
  let text: JsonObject | undefined;
  if (request.response_format !== undefined) {
    const format = request.response_format;
    const allowed = format.type === "json_schema" ? ["type", "json_schema"] : ["type"];
    for (const key of Object.keys(format)) if (!allowed.includes(key)) return unsupported(`$.response_format.${key}`);
    if (format.type === "json_schema") {
      for (const key of Object.keys(format.json_schema)) if (!["name", "description", "schema", "strict"].includes(key)) return unsupported(`$.response_format.json_schema.${key}`);
      if (!validToolName(format.json_schema.name)) return unsupported("$.response_format.json_schema.name");
      text = { format: { type: "json_schema", name: format.json_schema.name, schema: structuredClone(format.json_schema.schema),
        strict: format.json_schema.strict ?? false,
        ...(format.json_schema.description === undefined ? {} : { description: format.json_schema.description }),
      } };
    } else text = { format: { type: format.type } };
  }
  const tools: ResponsesFunctionTool[] = [];
  const toolNames = new Set<string>();
  for (const [index, tool] of (request.tools ?? []).entries()) {
    const path = `$.tools[${index}]`;
    for (const key of Object.keys(tool)) if (!["type", "function"].includes(key)) return unsupported(`${path}.${key}`);
    for (const key of Object.keys(tool.function)) if (!["name", "description", "parameters", "strict"].includes(key)) return unsupported(`${path}.function.${key}`);
    const { name, description, parameters, strict } = tool.function;
    if (!validToolName(name) || toolNames.has(name)) return unsupported(`${path}.function.name`);
    if (parameters !== undefined && parameters.type !== "object") return unsupported(`${path}.function.parameters`);
    if (strict === true && parameters === undefined) return unsupported(`${path}.function.parameters`);
    toolNames.add(name);
    // A custom function called "web_search" remains a function, never a built-in.
    // Responses may default to strict schema normalization; Chat's absent/null
    // strict does not authorize adding required fields or forbidding extra keys.
    tools.push({ type: "function", name, strict: strict ?? false,
      ...(description === undefined ? {} : { description }),
      ...(parameters === undefined ? {} : { parameters: structuredClone(parameters) }),
    });
  }
  let toolChoice: ResponsesRequest['tool_choice'];
  if (request.tool_choice !== undefined) {
    if (typeof request.tool_choice === "string") {
      if (request.tool_choice === "required" && !tools.length) return unsupported("$.tool_choice");
      toolChoice = request.tool_choice;
    } else {
      const choice = request.tool_choice;
      for (const key of Object.keys(choice)) if (!["type", "function"].includes(key)) return unsupported(`$.tool_choice.${key}`);
      for (const key of Object.keys(choice.function)) if (key !== "name") return unsupported(`$.tool_choice.function.${key}`);
      if (!toolNames.has(choice.function.name)) return unsupported("$.tool_choice.function.name");
      toolChoice = { type: "function", name: choice.function.name };
    }
  }

  const history: ResponsesInputItem[] = [];
  const pending = new Set<string>();
  const seen = new Set<string>();
  for (const [index, message] of request.messages.entries()) {
    const path = `$.messages[${index}]`;
    const allowed = ["role", "content", ...(message.role === "assistant" ? ["tool_calls", "refusal"] : message.role === "tool" ? ["tool_call_id"] : [])];
    for (const key of Object.keys(message)) if (!allowed.includes(key)) return unsupported(`${path}.${key}`);
    if (pending.size && message.role !== "tool") return unsupported(path);
    const content = message.content;
    const refusal = message.role === "assistant" ? message.refusal : null;
    if (refusal != null && typeof content !== "string" && content != null && content.some(part => part.type === "refusal")) return unsupported(`${path}.refusal`);
    if (message.role === "tool") {
      if (!pending.delete(message.tool_call_id)) return unsupported(`${path}.tool_call_id`);
      const resultContent = message.content;
      if (typeof resultContent === "string") history.push({ type: "function_call_output", call_id: message.tool_call_id, output: resultContent });
      else {
        const output: ResponsesInputText[] = [];
        for (const [partIndex, part] of resultContent.entries()) {
          for (const key of Object.keys(part)) if (!["type", "text"].includes(key)) return unsupported(`${path}.content[${partIndex}].${key}`);
          output.push({ type: "input_text", text: part.text });
        }
        history.push({ type: "function_call_output", call_id: message.tool_call_id, output });
      }
      continue;
    }
    if (typeof content === "string") {
      history.push({ type: "message", role: message.role, content: message.role === "assistant"
        ? [{ type: "output_text", text: content, annotations: [] }, ...(refusal == null ? [] : [{ type: "refusal" as const, refusal }])]
        : content });
    } else if (content !== undefined && content !== null) {
      const parts: (ResponsesInputContent | ResponsesOutputContent)[] = [];
      for (const [partIndex, part] of content.entries()) {
      const partPath = `${path}.content[${partIndex}]`;
      if (part.type === "refusal" && message.role === "assistant") {
        for (const field of Object.keys(part)) if (!["type", "refusal"].includes(field)) return unsupported(`${partPath}.${field}`);
        parts.push({ type: "refusal", refusal: part.refusal });
        continue;
      }
      if (part.type === "image_url" && message.role === "user") {
        for (const field of Object.keys(part)) if (!["type", "image_url"].includes(field)) return unsupported(`${partPath}.${field}`);
        for (const field of Object.keys(part.image_url)) if (!["url", "detail"].includes(field)) return unsupported(`${partPath}.image_url.${field}`);
        if (!validImageUrl(part.image_url.url)) return unsupported(`${partPath}.image_url.url`);
        parts.push({ type: "input_image", image_url: part.image_url.url,
          ...(part.image_url.detail === undefined ? {} : { detail: part.image_url.detail }),
        });
        continue;
      }
      if (part.type !== "text") return unsupported(`${partPath}.type`);
      for (const key of Object.keys(part)) if (key !== "type" && key !== "text") return unsupported(`${partPath}.${key}`);
      parts.push(message.role === "assistant"
        ? { type: "output_text", text: part.text, annotations: [] }
        : { type: "input_text", text: part.text });
      }
      if (refusal != null) parts.push({ type: "refusal", refusal });
      history.push({ type: "message", role: message.role, content: parts });
    } else if (refusal != null) history.push({ type: "message", role: "assistant", content: [{ type: "refusal", refusal }] });
    else if (!(message.role === "assistant" && message.tool_calls?.length)) return unsupported(`${path}.content`);
    if (message.role === "assistant" && message.tool_calls) {
      for (const [callIndex, call] of message.tool_calls.entries()) {
        const callPath = `${path}.tool_calls[${callIndex}]`;
        for (const key of Object.keys(call)) if (!["id", "type", "function"].includes(key)) return unsupported(`${callPath}.${key}`);
        for (const key of Object.keys(call.function)) if (!["name", "arguments"].includes(key)) return unsupported(`${callPath}.function.${key}`);
        if (!isRepresentableWireId(call.id) || seen.has(call.id)) return unsupported(`${callPath}.id`);
        if (!validToolName(call.function.name)) return unsupported(`${callPath}.function.name`);
        if (!validArguments(call.function.arguments)) return unsupported(`${callPath}.function.arguments`);
        pending.add(call.id); seen.add(call.id);
        history.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    }
  }
  if (pending.size) return unsupported("$.messages");
  return { ok: true, value: { model: context.targetModel, input: history,
    ...(outputLimit == null ? {} : { max_output_tokens: outputLimit }),
    ...(request.temperature == null ? {} : { temperature: request.temperature }),
    ...(request.top_p == null ? {} : { top_p: request.top_p }),
    ...(text === undefined ? {} : { text }),
    ...(request.reasoning_effort == null ? {} : { reasoning: { effort: request.reasoning_effort } }),
    ...(request.stream !== undefined ? { stream: request.stream } : {}),
    ...(request.tools === undefined ? {} : { tools }), ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    ...(request.parallel_tool_calls === undefined ? {} : { parallel_tool_calls: request.parallel_tool_calls }),
  } };
}

function validToolName(name: string): boolean {
  return name.length > 0 && name.length <= 64 && !/[^A-Za-z0-9_-]/u.test(name);
}
/** Complete object syntax only; preserve original argument text without parse/stringify loss. */
function validArguments(text: string): boolean {
  if (text.length > 1_048_576) return false;
  try { const parsed: unknown = JSON.parse(text); return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed); }
  catch { return false; }
}

export const chatToResponsesRequestAdapter: RequestAdapter<ChatRequest, ResponsesRequest, "chat", "responses"> = {
  from: "chat", to: "responses", convert: chatToResponsesRequest,
};
export function createChatToResponsesRequestAdapter(channelCapabilities: ChannelCapabilities): typeof chatToResponsesRequestAdapter {
  const policy = structuredClone(channelCapabilities);
  return { from: "chat", to: "responses", convert: (input, context) => chatToResponsesRequest(input, context, { channelCapabilities: policy }) };
}
/** Validate the original image envelope without fetching/transcoding its content. */
function validImageUrl(value: string): boolean {
  if (value.startsWith("data:")) {
    if (value.length > 8_388_608) return false;
    const match = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match?.[1] || match[1].length % 4) return false;
    try { return btoa(atob(match[1])) === match[1]; } catch { return false; }
  }
  if (value.length > 8192 || /[\s\u0000-\u001f\u007f]/u.test(value)) return false;
  try { const url = new URL(value); return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password && !url.hash; }
  catch { return false; }
}
