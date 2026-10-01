import type { RequestAdapter, RequestContext } from '../types/adapter.js';
import type { ChatMessage, ChatRequest, ChatTextPart, ChatTool, ChatToolCall } from '../types/chat.js';
import { isRepresentableWireId } from '../ids.js';
import { checkRequestCapabilities } from '../capabilities/check.js';
import type { ChannelCapabilities } from '../capabilities/check.js';
import { parseMessagesRequest } from '../types/messages.js';
import type { MessagesRequest, MessagesImageBlock } from '../types/messages.js';
import type { ConversionResult, JsonObject } from '../types/shared.js';

/** Original implementation/tests. Behavioral reference only: Sub2API commit
 * ab99d56e9626e6cd731592dae8553c9758a0efa2,
 * backend/internal/pkg/apicompat/chatcompletions_anthropic_bridge.go,
 * AnthropicToChatCompletionsRequest (root LICENSE LGPL-3.0).
 * No Go code/fixtures copied; native direct conversion, no third wire pivot.
 */
function unsupported<T = ChatRequest>(param: string, code = 'unsupported_messages_to_chat_feature'): ConversionResult<T> {
  return { ok: false, error: { kind: 'unsupported_feature', code,
    message: 'This Messages feature is not implemented by the Chat converter.', param } };
}

/** Q1-Q6: direct Messages → Chat request mapping. Error-marked results,
 * native thinking/cache controls and text after a pending tool_use have no
 * lossless Chat representation in this subset. */
