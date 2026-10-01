import type { RequestAdapter } from '../types/adapter.js';
import { isRepresentableWireId } from '../ids.js';
import { checkRequestCapabilities } from '../capabilities/check.js';
import type { ChannelCapabilities } from '../capabilities/check.js';
import { parseChatRequest } from '../types/chat.js';
import type { ChatImagePart, ChatRequest } from '../types/chat.js';
import type { MessagesCacheControl, MessagesContentBlock, MessagesImageBlock, MessagesOutputConfig, MessagesRequest, MessagesTextBlock, MessagesTool, MessagesToolChoice } from '../types/messages.js';
import type { ConversionResult, JsonObject } from '../types/shared.js';

/**
 * Original direct implementation and original synthetic tests, not adapted code.
 * docs/protocol-baseline.md records that Sub2API commit
 * ab99d56e9626e6cd731592dae8553c9758a0efa2 has no verified direct Chat→Messages
 * request bridge. This file does not copy that project's LGPL-3.0 source/fixtures.
 */
export interface ChatToMessagesRequestOptions {
  /** Explicit model-policy output budget; Messages requires max_tokens. No default. */
  readonly maxTokens: number;
  /** Required for image-bearing requests; declarations are caller-owned model policy. */
  readonly channelCapabilities?: ChannelCapabilities;
}

export type ChatToMessagesRequestAdapter = RequestAdapter<ChatRequest, MessagesRequest, 'chat', 'messages'>;

function unsupported<T = MessagesRequest>(param: string, code = 'unsupported_chat_to_messages_feature'): ConversionResult<T> {
  return { ok: false, error: {
    kind: 'unsupported_feature', code,
    message: 'This Chat request feature cannot be represented by the current Messages converter.', param,
  } };
}

/**
 * Text/tool milestone: rejects every unimplemented control/extension rather than
 * silently forwarding or dropping it. A homogeneous system/developer prefix is
 * mapped to ordered system blocks. Mixed instruction priorities or instructions
 * after conversation turns cannot be hoisted into one Messages system tier
 * without changing meaning and are rejected. No role labels or separators are
 * invented. Consecutive identical conversation roles retain ordered text blocks.
 * All tool calls must have one immediately following result group before the
 * next turn; IDs remain unchanged and are unique across the supplied history.
 */
