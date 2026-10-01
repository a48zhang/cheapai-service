import type { RequestAdapter, RequestContext } from '../types/adapter.js';
import type { ChatMessage, ChatRequest, ChatTextPart, ChatImagePart, ChatRefusalPart, ChatTool, ChatToolCall } from '../types/chat.js';
import { checkRequestCapabilities } from '../capabilities/check.js';
import type { ChannelCapabilities } from '../capabilities/check.js';
import { isRepresentableWireId } from '../ids.js';
import { parseResponsesRequest } from '../types/responses.js';
import type { ResponsesRequest } from '../types/responses.js';
import type { ConversionResult, JsonObject, JsonValue } from '../types/shared.js';

/**
 * Original implementation; no source or fixtures copied/adapted.
 * Behavioral reference: Wei-Shaw/sub2api commit
 * ab99d56e9626e6cd731592dae8553c9758a0efa2,
 * backend/internal/pkg/apicompat/chatcompletions_responses_bridge.go and
 * chatcompletions_responses_bridge_test.go (upstream root LICENSE: LGPL-3.0).
 * Unlike the reference's developer→system normalization, native input roles and
 * positions remain unchanged. Instructions become one leading system message.
 * See docs/protocol-baseline.md for the verified source identity and limitations.
 * Q2 default-strict contract checked 2026-09-06 against official documentation:
 * https://developers.openai.com/api/docs/guides/function-calling#strict-mode
 * Pinned bridge simply copies Strict. Here an omitted flag normalizes a bounded
 * simple schema subset; unsupported default/fallback semantics are rejected.
 */
function unsupported(param: string): ConversionResult<ChatRequest> {
  return { ok: false, error: {
    kind: 'unsupported_feature', code: 'unsupported_responses_to_chat_feature',
    message: 'This Responses request feature is not supported by the current Chat converter.', param,
  } };
}

/**
 * Text/function-tool request milestone. The mapping neither looks up history references
 * nor hoists instructions found within input. Empty annotations carry no content;
 * actual citations/logprobs and incomplete/native history references are rejected.
 * Full-content item IDs/completed status are source bookkeeping, not call IDs.
 */