export interface MessagesToChatRequestOptions { readonly channelCapabilities?: ChannelCapabilities }
export function messagesToChatRequest(input: unknown, context: RequestContext, options: MessagesToChatRequestOptions = {}): ConversionResult<ChatRequest> {
  const parsed = parseMessagesRequest(input, { unknownFields: 'preserve' });
  if (!parsed.ok) return parsed;
  if (typeof context?.targetModel !== 'string' || !context.targetModel.trim()) return {
    ok: false, error: { kind: 'invalid_request', code: 'invalid_target_model', message: 'A target model is required.', param: 'targetModel' },
  };
  const request = parsed.value;
  const hasImages = request.messages.some(message => typeof message.content !== 'string' && message.content.some(block => block.type === 'image'
    || (block.type === 'tool_result' && block.content !== undefined && typeof block.content !== 'string' && block.content.some(part => part.type === 'image'))));
  const hasSampling = request.temperature !== undefined || request.top_p !== undefined;
  const hasStreaming = request.stream !== undefined;
  const hasStop = request.stop_sequences !== undefined;
  const hasOutputConfig = request.output_config !== undefined
    && (request.output_config.effort !== undefined && request.output_config.effort !== null
      || request.output_config.format !== undefined && request.output_config.format !== null);
  const hasAdvanced = hasImages || hasSampling || hasStreaming || hasStop || hasOutputConfig
    || request.top_k !== undefined || request.thinking !== undefined;
  /*
   * The first three milestones deliberately remain usable without a channel
   * policy. Once a request carries a model-dependent control, P10 evidence is
   * required. If a policy is supplied, check even a plain request so its
   * output limit and declared tool/image capabilities are enforced.
   */
  if (hasAdvanced && !options.channelCapabilities) return unsupported('channelCapabilities');
  if (options.channelCapabilities) {
    if (options.channelCapabilities.protocol !== 'chat') return unsupported('channelCapabilities', 'invalid_channel_capabilities');
    const checked = checkRequestCapabilities({ protocol: 'messages', request }, options.channelCapabilities);
    if (!checked.supported) return unsupported(checked.reasons[0]?.path ?? 'messages', checked.reasons[0]?.code ?? 'missing_capability');
  }
  for (const field of Object.keys(request)) if (!['model', 'max_tokens', 'system', 'messages', 'tools', 'tool_choice',
    'stream', 'temperature', 'top_p', 'stop_sequences', 'output_config'].includes(field)) return unsupported(field);

  /* Messages thinking modes and signed/redacted history have no Chat wire
   * counterpart. They must be rejected before any ordinary-text conversion. */
  if (request.thinking !== undefined) return unsupported('thinking', 'unrepresentable_thinking');
  if (request.top_k !== undefined) return unsupported('top_k', 'unrepresentable_top_k');
  if (request.stop_sequences !== undefined && (!Array.isArray(request.stop_sequences) || request.stop_sequences.length === 0 || request.stop_sequences.length > 4)) {
    // Chat's stop list requires at least one value. An explicit empty list is
    // retained as an unsupported source constraint rather than rewritten.
    return unsupported('stop_sequences', 'unrepresentable_stop_sequences');
  }
  let outputLimit = request.max_tokens;
  let responseFormat: ChatRequest['response_format'] | undefined;
  let reasoningEffort: string | undefined;
  if (request.output_config !== undefined) {
    const config = request.output_config;
    for (const field of Object.keys(config)) if (!['effort', 'format'].includes(field)) return unsupported(`output_config.${field}`);
    if (config.effort !== undefined && config.effort !== null) {
      if (!['low', 'medium', 'high'].includes(config.effort)) return unsupported('output_config.effort', 'unrepresentable_effort');
      reasoningEffort = config.effort;
    }
    if (config.format !== undefined && config.format !== null) {
      const format = config.format;
      for (const field of Object.keys(format)) if (!['type', 'schema'].includes(field)) return unsupported(`output_config.format.${field}`);
      if (format.type !== 'json_schema') {
        return unsupported('output_config.format', 'unrepresentable_output_schema');
      }
      /* Messages has no schema label. The Chat name is an envelope label and
       * therefore uses a stable, valid value while preserving the schema. */
      responseFormat = { type: 'json_schema', json_schema: { name: 'output', schema: structuredClone(format.schema), strict: true } };
    }
  }
  const tools: ChatTool[] = [];
  const names = new Set<string>();
  for (const [index, tool] of (request.tools ?? []).entries()) {
    const path = `tools[${index}]`;
    if (tool.type !== undefined && tool.type !== 'custom') return unsupported(`${path}.type`);
    for (const field of Object.keys(tool)) if (!['type', 'name', 'description', 'input_schema', 'strict'].includes(field)) return unsupported(`${path}.${field}`);
    if (!nameValid(tool.name) || names.has(tool.name)) return unsupported(`${path}.name`);
    names.add(tool.name);
    tools.push({ type: 'function', function: { name: tool.name, parameters: structuredClone(tool.input_schema), strict: tool.strict ?? false,
      ...(tool.description === undefined ? {} : { description: tool.description }),
    } });
  }
  let choice: ChatRequest['tool_choice'];
  let parallel: boolean | undefined;
  if (request.tool_choice !== undefined) {
    const source = request.tool_choice;
    for (const field of Object.keys(source)) if (!(source.type === 'none' ? ['type'] : source.type === 'tool'
      ? ['type', 'name', 'disable_parallel_tool_use'] : ['type', 'disable_parallel_tool_use']).includes(field)) return unsupported(`tool_choice.${field}`);
    if (source.type === 'none') choice = 'none';
    else {
      if (source.disable_parallel_tool_use !== undefined) parallel = !source.disable_parallel_tool_use;
      if (source.type === 'tool') {
        if (!names.has(source.name)) return unsupported('tool_choice.name');
        choice = { type: 'function', function: { name: source.name } };
      } else { if (source.type === 'any' && !tools.length) return unsupported('tool_choice'); choice = source.type === 'any' ? 'required' : 'auto'; }
    }
  }
  const messages: ChatMessage[] = [];
  if (typeof request.system === 'string') messages.push({ role: 'system', content: request.system });
  else if (request.system !== undefined) {
    const content: ChatTextPart[] = [];
    for (const [index, block] of request.system.entries()) {
      for (const field of Object.keys(block)) if (!['type', 'text'].includes(field)) return unsupported(`system[${index}].${field}`);
      content.push({ type: 'text', text: block.text });
    }
    if (content.length) messages.push({ role: 'system', content }); // Empty system list contains no instructions.
  }
  const pending = new Set<string>();
  const seen = new Set<string>();
  let turnCount = 0;
  const addText = (role: 'user' | 'assistant', text: string): void => {
    const previous = messages[messages.length - 1];
    const part: ChatTextPart = { type: 'text', text };
    if (previous?.role === role && Array.isArray(previous.content)) messages[messages.length - 1] = { ...previous, content: [...previous.content, part] };
    else messages.push({ role, content: [part] });
  };
  for (const [index, message] of request.messages.entries()) {
    const path = `messages[${index}]`;
    for (const field of Object.keys(message)) if (!['role', 'content'].includes(field)) return unsupported(`${path}.${field}`);
    const blocks = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content;
    if (!blocks.length) return unsupported(`${path}.content`);
    let userText = false;
    for (const [partIndex, block] of blocks.entries()) {
      const partPath = `${path}.content[${partIndex}]`;
      if (block.type === 'text') {
        if (pending.size) return unsupported(partPath); // Do not move text across pending tool calls/results.
        for (const field of Object.keys(block)) if (!['type', 'text'].includes(field)) return unsupported(`${partPath}.${field}`);
        addText(message.role, block.text); userText = message.role === 'user';
      } else if (block.type === 'image' && message.role === 'user') {
        if (pending.size) return unsupported(partPath);
        const image = imageUrl(block, partPath);
        if (!image.ok) return image;
        const part = { type: 'image_url' as const, image_url: { url: image.value, detail: 'auto' as const } };
        const previous = messages[messages.length - 1];
        if (previous?.role === 'user' && Array.isArray(previous.content)) messages[messages.length - 1] = { ...previous, content: [...previous.content, part] };
        else messages.push({ role: 'user', content: [part] });
        userText = true;
      } else if (block.type === 'tool_use' && message.role === 'assistant') {
        for (const field of Object.keys(block)) if (!['type', 'id', 'name', 'input'].includes(field)) return unsupported(`${partPath}.${field}`);
        if (!isRepresentableWireId(block.id) || seen.has(block.id) || !nameValid(block.name)) return unsupported(`${partPath}.id`);
        const args = argumentsText(block.input);
        if (args === undefined) return unsupported(`${partPath}.input`);
        const call: ChatToolCall = { id: block.id, type: 'function', function: { name: block.name, arguments: args } };
        const previous = messages[messages.length - 1];
        if (pending.size && previous?.role !== 'assistant') return unsupported(partPath);
        if (previous?.role === 'assistant') messages[messages.length - 1] = { ...previous, tool_calls: [...(previous.tool_calls ?? []), call] };
        else messages.push({ role: 'assistant', content: null, tool_calls: [call] });
        pending.add(block.id); seen.add(block.id);
      } else if (block.type === 'tool_result' && message.role === 'user') {
        for (const field of Object.keys(block)) if (!['type', 'tool_use_id', 'content', 'is_error'].includes(field)) return unsupported(`${partPath}.${field}`);
        if (userText || block.is_error === true || !pending.delete(block.tool_use_id)) return unsupported(partPath);
        let content: string | ChatTextPart[] = typeof block.content === 'string' ? block.content : '';
        if (typeof block.content !== 'string' && block.content !== undefined) {
          content = [];
          for (const [resultIndex, part] of block.content.entries()) {
            if (part.type !== 'text') return unsupported(`${partPath}.content[${resultIndex}].type`);
            for (const field of Object.keys(part)) if (!['type', 'text'].includes(field)) return unsupported(`${partPath}.content[${resultIndex}].${field}`);
            content.push({ type: 'text', text: part.text });
          }
          if (!content.length) content = '';
        }
        messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content });
      } else return unsupported(`${partPath}.type`);
    }
    turnCount++;
  }
  if (!turnCount || pending.size) return unsupported('messages');
  return { ok: true, value: { model: context.targetModel, max_completion_tokens: outputLimit, messages,
    ...(request.stream === undefined ? {} : { stream: request.stream }),
    ...(request.temperature === undefined || request.temperature === null ? {} : { temperature: request.temperature }),
    ...(request.top_p === undefined || request.top_p === null ? {} : { top_p: request.top_p }),
    ...(request.stop_sequences === undefined ? {} : { stop: [...request.stop_sequences] }),
    ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
    ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
    ...(request.tools === undefined ? {} : { tools }), ...(choice === undefined ? {} : { tool_choice: choice }),
    ...(parallel === undefined ? {} : { parallel_tool_calls: parallel }),
  } };
}
function nameValid(name: string): boolean { return name.length > 0 && name.length <= 64 && !/[^A-Za-z0-9_-]/u.test(name); }
function argumentsText(input: JsonObject): string | undefined {
  const pending: unknown[] = [input];
  let nodes = 0;
  while (pending.length) {
    if (++nodes > 100_000 || pending.length > 100_000) return undefined;
    const value = pending.pop();
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) return undefined;
    if (value !== null && typeof value === 'object') pending.push(...Object.values(value));
  }
  const serialized = JSON.stringify(input);
  return serialized.length <= 1_048_576 ? serialized : undefined;
}