export function createChatToMessagesRequestAdapter(options: ChatToMessagesRequestOptions): ConversionResult<ChatToMessagesRequestAdapter> {
  if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0) return {
    ok: false, error: { kind: 'invalid_request', code: 'invalid_messages_output_budget', message: 'A positive safe-integer Messages output budget is required.', param: 'maxTokens' },
  };
  const maxTokens = options.maxTokens;
  const channel = options.channelCapabilities === undefined ? undefined : structuredClone(options.channelCapabilities);
  if (channel !== undefined && channel.protocol !== 'messages') return unsupported('channelCapabilities', 'invalid_image_channel_policy');
  return { ok: true, value: {
    from: 'chat', to: 'messages',
    convert(input, context) {
      if (typeof context.targetModel !== 'string' || context.targetModel.trim().length === 0) return {
        ok: false, error: { kind: 'invalid_request', code: 'invalid_target_model', message: 'A target model is required.', param: 'targetModel' },
      };
      // Preserve here only to diagnose unsupported extensions explicitly below.
      // It never authorizes sending an extension to the target provider.
      const parsed = parseChatRequest(input, { unknownFields: 'preserve' });
      if (!parsed.ok) return parsed;
      const request = parsed.value;
      if (request.max_tokens != null && request.max_completion_tokens != null) return {
        ok: false, error: { kind: 'invalid_request', code: 'conflicting_output_limits', message: 'Specify one output-token limit.', param: 'max_completion_tokens' },
      };
      if (request.n != null && request.n !== 1) return unsupported('n');
      /* Chat include_usage is a downstream presentation preference. G14 keeps
       * the original option while converting the request; Messages has no
       * equivalent request field, so validate the closed envelope here and
       * deliberately omit it from the upstream body. */
      if (request.stream_options !== undefined) {
        if (request.stream_options === null || request.stream !== true) return unsupported('stream_options');
        for (const field of Object.keys(request.stream_options)) if (field !== 'include_usage') return unsupported(`stream_options.${field}`);
      }
      const outputLimit = request.max_completion_tokens ?? request.max_tokens ?? maxTokens;
      if (outputLimit == null) return unsupported('max_tokens', 'output_limit_required');
      const hasCache = request.cache_control != null || request.tools?.some(tool => tool.cache_control != null)
        || request.messages.some(message => typeof message.content !== 'string' && message.content != null && message.content.some(part => part.cache_control != null));
      const hasStrictTools = request.tools?.some(tool => tool.function.strict === true);
      const hasImages = request.messages.some(message => typeof message.content !== 'string'
        && message.content != null && message.content.some(part => part.type === 'image_url'));
      if (hasImages || request.max_tokens != null || request.max_completion_tokens != null || request.temperature != null || request.top_p != null || request.stop != null || request.stream === true
        || hasCache || hasStrictTools || request.reasoning_effort != null || (request.response_format !== undefined && request.response_format.type !== 'text')) {
        if (!channel) return unsupported('channelCapabilities', hasImages ? 'image_capabilities_required' : 'channel_capabilities_required');
        /* include_usage is intentionally absent from this capability probe:
         * it is consumed by the downstream Chat presentation wrapper and is
         * never sent to a Messages upstream. */
        const { stream_options: _streamOptions, ...capabilityRequest } = request;
        const checked = checkRequestCapabilities({ protocol: 'chat', request: { ...capabilityRequest, ...(request.max_completion_tokens == null && request.max_tokens == null ? { max_completion_tokens: outputLimit } : {}) } }, channel);
        if (!checked.supported) return unsupported(checked.reasons[0]?.path ?? 'messages', checked.reasons[0]?.code ?? 'image_capability_rejected');
      }
      for (const key of Object.keys(request)) if (!['model', 'messages', 'tools', 'tool_choice', 'parallel_tool_calls',
        'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'stop', 'stream', 'stream_options', 'n', 'response_format', 'reasoning_effort', 'cache_control'].includes(key)) return unsupported(key);
      const automaticCache = cacheMarker(request.cache_control, 'cache_control');
      if (!automaticCache.ok) return automaticCache;
      let outputConfig: MessagesOutputConfig | undefined;
      if (request.response_format !== undefined) {
        const format = request.response_format;
        for (const field of Object.keys(format)) if (!(format.type === 'json_schema' ? ['type', 'json_schema'] : ['type']).includes(field)) return unsupported(`response_format.${field}`);
        if (format.type === 'json_object') return unsupported('response_format', 'unrepresentable_json_mode');
        if (format.type === 'json_schema') {
          const source = format.json_schema;
          for (const field of Object.keys(source)) if (!['name', 'schema', 'description', 'strict'].includes(field)) return unsupported(`response_format.json_schema.${field}`);
          if (source.strict !== true || !portableStrictSchema(source.schema) || source.schema.type !== 'object') return unsupported('response_format.json_schema', 'unrepresentable_output_schema');
          const schema = structuredClone(source.schema);
          // name is an envelope label, not an output constraint. Messages has no
          // label field. Preserve wrapper description as root schema annotation.
          if (source.description !== undefined && schema.description !== undefined && schema.description !== source.description) return unsupported('response_format.json_schema.description');
          outputConfig = { format: { type: 'json_schema', schema: source.description === undefined ? schema : { ...schema, description: source.description } } };
        }
      }
      if (request.reasoning_effort != null) {
        if (!['low', 'medium', 'high'].includes(request.reasoning_effort)) return unsupported('reasoning_effort', 'unrepresentable_effort');
        // Official effort applies to output with or without thinking enabled:
        // https://platform.claude.com/docs/en/build-with-claude/effort
        // The channel explicitly approves named levels; no fixed token budget,
        // enabled/adaptive thinking mode or signed history is synthesized.
        outputConfig = { ...outputConfig, effort: request.reasoning_effort as 'low' | 'medium' | 'high' };
      }
      const tools: MessagesTool[] = [];
      const names = new Set<string>();
      for (const [index, definition] of (request.tools ?? []).entries()) {
        const path = `tools[${index}]`;
        for (const key of Object.keys(definition)) if (!['type', 'function', 'cache_control'].includes(key)) return unsupported(`${path}.${key}`);
        for (const key of Object.keys(definition.function)) if (!['name', 'description', 'parameters', 'strict'].includes(key)) return unsupported(`${path}.function.${key}`);
        const { name, description, parameters, strict } = definition.function;
        if (!validToolName(name)) return unsupported(`${path}.function.name`, 'unrepresentable_tool_name');
        if (names.has(name)) return unsupported(`${path}.function.name`, 'duplicate_tool_definition');
        if (parameters?.type !== 'object') return unsupported(`${path}.function.parameters`, 'object_tool_schema_required');
        if (strict === true && !portableStrictSchema(parameters)) return unsupported(`${path}.function.parameters`, 'unrepresentable_strict_tool_schema');
        const cache = cacheMarker(definition.cache_control, `${path}.cache_control`);
        if (!cache.ok) return cache;
        names.add(name);
        tools.push({ name, input_schema: structuredClone(parameters) as JsonObject & { readonly type: 'object' },
          ...(description === undefined ? {} : { description }), ...(strict === undefined ? {} : { strict: strict ?? false }),
          ...(cache.value === undefined ? {} : { cache_control: cache.value }) });
      }
      let toolChoice: MessagesToolChoice | undefined;
      if (request.tool_choice !== undefined || request.parallel_tool_calls !== undefined) {
        const choice = request.tool_choice ?? 'auto';
        const parallel = request.parallel_tool_calls === undefined ? {} : { disable_parallel_tool_use: !request.parallel_tool_calls };
        if (choice === 'none') toolChoice = { type: 'none' };
        else {
          if (tools.length === 0) return unsupported('tool_choice', 'tool_definitions_required');
          if (choice === 'auto' || choice === 'required') toolChoice = { type: choice === 'auto' ? 'auto' : 'any', ...parallel };
          else {
            for (const key of Object.keys(choice)) if (!['type', 'function'].includes(key)) return unsupported(`tool_choice.${key}`);
            for (const key of Object.keys(choice.function)) if (key !== 'name') return unsupported(`tool_choice.function.${key}`);
            if (!names.has(choice.function.name)) return unsupported('tool_choice.function.name', 'unknown_selected_tool');
            toolChoice = { type: 'tool', name: choice.function.name, ...parallel };
          }
        }
      }
      const system: MessagesTextBlock[] = [];
      const messages: { role: 'user' | 'assistant'; content: MessagesContentBlock[] }[] = [];
      const pending = new Set<string>();
      const seen = new Set<string>();
      let instructionRole: 'system' | 'developer' | undefined;
      for (let index = 0; index < request.messages.length; index++) {
        const entry = request.messages[index];
        if (!entry) continue; // Structural validation has already excluded holes.
        const path = `messages[${index}]`;
        const allowed = ['role', 'content', ...(entry.role === 'assistant' ? ['tool_calls'] : entry.role === 'tool' ? ['tool_call_id'] : [])];
        for (const key of Object.keys(entry)) if (!allowed.includes(key)) return unsupported(`${path}.${key}`);
        if (pending.size && entry.role !== 'tool') return unsupported(path, 'unanswered_tool_calls');
        const blocks: (MessagesTextBlock | MessagesImageBlock)[] = [];
        if (typeof entry.content === 'string') blocks.push({ type: 'text', text: entry.content });
        else if (entry.content !== undefined && entry.content !== null) {
          for (let partIndex = 0; partIndex < entry.content.length; partIndex++) {
            const part = entry.content[partIndex];
            const partPath = `${path}.content[${partIndex}]`;
            if (!part) return unsupported(partPath);
            if (part.type === 'image_url' && entry.role === 'user') {
              const image = convertImage(part, partPath);
              if (!image.ok) return image;
              blocks.push(image.value);
              continue;
            }
            if (part.type !== 'text') return unsupported(`${partPath}.type`);
            for (const key of Object.keys(part)) if (!['type', 'text', 'cache_control'].includes(key)) return unsupported(`${partPath}.${key}`);
            const cache = cacheMarker(part.cache_control, `${partPath}.cache_control`);
            if (!cache.ok) return cache;
            blocks.push({ type: 'text', text: part.text, ...(cache.value === undefined ? {} : { cache_control: cache.value }) });
          }
        } else if (!(entry.role === 'assistant' && entry.tool_calls?.length)) return unsupported(`${path}.content`);

        if (entry.role === 'system' || entry.role === 'developer') {
          if (messages.length) return unsupported(`${path}.role`, 'interleaved_instruction_not_representable');
          if (instructionRole !== undefined && instructionRole !== entry.role) return unsupported(`${path}.role`, 'mixed_instruction_priorities_not_representable');
          instructionRole = entry.role;
          for (const block of blocks) {
            if (block.type !== 'text') return unsupported(`${path}.content`);
            system.push(block);
          }
        } else {
          const converted: MessagesContentBlock[] = [...blocks];
          if (entry.role === 'assistant' && entry.tool_calls) {
            for (const [callIndex, call] of entry.tool_calls.entries()) {
              const callPath = `${path}.tool_calls[${callIndex}]`;
              for (const key of Object.keys(call)) if (!['id', 'type', 'function'].includes(key)) return unsupported(`${callPath}.${key}`);
              for (const key of Object.keys(call.function)) if (!['name', 'arguments'].includes(key)) return unsupported(`${callPath}.function.${key}`);
              if (!isRepresentableWireId(call.id)) return unsupported(`${callPath}.id`, 'unrepresentable_tool_call_id');
              if (seen.has(call.id)) return unsupported(`${callPath}.id`, 'duplicate_tool_call_id');
              if (!validToolName(call.function.name)) return unsupported(`${callPath}.function.name`, 'unrepresentable_tool_name');
              const argumentsObject = parseToolArguments(call.function.arguments);
              if (!argumentsObject) return unsupported(`${callPath}.function.arguments`, 'invalid_tool_arguments');
              seen.add(call.id); pending.add(call.id);
              converted.push({ type: 'tool_use', id: call.id, name: call.function.name, input: argumentsObject });
            }
          }
          if (entry.role === 'tool') {
            if (!pending.delete(entry.tool_call_id)) return unsupported(`${path}.tool_call_id`, 'orphan_or_duplicate_tool_result');
            converted.splice(0, converted.length, { type: 'tool_result', tool_use_id: entry.tool_call_id,
              content: typeof entry.content === 'string' ? entry.content : blocks });
          }
          const role = entry.role === 'tool' ? 'user' : entry.role;
          const previous = messages[messages.length - 1];
          if (previous?.role === role) previous.content.push(...converted);
          else messages.push({ role, content: converted });
        }
      }
      if (pending.size) return unsupported('messages', 'unanswered_tool_calls');
      if (messages.length === 0) return unsupported('messages', 'messages_conversation_required');
      const output: MessagesRequest = {
        model: context.targetModel, max_tokens: outputLimit, messages,
        ...(automaticCache.value === undefined ? {} : { cache_control: automaticCache.value }),
        ...(request.temperature == null ? {} : { temperature: request.temperature }),
        ...(request.top_p == null ? {} : { top_p: request.top_p }),
        ...(request.stop == null ? {} : { stop_sequences: typeof request.stop === 'string' ? [request.stop] : [...request.stop] }),
        ...(request.stream === undefined ? {} : { stream: request.stream }),
        ...(outputConfig === undefined ? {} : { output_config: outputConfig }),
        ...(system.length ? { system } : {}),
        ...(request.tools === undefined ? {} : { tools }),
        ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
      };
      if (!validCacheOrder(output)) return unsupported('cache_control', 'invalid_cache_ttl_order');
      return { ok: true, value: output };
    },
  } };
}

/** Shared basic strict-schema subset; reject unsupported keywords rather than strip them. */
function portableStrictSchema(schema: JsonObject, depth = 0): boolean {
  if (depth > 32) return false;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.length || types.length > 2 || new Set(types).size !== types.length
    || !types.every(type => typeof type === 'string' && ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type))
    || (types.length === 2 && !types.includes('null'))) return false;
  const base = types.find(type => type !== 'null') ?? 'null';
  const fields = ['type', 'description', 'title', 'enum', ...(base === 'object' ? ['properties', 'required', 'additionalProperties'] : base === 'array' ? ['items'] : [])];
  if (Object.keys(schema).some(key => !fields.includes(key))) return false;
  for (const key of ['description', 'title']) if (schema[key] !== undefined && typeof schema[key] !== 'string') return false;
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.some(value => !types.some(type => type === 'null' ? value === null
    : type === 'integer' ? typeof value === 'number' && Number.isInteger(value) : ['string', 'number', 'boolean'].includes(String(type)) && typeof value === type)))) return false;
  if (base === 'object') {
    const properties = schema.properties;
    if (properties === null || typeof properties !== 'object' || Array.isArray(properties) || schema.additionalProperties !== false || !Array.isArray(schema.required)) return false;
    const keys = Object.keys(properties);
    if (schema.required.length !== keys.length || new Set(schema.required).size !== keys.length || schema.required.some(key => typeof key !== 'string' || !Object.hasOwn(properties, key))) return false;
    return Object.values(properties).every(child => child !== null && typeof child === 'object' && !Array.isArray(child) && portableStrictSchema(child as JsonObject, depth + 1));
  }
  if (base === 'array') return schema.items !== null && typeof schema.items === 'object' && !Array.isArray(schema.items) && portableStrictSchema(schema.items as JsonObject, depth + 1);
  return true;
}

