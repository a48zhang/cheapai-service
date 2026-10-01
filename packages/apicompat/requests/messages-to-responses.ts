import type { RequestAdapter, RequestContext } from '../types/adapter.js';
import { parseMessagesRequest } from '../types/messages.js';
import type { MessagesRequest, MessagesImageBlock } from '../types/messages.js';
import type { ResponsesInputItem, ResponsesInputText, ResponsesInputContent, ResponsesOutputText, ResponsesRequest, ResponsesFunctionTool } from '../types/responses.js';
import { checkRequestCapabilities } from '../capabilities/check.js';
import type { ChannelCapabilities } from '../capabilities/check.js';
import type { ConversionResult, JsonObject } from '../types/shared.js';
import { isRepresentableWireId } from '../ids.js';

/** Original direct implementation/tests. Behavioral reference: Sub2API commit
 * ab99d56e9626e6cd731592dae8553c9758a0efa2,
 * backend/internal/pkg/apicompat/anthropic_to_responses.go, AnthropicToResponses
 * (root LICENSE LGPL-3.0). No source/fixture copied or Chat intermediary used.
 * Unlike that baseline, no forced store/parallel/verbosity/encrypted-reasoning
 * options and no minimum-output-budget clamp are synthesized.
 */
function unsupported<T = ResponsesRequest>(param: string, code = 'unsupported_messages_to_responses_feature'): ConversionResult<T> {
  return { ok: false, error: { kind: 'unsupported_feature', code,
    message: 'This Messages feature is not implemented by the Responses converter.', param } };
}