export const messagesToChatRequestAdapter: RequestAdapter<MessagesRequest, ChatRequest, 'messages', 'chat'> = {
  from: 'messages', to: 'chat', convert: messagesToChatRequest,
};

/** Explicit policy factory; the default adapter remains fail-closed for images. */
export function createMessagesToChatRequestAdapter(channelCapabilities: ChannelCapabilities): typeof messagesToChatRequestAdapter {
  const policy = structuredClone(channelCapabilities);
  return { from: 'messages', to: 'chat', convert: (input, context) => messagesToChatRequest(input, context, { channelCapabilities: policy }) };
}

/** Validates transport envelope only, never downloads or decodes image pixels. */
function imageUrl(block: MessagesImageBlock, path: string): ConversionResult<string> {
  for (const field of Object.keys(block)) if (!['type', 'source'].includes(field)) return unsupported(`${path}.${field}`);
  const source = block.source;
  const allowed = source.type === 'url' ? ['type', 'url'] : ['type', 'media_type', 'data'];
  for (const field of Object.keys(source)) if (!allowed.includes(field)) return unsupported(`${path}.source.${field}`);
  if (source.type === 'base64') {
    if (!source.data.length || source.data.length > 8_388_608 || source.data.length % 4 || /[^A-Za-z0-9+/=]/u.test(source.data)) return unsupported(`${path}.source.data`);
    try { if (btoa(atob(source.data)) !== source.data) return unsupported(`${path}.source.data`); }
    catch { return unsupported(`${path}.source.data`); }
    return { ok: true, value: `data:${source.media_type};base64,${source.data}` };
  }
  if (source.url.length > 8192 || /[\s\u0000-\u001f\u007f]/u.test(source.url)) return unsupported(`${path}.source.url`);
  try { const url = new URL(source.url); if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) return unsupported(`${path}.source.url`); }
  catch { return unsupported(`${path}.source.url`); }
  return { ok: true, value: source.url };
}