/** Envelope validation only, not image decoding, URL fetching or SSRF isolation. */
function convertImage(part: ChatImagePart, path: string): ConversionResult<MessagesImageBlock> {
  for (const field of Object.keys(part)) if (!['type', 'image_url', 'cache_control'].includes(field)) return unsupported(`${path}.${field}`);
  const marker = cacheMarker(part.cache_control, `${path}.cache_control`);
  if (!marker.ok) return marker;
  const cache = marker.value === undefined ? {} : { cache_control: marker.value };
  for (const field of Object.keys(part.image_url)) if (!['url', 'detail'].includes(field)) return unsupported(`${path}.image_url.${field}`);
  if (part.image_url.detail !== undefined && part.image_url.detail !== 'auto') return unsupported(`${path}.image_url.detail`, 'unrepresentable_image_detail');
  // 'auto' imposes no fixed detail level; native Messages selects its own default.
  const url = part.image_url.url;
  if (url.startsWith('data:')) {
    if (url.length > 8_388_608) return unsupported(`${path}.image_url.url`, 'image_data_too_large');
    const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
    if (!match?.[1] || !match[2] || match[2].length % 4 !== 0) return unsupported(`${path}.image_url.url`, 'invalid_image_data');
    try { if (btoa(atob(match[2])) !== match[2]) return unsupported(`${path}.image_url.url`, 'invalid_image_data'); }
    catch { return unsupported(`${path}.image_url.url`, 'invalid_image_data'); }
    return { ok: true, value: { type: 'image', source: { type: 'base64', media_type: match[1] as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: match[2] }, ...cache } };
  }
  if (url.length > 8192 || /[\s\u0000-\u001f\u007f]/u.test(url)) return unsupported(`${path}.image_url.url`, 'invalid_image_url');
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.hash) return unsupported(`${path}.image_url.url`, 'invalid_image_url');
  } catch { return unsupported(`${path}.image_url.url`, 'invalid_image_url'); }
  return { ok: true, value: { type: 'image', source: { type: 'url', url }, ...cache } };
}