export interface ResponsesToChatRequestOptions { readonly channelCapabilities?: ChannelCapabilities }
export function convertResponsesToChatRequest(input: ResponsesRequest, context: RequestContext, options: ResponsesToChatRequestOptions = {}): ConversionResult<ChatRequest> {
  if (typeof context.targetModel !== 'string' || context.targetModel.trim().length === 0) return {
    ok: false, error: { kind: 'invalid_request', code: 'invalid_target_model', message: 'A target model is required.', param: 'targetModel' },
  };
  const parsed = parseResponsesRequest(input, { unknownFields: 'preserve' });
  if (!parsed.ok) return parsed;
  const request = parsed.value;
  const hasImages = typeof request.input !== 'string' && request.input?.some(item => {
    if (item.type === 'function_call_output') return typeof item.output !== 'string' && item.output.some(part => part.type === 'input_image');
    if (item.type === undefined || item.type === 'message') return typeof item.content !== 'string' && item.content.some(part => part.type === 'input_image');
    return false;
  });
  const hasRefusal = typeof request.input !== 'string' && request.input?.some(item => (item.type === undefined || item.type === 'message')
    && typeof item.content !== 'string' && item.content.some(part => part.type === 'refusal'));
  const format = request.text?.format;
  if (hasImages || request.max_output_tokens != null || request.temperature != null || request.top_p != null || request.stream === true
    || hasRefusal || request.reasoning?.effort != null || (format !== undefined && (!schemaObject(format) || format.type !== 'text'))) {
    if (!options.channelCapabilities || options.channelCapabilities.protocol !== 'chat') return unsupported('channelCapabilities');
    const checked = checkRequestCapabilities({ protocol: 'responses', request }, options.channelCapabilities);
    if (!checked.supported) return unsupported(checked.reasons[0]?.path ?? 'input');
  }
  if (request.stream === true && !options.channelCapabilities?.features.includes('stream_usage')) return unsupported('stream');
  for (const key of Object.keys(request)) if (!['model', 'instructions', 'input', 'tools', 'tool_choice', 'parallel_tool_calls', 'max_output_tokens', 'temperature', 'top_p', 'stream', 'text', 'reasoning'].includes(key)) return unsupported(key);
  let reasoningEffort: string | undefined;
  if (request.reasoning != null) {
    for (const field of Object.keys(request.reasoning)) if (field !== 'effort') return unsupported(`reasoning.${field}`);
    if (request.reasoning.effort != null) {
      if (typeof request.reasoning.effort !== 'string' || !request.reasoning.effort.length) return unsupported('reasoning.effort');
      reasoningEffort = request.reasoning.effort;
    }
  }
  let responseFormat: ChatRequest['response_format'];
  if (request.text !== undefined) {
    for (const field of Object.keys(request.text)) if (field !== 'format') return unsupported(`text.${field}`);
    if (format !== undefined) {
      if (!schemaObject(format)) return unsupported('text.format');
      const fields = format.type === 'json_schema' ? ['type', 'name', 'description', 'schema', 'strict'] : ['type'];
      for (const field of Object.keys(format)) if (!fields.includes(field)) return unsupported(`text.format.${field}`);
      if (format.type === 'json_schema') {
        if (typeof format.name !== 'string' || !toolName(format.name) || !schemaObject(format.schema)
          || (format.description !== undefined && typeof format.description !== 'string')
          || (format.strict !== undefined && format.strict !== null && typeof format.strict !== 'boolean')) return unsupported('text.format');
        responseFormat = { type: 'json_schema', json_schema: { name: format.name, schema: structuredClone(format.schema),
          ...(format.description === undefined ? {} : { description: format.description }),
          ...(format.strict === undefined ? {} : { strict: format.strict }),
        } };
      } else if (format.type === 'text' || format.type === 'json_object') responseFormat = { type: format.type };
      else return unsupported('text.format.type');
    }
  }
  const tools: ChatTool[] = [];
  const names = new Set<string>();
  for (const [index, definition] of (request.tools ?? []).entries()) {
    const path = `tools[${index}]`;
    // The Responses parser rejects native built-ins; never reinterpret a type.
    if (definition.type !== 'function') return unsupported(`${path}.type`);
    for (const key of Object.keys(definition)) if (!['type', 'name', 'description', 'parameters', 'strict'].includes(key)) return unsupported(`${path}.${key}`);
    if (!toolName(definition.name) || names.has(definition.name)) return unsupported(`${path}.name`);
    if (definition.strict === null) return unsupported(`${path}.strict`);
    if (definition.parameters !== undefined && (definition.parameters === null || definition.parameters.type !== 'object')) return unsupported(`${path}.parameters`);
    let parameters = definition.parameters === undefined ? undefined : structuredClone(definition.parameters);
    const strict = definition.strict ?? true;
    if (strict) {
      if (!parameters) return unsupported(`${path}.parameters`);
      const normalized = strictSchema(parameters, definition.strict === undefined);
      if (!normalized) return unsupported(`${path}.parameters`);
      parameters = normalized;
    }
    names.add(definition.name);
    tools.push({ type: 'function', function: { name: definition.name, strict,
      ...(definition.description === undefined ? {} : { description: definition.description }),
      ...(parameters === undefined ? {} : { parameters }),
    } });
  }
  let toolChoice: ChatRequest['tool_choice'];
  if (request.tool_choice !== undefined) {
    const choice = request.tool_choice;
    if (typeof choice === 'string') {
      if (choice === 'required' && !tools.length) return unsupported('tool_choice');
      toolChoice = choice;
    } else {
      for (const field of Object.keys(choice)) if (!['type', 'name'].includes(field)) return unsupported(`tool_choice.${field}`);
      if (choice.type !== 'function' || !names.has(choice.name)) return unsupported('tool_choice.name');
      toolChoice = { type: 'function', function: { name: choice.name } };
    }
  }
  const messages: ChatMessage[] = [];
  const seen = new Set<string>();
  const pending = new Set<string>();
  let openCalls: ChatToolCall[] | null = null;
  // Presence matters: even empty/whitespace instructions are not trimmed away.
  if (typeof request.instructions === 'string') messages.push({ role: 'system', content: request.instructions });
  if (typeof request.input === 'string') messages.push({ role: 'user', content: request.input });
  else if (request.input !== undefined) {
    for (let index = 0; index < request.input.length; index++) {
      const item = request.input[index];
      const path = `input[${index}]`;
      if (!item) return unsupported(path);
      // These identify complete source items only. Content is supplied in full;
      // no lookup is performed, and only call_id links tool calls to results.
      if ((item.id !== undefined && !isRepresentableWireId(item.id)) || (item.status !== undefined && item.status !== 'completed')) return unsupported(path);
      if (item.type === 'function_call') {
        for (const field of Object.keys(item)) if (!['type', 'call_id', 'name', 'arguments', 'id', 'status'].includes(field)) return unsupported(`${path}.${field}`);
        if (pending.size && openCalls === null) return unsupported(path);
        if (!isRepresentableWireId(item.call_id) || seen.has(item.call_id)) return unsupported(`${path}.call_id`);
        if (!toolName(item.name) || !toolArguments(item.arguments)) return unsupported(`${path}.arguments`);
        if (openCalls === null) { openCalls = []; messages.push({ role: 'assistant', content: null, tool_calls: openCalls }); }
        openCalls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
        seen.add(item.call_id); pending.add(item.call_id);
        continue;
      }
      if (item.type === 'function_call_output') {
        for (const field of Object.keys(item)) if (!['type', 'call_id', 'output', 'id', 'status'].includes(field)) return unsupported(`${path}.${field}`);
        if (!pending.delete(item.call_id)) return unsupported(`${path}.call_id`);
        openCalls = null;
        if (typeof item.output === 'string') messages.push({ role: 'tool', tool_call_id: item.call_id, content: item.output });
        else {
          const content: ChatTextPart[] = [];
          for (const [partIndex, part] of item.output.entries()) {
            if (part.type !== 'input_text') return unsupported(`${path}.output[${partIndex}].type`);
            for (const field of Object.keys(part)) if (!['type', 'text'].includes(field)) return unsupported(`${path}.output[${partIndex}].${field}`);
            content.push({ type: 'text', text: part.text });
          }
          messages.push({ role: 'tool', tool_call_id: item.call_id, content });
        }
        continue;
      }
      if (pending.size) return unsupported(path);
      openCalls = null;
      if (item.type !== undefined && item.type !== 'message') return unsupported(`${path}.type`);
      for (const key of Object.keys(item)) if (!['type', 'role', 'content', 'id', 'status'].includes(key)) return unsupported(`${path}.${key}`);
      if (typeof item.content === 'string') messages.push({ role: item.role, content: item.content });
      else {
        const content: (ChatTextPart | ChatImagePart | ChatRefusalPart)[] = [];
        for (let partIndex = 0; partIndex < item.content.length; partIndex++) {
          const part = item.content[partIndex];
          const partPath = `${path}.content[${partIndex}]`;
          if (!part) return unsupported(partPath);
          if (part.type === 'refusal' && item.role === 'assistant') {
            for (const field of Object.keys(part)) if (!['type', 'refusal'].includes(field)) return unsupported(`${partPath}.${field}`);
            content.push({ type: 'refusal', refusal: part.refusal });
            continue;
          }
          if (part.type === 'input_image' && item.role === 'user') {
            for (const field of Object.keys(part)) if (!['type', 'image_url', 'file_id', 'detail'].includes(field)) return unsupported(`${partPath}.${field}`);
            if (part.file_id != null || typeof part.image_url !== 'string' || !validImageUrl(part.image_url) || part.detail === 'original') return unsupported(partPath);
            content.push({ type: 'image_url', image_url: { url: part.image_url, ...(part.detail === undefined ? {} : { detail: part.detail }) } });
            continue;
          }
          if (part.type !== 'input_text' && part.type !== 'output_text') return unsupported(`${partPath}.type`);
          const allowed = part.type === 'output_text' ? ['type', 'text', 'annotations'] : ['type', 'text'];
          for (const key of Object.keys(part)) if (!allowed.includes(key)) return unsupported(`${partPath}.${key}`);
          if (part.type === 'output_text' && part.annotations.length > 0) return unsupported(`${partPath}.annotations`);
          content.push({ type: 'text', text: part.text });
        }
        messages.push(item.role === 'user' ? { role: 'user', content: content as (ChatTextPart | ChatImagePart)[] }
          : item.role === 'assistant' ? { role: 'assistant', content: content as (ChatTextPart | ChatRefusalPart)[] }
          : { role: item.role, content: content as ChatTextPart[] });
      }
    }
  }
  if (pending.size) return unsupported('input');
  if (messages.length === 0) return {
    ok: false, error: { kind: 'invalid_request', code: 'chat_messages_required', message: 'At least one text message or instruction is required.', param: 'input' },
  };
  const output: ChatRequest = { model: context.targetModel, messages,
    ...(request.max_output_tokens == null ? {} : { max_completion_tokens: request.max_output_tokens }),
    ...(request.temperature == null ? {} : { temperature: request.temperature }),
    ...(request.top_p == null ? {} : { top_p: request.top_p }),
    ...(request.stream === undefined ? {} : { stream: request.stream }),
    ...(request.stream === true ? { stream_options: { include_usage: true } } : {}),
    ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
    ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
    ...(request.tools === undefined ? {} : { tools }), ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    ...(request.parallel_tool_calls === undefined ? {} : { parallel_tool_calls: request.parallel_tool_calls }),
  };
  if (options.channelCapabilities) {
    const checked = checkRequestCapabilities({ protocol: 'chat', request: output }, options.channelCapabilities);
    if (!checked.supported) return unsupported(checked.reasons[0]?.path ?? 'output');
  }
  return { ok: true, value: output };
}