export interface MessagesToResponsesRequestOptions { readonly channelCapabilities?: ChannelCapabilities }
export function messagesToResponsesRequest(input: unknown, context: RequestContext, options: MessagesToResponsesRequestOptions = {}): ConversionResult<ResponsesRequest> {
  const parsed = parseMessagesRequest(input, { unknownFields: 'preserve' });
  if (!parsed.ok) return parsed;
  if (typeof context?.targetModel !== 'string' || !context.targetModel.trim()) return {
    ok: false, error: { kind: 'invalid_request', code: 'invalid_target_model', message: 'A target model is required.', param: 'targetModel' },
  };
  const request = parsed.value;
  const outputLimit = request.max_tokens;
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
  if (hasAdvanced && !options.channelCapabilities) return unsupported('channelCapabilities');
  if (options.channelCapabilities) {
    if (options.channelCapabilities.protocol !== 'responses') return unsupported('channelCapabilities', 'invalid_channel_capabilities');
    const checked = checkRequestCapabilities({ protocol: 'messages', request }, options.channelCapabilities);
    if (!checked.supported) return unsupported(checked.reasons[0]?.path ?? 'messages', checked.reasons[0]?.code ?? 'missing_capability');
  }
  for (const field of Object.keys(request)) if (!['model', 'max_tokens', 'system', 'messages', 'tools', 'tool_choice',
    'stream', 'temperature', 'top_p', 'output_config'].includes(field)) return unsupported(field);
  if (request.thinking !== undefined) return unsupported('thinking', 'unrepresentable_thinking');
  if (request.top_k !== undefined) return unsupported('top_k', 'unrepresentable_top_k');
  // Responses has no stop-sequence request field. Do not erase even an empty
  // explicit list: retaining the constraint is safer than pretending support.
  if (request.stop_sequences !== undefined) return unsupported('stop_sequences', 'unrepresentable_stop_sequences');

  let responseFormat: ResponsesRequest['text'] | undefined;
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
      /* The native Messages format has no label/strict switch. Responses'
       * envelope requires both, so use a stable label and preserve strictness. */
      responseFormat = { format: { type: 'json_schema', name: 'output', schema: structuredClone(format.schema), strict: true } };
    }
  }
  const tools: ResponsesFunctionTool[] = [];
  const names = new Set<string>();
  for (const [index, tool] of (request.tools ?? []).entries()) {
    const path = `tools[${index}]`;
    if (tool.type !== undefined && tool.type !== 'custom') return unsupported(`${path}.type`);
    for (const field of Object.keys(tool)) if (!['type', 'name', 'description', 'input_schema', 'strict'].includes(field)) return unsupported(`${path}.${field}`);
    if (!validName(tool.name) || names.has(tool.name)) return unsupported(`${path}.name`);
    names.add(tool.name);
    // Explicit false prevents Responses from imposing implicit strict normalization.
    tools.push({ type: 'function', name: tool.name, parameters: structuredClone(tool.input_schema), strict: tool.strict ?? false,
      ...(tool.description === undefined ? {} : { description: tool.description }),
    });
  }
  let choice: ResponsesRequest['tool_choice'];
  let parallel: boolean | undefined;
  if (request.tool_choice !== undefined) {
    const source = request.tool_choice;
    for (const field of Object.keys(source)) if (!(source.type === 'none' ? ['type'] : source.type === 'tool' ? ['type', 'name', 'disable_parallel_tool_use']
      : ['type', 'disable_parallel_tool_use']).includes(field)) return unsupported(`tool_choice.${field}`);
    if (source.type === 'none') choice = 'none';
    else {
      if (source.disable_parallel_tool_use !== undefined) parallel = !source.disable_parallel_tool_use;
      if (source.type === 'tool') {
        if (!names.has(source.name)) return unsupported('tool_choice.name');
        choice = { type: 'function', name: source.name };
      } else { if (source.type === 'any' && !tools.length) return unsupported('tool_choice'); choice = source.type === 'any' ? 'required' : 'auto'; }
    }
  }
  const history: ResponsesInputItem[] = [];
  if (typeof request.system === 'string') history.push({ type: 'message', role: 'system', content: request.system });
  else if (request.system !== undefined) {
    const content: ResponsesInputText[] = [];
    for (const [index, block] of request.system.entries()) {
      for (const field of Object.keys(block)) if (!['type', 'text'].includes(field)) return unsupported(`system[${index}].${field}`);
      content.push({ type: 'input_text', text: block.text });
    }
    if (content.length) history.push({ type: 'message', role: 'system', content });
  }
  const pending = new Set<string>();
  const seen = new Set<string>();
  let previousRole: 'user' | 'assistant' | undefined;
  let turnCount = 0;
  for (const [index, message] of request.messages.entries()) {
    const path = `messages[${index}]`;
    for (const field of Object.keys(message)) if (!['role', 'content'].includes(field)) return unsupported(`${path}.${field}`);
    if (pending.size && previousRole === 'user' && message.role === 'assistant') return unsupported(path);
    const blocks = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content;
    if (!blocks.length) return unsupported(`${path}.content`);
    for (const [partIndex, block] of blocks.entries()) {
      const partPath = `${path}.content[${partIndex}]`;
      if (block.type === 'text') {
        if (message.role === 'user' && pending.size) return unsupported(partPath);
        for (const field of Object.keys(block)) if (!['type', 'text'].includes(field)) return unsupported(`${partPath}.${field}`);
        const part: ResponsesInputText | ResponsesOutputText = message.role === 'assistant'
          ? { type: 'output_text', text: block.text, annotations: [] } : { type: 'input_text', text: block.text };
        const previous = history[history.length - 1];
        if (previous?.type === 'message' && previous.role === message.role && Array.isArray(previous.content)) history[history.length - 1] = { ...previous, content: [...previous.content, part] };
        else history.push({ type: 'message', role: message.role, content: [part] });
      } else if (block.type === 'image' && message.role === 'user') {
        if (pending.size) return unsupported(partPath);
        const url = imageUrl(block, partPath);
        if (!url.ok) return url;
        const image = { type: 'input_image' as const, image_url: url.value, detail: 'auto' as const };
        const previous = history[history.length - 1];
        if (previous?.type === 'message' && previous.role === 'user' && Array.isArray(previous.content)) history[history.length - 1] = { ...previous, content: [...previous.content, image] };
        else history.push({ type: 'message', role: 'user', content: [image] });
      } else if (block.type === 'tool_use' && message.role === 'assistant') {
        for (const field of Object.keys(block)) if (!['type', 'id', 'name', 'input'].includes(field)) return unsupported(`${partPath}.${field}`);
        if (!isRepresentableWireId(block.id) || seen.has(block.id) || !validName(block.name)) return unsupported(`${partPath}.id`);
        const args = serializeArguments(block.input);
        if (args === undefined) return unsupported(`${partPath}.input`);
        history.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: args });
        seen.add(block.id); pending.add(block.id);
      } else if (block.type === 'tool_result' && message.role === 'user') {
        for (const field of Object.keys(block)) if (!['type', 'tool_use_id', 'content', 'is_error'].includes(field)) return unsupported(`${partPath}.${field}`);
        if (block.is_error === true || !pending.delete(block.tool_use_id)) return unsupported(partPath);
        let output: string | ResponsesInputContent[] = typeof block.content === 'string' ? block.content : '';
        if (block.content !== undefined && typeof block.content !== 'string') {
          output = [];
          for (const [resultIndex, result] of block.content.entries()) {
            if (result.type === 'image') {
              const url = imageUrl(result, `${partPath}.content[${resultIndex}]`);
              if (!url.ok) return url;
              output.push({ type: 'input_image', image_url: url.value, detail: 'auto' });
              continue;
            }
            for (const field of Object.keys(result)) if (!['type', 'text'].includes(field)) return unsupported(`${partPath}.content[${resultIndex}].${field}`);
            output.push({ type: 'input_text', text: result.text });
          }
          if (!output.length) output = '';
        }
        history.push({ type: 'function_call_output', call_id: block.tool_use_id, output });
      } else return unsupported(`${partPath}.type`);
    }
    previousRole = message.role; turnCount++;
  }
  if (!turnCount || pending.size) return unsupported('messages');
  return { ok: true, value: { model: context.targetModel, max_output_tokens: outputLimit, input: history,
    ...(request.stream === undefined ? {} : { stream: request.stream }),
    ...(request.temperature === undefined || request.temperature === null ? {} : { temperature: request.temperature }),
    ...(request.top_p === undefined || request.top_p === null ? {} : { top_p: request.top_p }),
    ...(responseFormat === undefined ? {} : { text: responseFormat }),
    ...(reasoningEffort === undefined ? {} : { reasoning: { effort: reasoningEffort } }),
    ...(request.tools === undefined ? {} : { tools }), ...(choice === undefined ? {} : { tool_choice: choice }),
    ...(parallel === undefined ? {} : { parallel_tool_calls: parallel }),
  } };
}
function validName(name: string): boolean { return name.length > 0 && name.length <= 64 && !/[^A-Za-z0-9_-]/u.test(name); }
function serializeArguments(input: JsonObject): string | undefined {
  const pending: unknown[] = [input]; let nodes = 0;
  while (pending.length) {
    if (++nodes > 100_000 || pending.length > 100_000) return undefined;
    const value = pending.pop();
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) return undefined;
    if (value !== null && typeof value === 'object') pending.push(...Object.values(value));
  }
  const text = JSON.stringify(input); return text.length <= 1_048_576 ? text : undefined;
}

export const messagesToResponsesRequestAdapter: RequestAdapter<MessagesRequest, ResponsesRequest, 'messages', 'responses'> = {
  from: 'messages', to: 'responses', convert: messagesToResponsesRequest,
};
export function createMessagesToResponsesRequestAdapter(channelCapabilities: ChannelCapabilities): typeof messagesToResponsesRequestAdapter {
  const policy = structuredClone(channelCapabilities);
  return { from: 'messages', to: 'responses', convert: (input, context) => messagesToResponsesRequest(input, context, { channelCapabilities: policy }) };
}
/** Source envelope only; no remote reads, image transcoding or MIME guessing. */
function imageUrl(block: MessagesImageBlock, path: string): ConversionResult<string> {
  for (const field of Object.keys(block)) if (!['type', 'source'].includes(field)) return unsupported(`${path}.${field}`);
  const source = block.source;
  for (const field of Object.keys(source)) if (!(source.type === 'url' ? ['type', 'url'] : ['type', 'media_type', 'data']).includes(field)) return unsupported(`${path}.source.${field}`);
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