/** Reviewed Chat extension contract matches native Messages cache markers exactly. */
function cacheMarker(value: unknown, path: string): ConversionResult<MessagesCacheControl | null | undefined> {
  if (value === undefined || value === null) return { ok: true, value };
  if (typeof value !== 'object' || Array.isArray(value)) return unsupported(path, 'invalid_cache_control');
  const marker = value as Record<string, unknown>;
  if (marker.type !== 'ephemeral' || (marker.ttl !== undefined && marker.ttl !== '5m' && marker.ttl !== '1h')
    || Object.keys(marker).some(field => field !== 'type' && field !== 'ttl')) return unsupported(path, 'invalid_cache_control');
  return { ok: true, value: { type: 'ephemeral', ...(marker.ttl === undefined ? {} : { ttl: marker.ttl }) } };
}

/** Native cache order is tools → system → messages; automatic cache is last.
 * https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 * A longer-lived breakpoint cannot follow a shorter-lived one.
 */
function validCacheOrder(request: MessagesRequest): boolean {
  const markers: MessagesCacheControl[] = [];
  const add = (marker: MessagesCacheControl | null | undefined): void => { if (marker) markers.push(marker); };
  for (const tool of request.tools ?? []) add(tool.cache_control);
  if (typeof request.system !== 'string') for (const block of request.system ?? []) add(block.cache_control);
  for (const message of request.messages) if (typeof message.content !== 'string') for (const block of message.content) {
    if (block.type === 'tool_result' && typeof block.content !== 'string') for (const child of block.content ?? []) add(child.cache_control);
    if (block.type !== 'thinking' && block.type !== 'redacted_thinking') add(block.cache_control);
  }
  add(request.cache_control);
  const lastMessage = request.messages[request.messages.length - 1];
  const lastBlock = lastMessage && typeof lastMessage.content !== 'string' ? lastMessage.content[lastMessage.content.length - 1] : undefined;
  if (request.cache_control && lastBlock && lastBlock.type !== 'thinking' && lastBlock.type !== 'redacted_thinking' && lastBlock.cache_control
    && (lastBlock.cache_control.ttl ?? '5m') !== (request.cache_control.ttl ?? '5m')) return false;
  let shortSeen = false;
  for (const marker of markers) { if (marker.ttl === '1h' && shortSeen) return false; if (marker.ttl !== '1h') shortSeen = true; }
  return markers.length <= 4;
}

function validToolName(value: string): boolean {
  return value.length > 0 && value.length <= 64 && !/[^A-Za-z0-9_-]/u.test(value);
}

/** Bounded complete JSON objects only; never trim, repair or truncate arguments. */
function parseToolArguments(text: string): JsonObject | undefined {
  if (text.length > 1_048_576) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { return undefined; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const work = [{ value: parsed as unknown, depth: 0 }];
  let nodes = 0;
  while (work.length) {
    const current = work.pop();
    if (!current || ++nodes > 100_000 || current.depth > 64) return undefined;
    if (typeof current.value === 'number' && (!Number.isFinite(current.value)
      || (Number.isInteger(current.value) && !Number.isSafeInteger(current.value)))) return undefined;
    if (current.value !== null && typeof current.value === 'object') {
      for (const child of Object.values(current.value)) work.push({ value: child as unknown, depth: current.depth + 1 });
      if (work.length > 100_000) return undefined;
    }
  }
  return parsed as JsonObject;
}