function toolName(name: string): boolean { return name.length > 0 && name.length <= 64 && !/[^A-Za-z0-9_-]/u.test(name); }
function toolArguments(text: string): boolean {
  if (text.length > 1_048_576) return false;
  try { const value: unknown = JSON.parse(text); return value !== null && typeof value === 'object' && !Array.isArray(value); }
  catch { return false; }
}

/** Conservative strict subset. Never guesses provider fallback for unknown keywords. */
const schemaObject = (value: JsonValue | undefined): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
function strictSchema(schema: JsonObject, normalize: boolean, depth = 0): JsonObject | undefined {
  if (depth > 32) return undefined;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.length || types.length > 2 || new Set(types).size !== types.length
    || !types.every(type => typeof type === 'string' && ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type))) return undefined;
  const base = types.find(type => type !== 'null') ?? 'null';
  if (types.length === 2 && !types.includes('null')) return undefined;
  const allowed = ['type', 'description', 'title', 'enum', ...(base === 'object' ? ['properties', 'required', 'additionalProperties'] : base === 'array' ? ['items'] : [])];
  if (Object.keys(schema).some(key => !allowed.includes(key))) return undefined;
  for (const key of ['description', 'title']) if (schema[key] !== undefined && typeof schema[key] !== 'string') return undefined;
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length
    || schema.enum.some(value => !types.some(type => type === 'null' ? value === null
      : type === 'integer' ? typeof value === 'number' && Number.isInteger(value)
      : ['string', 'number', 'boolean'].includes(String(type)) && typeof value === type)))) return undefined;
  const result: Record<string, JsonValue> = { ...schema };
  if (base === 'object') {
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) return undefined;
    const raw = schema.properties ?? {};
    if (!schemaObject(raw)) return undefined;
    const properties: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, child] of Object.entries(raw)) {
      if (!schemaObject(child)) return undefined;
      const normalized = strictSchema(child, normalize, depth + 1);
      if (!normalized) return undefined;
      properties[key] = normalized;
    }
    const keys = Object.keys(properties);
    const required = schema.required;
    if (required !== undefined && (!Array.isArray(required) || required.some(key => typeof key !== 'string' || !Object.hasOwn(properties, key))
      || new Set(required).size !== required.length)) return undefined;
    if (!normalize && (schema.additionalProperties !== false || !Array.isArray(required) || required.length !== keys.length)) return undefined;
    result.properties = properties;
    result.additionalProperties = false;
    result.required = normalize ? keys : required as readonly JsonValue[];
  } else if (base === 'array') {
    const child = schema.items;
    if (!schemaObject(child)) return undefined;
    const normalized = strictSchema(child, normalize, depth + 1);
    if (!normalized) return undefined;
    result.items = normalized;
  }
  return result;
}

export const responsesToChatRequestAdapter: RequestAdapter<ResponsesRequest, ChatRequest, 'responses', 'chat'> = Object.freeze({
  from: 'responses', to: 'chat', convert: convertResponsesToChatRequest,
});
export function createResponsesToChatRequestAdapter(channelCapabilities: ChannelCapabilities): typeof responsesToChatRequestAdapter {
  const policy = structuredClone(channelCapabilities);
  return { from: 'responses', to: 'chat', convert: (input, context) => convertResponsesToChatRequest(input, context, { channelCapabilities: policy }) };
}
function validImageUrl(value: string): boolean {
  if (value.startsWith('data:')) {
    if (value.length > 8_388_608) return false;
    const match = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match?.[1] || match[1].length % 4) return false;
    try { return btoa(atob(match[1])) === match[1]; } catch { return false; }
  }
  if (value.length > 8192 || /[\s\u0000-\u001f\u007f]/u.test(value)) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password && !url.hash; }
  catch { return false; }
}
