import type { RequestAdapter } from '../types/adapter.js';
import type { ResponsesRequest, ResponsesInputImage } from '../types/responses.js';
import { parseResponsesRequest } from '../types/responses.js';
import type { MessagesRequest, MessagesCacheControl, MessagesOutputConfig, MessagesTextBlock, MessagesImageBlock, MessagesContentBlock, MessagesTool, MessagesToolChoice } from '../types/messages.js';
import type { ConversionResult, JsonObject, JsonValue } from '../types/shared.js';
import { isRepresentableWireId } from '../ids.js';
import { checkRequestCapabilities } from '../capabilities/check.js';
import type { ChannelCapabilities } from '../capabilities/check.js';

/**
 * Original direct implementation and synthetic tests; no copied/translated code.
 * Behavioral reference: Wei-Shaw/sub2api commit
 * ab99d56e9626e6cd731592dae8553c9758a0efa2,
 * backend/internal/pkg/apicompat/responses_to_anthropic_request.go
 * (ResponsesToAnthropicRequest; upstream root LICENSE LGPL-3.0).
 * Unlike the reference's 8192 fallback, model-policy maxTokens is mandatory.
 * No third wire protocol, hidden history lookup or provider call is involved.
 * Default tool strict semantics follow the 2026-09-06 checked contract at
 * https://developers.openai.com/api/docs/guides/function-calling#strict-mode
 * Known cache_control extensions use native Messages marker shape/ordering.
 */
export interface ResponsesToMessagesRequestOptions { readonly maxTokens: number; readonly channelCapabilities?: ChannelCapabilities }
export type ResponsesToMessagesRequestAdapter = RequestAdapter<ResponsesRequest, MessagesRequest, 'responses', 'messages'>;

function unsupported<T = MessagesRequest>(param: string, code = 'unsupported_responses_to_messages_feature'): ConversionResult<T> {
  return { ok: false, error: { kind: 'unsupported_feature', code,
    message: 'This Responses feature cannot be represented by the current Messages converter.', param } };
}

/**
 * Q1–Q6 bounded direct request mapping. Native instructions are a leading system block. A homogeneous
 * system OR developer prefix is preserved in order; mixed priorities and later
 * instruction turns are rejected, never hoisted or silently merged into a single
 * priority tier. Adjacent equal user/assistant roles merge ordered text blocks.
 */
export function createResponsesToMessagesRequestAdapter(options: ResponsesToMessagesRequestOptions): ConversionResult<ResponsesToMessagesRequestAdapter> {
  if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0) return {
    ok: false, error: { kind: 'invalid_request', code: 'invalid_messages_output_budget', message: 'A positive safe-integer Messages output budget is required.', param: 'maxTokens' },
  };
  const maxTokens = options.maxTokens;
  const policy = options.channelCapabilities === undefined ? undefined : structuredClone(options.channelCapabilities);
  if (policy && policy.protocol !== 'messages') return unsupported('channelCapabilities');
  return { ok: true, value: {
    from: 'responses', to: 'messages',
    convert(input, context) {
      if (typeof context.targetModel !== 'string' || !context.targetModel.trim()) return {
        ok: false, error: { kind: 'invalid_request', code: 'invalid_target_model', message: 'A target model is required.', param: 'targetModel' },
      };
      const parsed = parseResponsesRequest(input, { unknownFields: 'preserve' });
      if (!parsed.ok) return parsed;
      const request = parsed.value;
      const outputLimit = request.max_output_tokens ?? maxTokens;
      if (outputLimit == null) return unsupported('max_tokens', 'output_limit_required');
      const format = request.text?.format;
      const checked = checkRequestCapabilities({ protocol: 'responses', request: { ...request, max_output_tokens: outputLimit } }, policy ?? { protocol: 'messages', features: [] });
      if (!checked.supported) return unsupported(checked.reasons[0]?.path ?? 'input');
      for (const field of Object.keys(request)) if (!['model', 'instructions', 'input', 'tools', 'tool_choice', 'parallel_tool_calls', 'max_output_tokens', 'temperature', 'top_p', 'stream', 'text', 'reasoning', 'cache_control'].includes(field)) return unsupported(field);
      const automatic = marker(request.cache_control, 'cache_control'); if (!automatic.ok) return automatic;
      let outputConfig: MessagesOutputConfig | undefined;
      if (request.text !== undefined) {
        for (const field of Object.keys(request.text)) if (field !== 'format') return unsupported(`text.${field}`);
        if (format !== undefined) {
          if (!objectSchema(format)) return unsupported('text.format');
          for (const field of Object.keys(format)) if (!(format.type === 'json_schema' ? ['type','name','schema','description','strict'] : ['type']).includes(field)) return unsupported(`text.format.${field}`);
          if (format.type !== 'text') {
            if (format.type !== 'json_schema' || format.strict !== true || typeof format.name !== 'string' || !validName(format.name)
              || !objectSchema(format.schema) || format.schema.type !== 'object') return unsupported('text.format');
            const schema = normalizeSchema(format.schema, false);
            if (!schema || (format.description !== undefined && typeof format.description !== 'string')
              || (format.description !== undefined && schema.description !== undefined && schema.description !== format.description)) return unsupported('text.format.schema');
            // The source name is a format label, not a schema constraint.
            outputConfig = { format: { type:'json_schema', schema: format.description === undefined ? schema : {...schema,description:format.description} } };
          }
        }
      }
      if (request.reasoning != null) {
        for (const field of Object.keys(request.reasoning)) if (field !== 'effort') return unsupported(`reasoning.${field}`);
        if (request.reasoning.effort != null) {
          const effort = request.reasoning.effort;
          if (effort !== 'low' && effort !== 'medium' && effort !== 'high') return unsupported('reasoning.effort');
          // Effort is qualitative; never infer a thinking mode or fixed token budget.
          outputConfig = { ...outputConfig, effort };
        }
      }
      const tools: MessagesTool[] = [];
      const names = new Set<string>();
      for (const [index, definition] of (request.tools ?? []).entries()) {
        const path = `tools[${index}]`;
        if (definition.type !== 'function') return unsupported(`${path}.type`);
        for (const field of Object.keys(definition)) if (!['type', 'name', 'description', 'parameters', 'strict', 'cache_control'].includes(field)) return unsupported(`${path}.${field}`);
        if (!validName(definition.name) || names.has(definition.name) || definition.strict === null) return unsupported(path);
        if (!definition.parameters || definition.parameters.type !== 'object') return unsupported(`${path}.parameters`);
        const strict = definition.strict ?? true;
        const schema = strict ? normalizeSchema(definition.parameters, definition.strict === undefined) : structuredClone(definition.parameters);
        if (!schema) return unsupported(`${path}.parameters`);
        names.add(definition.name);
        const cache = marker(definition.cache_control, `${path}.cache_control`); if (!cache.ok) return cache;
        tools.push({ name: definition.name, input_schema: schema as JsonObject & { readonly type: 'object' }, strict,
          ...(definition.description === undefined ? {} : { description: definition.description }),
          ...(cache.value === undefined ? {} : { cache_control: cache.value }),
        });
      }
      let choice: MessagesToolChoice | undefined;
      if (request.tool_choice !== undefined || request.parallel_tool_calls !== undefined) {
        const selected = request.tool_choice ?? 'auto';
        const parallel = request.parallel_tool_calls === undefined ? {} : { disable_parallel_tool_use: !request.parallel_tool_calls };
        if (selected === 'none') choice = { type: 'none' };
        else if (typeof selected === 'string') { if (selected === 'required' && !tools.length) return unsupported('tool_choice'); choice = { type: selected === 'required' ? 'any' : 'auto', ...parallel }; }
        else {
          for (const field of Object.keys(selected)) if (!['type', 'name'].includes(field)) return unsupported(`tool_choice.${field}`);
          if (!names.has(selected.name)) return unsupported('tool_choice.name');
          choice = { type: 'tool', name: selected.name, ...parallel };
        }
      }
      const system: MessagesTextBlock[] = [];
      const messages: { role: 'user' | 'assistant'; content: MessagesContentBlock[] }[] = [];
      const pending = new Set<string>(); const seen = new Set<string>();
      const append = (role: 'user' | 'assistant', blocks: MessagesContentBlock[]): void => {
        const previous = messages[messages.length - 1];
        if (previous?.role === role) previous.content.push(...blocks);
        else messages.push({ role, content: blocks });
      };
      let instructionRole: 'system' | 'developer' | undefined;
      if (typeof request.instructions === 'string') {
        instructionRole = 'system';
        system.push({ type: 'text', text: request.instructions });
      }
      if (typeof request.input === 'string') messages.push({ role: 'user', content: [{ type: 'text', text: request.input }] });
      else if (request.input !== undefined) {
        for (const [index, item] of request.input.entries()) {
          const path = `input[${index}]`;
          if ((item.id !== undefined && !isRepresentableWireId(item.id)) || (item.status !== undefined && item.status !== 'completed')) return unsupported(path);
          if (item.type === 'function_call') {
            for (const field of Object.keys(item)) if (!['type', 'call_id', 'name', 'arguments', 'id', 'status'].includes(field)) return unsupported(`${path}.${field}`);
            if (!isRepresentableWireId(item.call_id) || seen.has(item.call_id) || !validName(item.name)
              || (pending.size && messages[messages.length - 1]?.role !== 'assistant')) return unsupported(path);
            const argumentsObject = parseArguments(item.arguments);
            if (!argumentsObject) return unsupported(`${path}.arguments`);
            append('assistant', [{ type: 'tool_use', id: item.call_id, name: item.name, input: argumentsObject }]);
            pending.add(item.call_id); seen.add(item.call_id);
            continue;
          }
          if (item.type === 'function_call_output') {
            for (const field of Object.keys(item)) if (!['type', 'call_id', 'output', 'id', 'status'].includes(field)) return unsupported(`${path}.${field}`);
            if (!pending.delete(item.call_id)) return unsupported(`${path}.call_id`);
            let content: string | (MessagesTextBlock | MessagesImageBlock)[] = typeof item.output === 'string' ? item.output : [];
            if (typeof item.output !== 'string') {
              const blocks: (MessagesTextBlock | MessagesImageBlock)[] = [];
              for (const [i, block] of item.output.entries()) {
                if (block.type === 'input_image') { const image = imageBlock(block, `${path}.output[${i}]`); if (!image.ok) return image; blocks.push(image.value); continue; }
                if (block.type !== 'input_text') return unsupported(`${path}.output[${i}].type`);
                for (const field of Object.keys(block)) if (!['type', 'text', 'cache_control'].includes(field)) return unsupported(`${path}.output[${i}].${field}`);
                const cache=marker(block.cache_control,`${path}.output[${i}].cache_control`); if(!cache.ok)return cache;
                blocks.push({ type: 'text', text: block.text, ...(cache.value===undefined?{}:{cache_control:cache.value}) });
              }
              content = blocks;
            }
            append('user', [{ type: 'tool_result', tool_use_id: item.call_id, content }]); continue;
          }
          if (item.type !== undefined && item.type !== 'message') return unsupported(`${path}.type`);
          if (pending.size && (item.role !== 'assistant' || messages[messages.length - 1]?.role !== 'assistant')) return unsupported(path);
          for (const field of Object.keys(item)) if (!['type', 'role', 'content', 'id', 'status'].includes(field)) return unsupported(`${path}.${field}`);
          const blocks: (MessagesTextBlock | MessagesImageBlock)[] = [];
          if (typeof item.content === 'string') blocks.push({ type: 'text', text: item.content });
          else {
            for (const [partIndex, part] of item.content.entries()) {
              const partPath = `${path}.content[${partIndex}]`;
              if (part.type === 'input_image' && item.role === 'user') { const image = imageBlock(part, partPath); if (!image.ok) return image; blocks.push(image.value); continue; }
              if (part.type !== 'input_text' && part.type !== 'output_text') return unsupported(`${partPath}.type`);
              const allowed = part.type === 'output_text' ? ['type', 'text', 'annotations', 'cache_control'] : ['type', 'text', 'cache_control'];
              for (const field of Object.keys(part)) if (!allowed.includes(field)) return unsupported(`${partPath}.${field}`);
              if (part.type === 'output_text' && part.annotations.length) return unsupported(`${partPath}.annotations`);
              const cache=marker(part.cache_control,`${partPath}.cache_control`);if(!cache.ok)return cache;
              blocks.push({ type: 'text', text: part.text, ...(cache.value===undefined?{}:{cache_control:cache.value}) });
            }
          }
          if (item.role === 'system' || item.role === 'developer') {
            if (messages.length) return unsupported(`${path}.role`, 'interleaved_instruction_not_representable');
            if (instructionRole !== undefined && instructionRole !== item.role) return unsupported(`${path}.role`, 'mixed_instruction_priorities_not_representable');
            instructionRole = item.role;
            for (const block of blocks) { if (block.type !== 'text') return unsupported(path); system.push(block); }
          } else {
            append(item.role, blocks);
          }
        }
      }
      if (!messages.length) return unsupported('input', 'messages_conversation_required');
      if (pending.size) return unsupported('input', 'incomplete_tool_history');
      const output: MessagesRequest = { model: context.targetModel, max_tokens: outputLimit, messages,
        ...(automatic.value===undefined?{}:{cache_control:automatic.value}),
        ...(request.temperature == null ? {} : { temperature: request.temperature }),
        ...(request.top_p == null ? {} : { top_p: request.top_p }),
        ...(request.stream === undefined ? {} : { stream: request.stream }),
        ...(outputConfig === undefined ? {} : { output_config: outputConfig }),
        ...(system.length ? { system } : {}),
        ...(request.tools === undefined ? {} : { tools }), ...(choice === undefined ? {} : { tool_choice: choice }),
      };
      if (!cacheOrder(output)) return unsupported('cache_control','invalid_cache_ttl_order');
      if (policy) { const checked = checkRequestCapabilities({ protocol: 'messages', request: output }, policy); if (!checked.supported) return unsupported(checked.reasons[0]?.path ?? 'output'); }
      return { ok: true, value: output };
    },
  } };
}

/** URI envelope validation only; never resolves file references or fetches media. */
function imageBlock(input: ResponsesInputImage, path: string): ConversionResult<MessagesImageBlock> {
  for (const field of Object.keys(input)) if (!['type','image_url','file_id','detail','cache_control'].includes(field)) return unsupported(`${path}.${field}`);
  const cache=marker(input.cache_control,`${path}.cache_control`);if(!cache.ok)return cache;
  const caching=cache.value===undefined?{}:{cache_control:cache.value};
  if (input.file_id != null || typeof input.image_url !== 'string' || (input.detail !== undefined && input.detail !== 'auto')) return unsupported(path);
  const value = input.image_url;
  if (value.startsWith('data:')) {
    if (value.length > 8_388_608) return unsupported(path);
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match?.[1] || !match[2] || match[2].length % 4) return unsupported(path);
    try { if (btoa(atob(match[2])) !== match[2]) return unsupported(path); } catch { return unsupported(path); }
    return { ok: true, value: { type: 'image', source: { type: 'base64', media_type: match[1] as 'image/png'|'image/jpeg'|'image/gif'|'image/webp', data: match[2] },...caching } };
  }
  if (value.length > 8192 || /[\s\u0000-\u001f\u007f]/u.test(value)) return unsupported(path);
  try { const url = new URL(value); if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname || url.username || url.password) return unsupported(path); }
  catch { return unsupported(path); }
  return { ok: true, value: { type: 'image', source: { type: 'url', url: value },...caching } };
}

/** Known vendor extension with native Messages shape; never arbitrary passthrough. */
function marker(value:unknown,path:string):ConversionResult<MessagesCacheControl|null|undefined>{
  if(value===undefined||value===null)return{ok:true,value};
  if(typeof value!=='object'||Array.isArray(value))return unsupported(path);
  const v=value as Record<string,unknown>;
  if(v.type!=='ephemeral'||(v.ttl!==undefined&&v.ttl!=='5m'&&v.ttl!=='1h')||Object.keys(v).some(k=>k!=='type'&&k!=='ttl'))return unsupported(path);
  return{ok:true,value:{type:'ephemeral',...(v.ttl===undefined?{}:{ttl:v.ttl})}};
}
function cacheOrder(request:MessagesRequest):boolean{
  const markers:MessagesCacheControl[]=[];const add=(v:MessagesCacheControl|null|undefined)=>{if(v)markers.push(v);};
  for(const tool of request.tools??[])add(tool.cache_control);
  if(typeof request.system!=='string')for(const block of request.system??[])add(block.cache_control);
  for(const message of request.messages)if(typeof message.content!=='string')for(const block of message.content){
    if(block.type==='tool_result'&&typeof block.content!=='string')for(const child of block.content??[])add(child.cache_control);
    if(block.type!=='thinking'&&block.type!=='redacted_thinking')add(block.cache_control);
  }
  add(request.cache_control);
  const last=request.messages[request.messages.length-1];const block=last&&typeof last.content!=='string'?last.content[last.content.length-1]:undefined;
  if(request.cache_control&&block&&block.type!=='thinking'&&block.type!=='redacted_thinking'&&block.cache_control&&(block.cache_control.ttl??'5m')!==(request.cache_control.ttl??'5m'))return false;
  let short=false;for(const value of markers){if(value.ttl==='1h'&&short)return false;if(value.ttl!=='1h')short=true;}
  return markers.length<=4;
}

function validName(name: string): boolean { return name.length > 0 && name.length <= 64 && !/[^A-Za-z0-9_-]/u.test(name); }
function parseArguments(text: string): JsonObject | undefined {
  if (text.length > 1_048_576) return undefined;
  let parsed: unknown; try { parsed = JSON.parse(text); } catch { return undefined; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const work = [{ value: parsed, depth: 0 }]; let nodes = 0;
  while (work.length) {
    const item = work.pop(); if (!item || ++nodes > 100_000 || item.depth > 64) return undefined;
    for (const value of Object.values(item.value)) {
      if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) return undefined;
      if (value !== null && typeof value === 'object') work.push({ value, depth: item.depth + 1 });
    }
  }
  return parsed as JsonObject;
}
const objectSchema = (value: JsonValue | undefined): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Same bounded normalization contract as RC-Q2; no provider fallback is guessed. */
function normalizeSchema(schema: JsonObject, normalize: boolean, depth = 0): JsonObject | undefined {
  if (depth > 32) return undefined;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.length || types.length > 2 || new Set(types).size !== types.length || !types.every(type => typeof type === 'string' && ['object','array','string','number','integer','boolean','null'].includes(type)) || (types.length === 2 && !types.includes('null'))) return undefined;
  const base = types.find(type => type !== 'null') ?? 'null';
  if (Object.keys(schema).some(field => !['type','description','title','enum', ...(base === 'object' ? ['properties','required','additionalProperties'] : base === 'array' ? ['items'] : [])].includes(field))) return undefined;
  for (const field of ['description','title']) if (schema[field] !== undefined && typeof schema[field] !== 'string') return undefined;
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.some(value => !types.some(type => type === 'null' ? value === null : type === 'integer' ? typeof value === 'number' && Number.isInteger(value) : ['string','number','boolean'].includes(String(type)) && typeof value === type)))) return undefined;
  const result: Record<string, JsonValue> = { ...schema };
  if (base === 'object') {
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) return undefined;
    const raw = schema.properties ?? {}; if (!objectSchema(raw)) return undefined;
    const properties: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, child] of Object.entries(raw)) { if (!objectSchema(child)) return undefined; const output = normalizeSchema(child, normalize, depth + 1); if (!output) return undefined; properties[key] = output; }
    const keys = Object.keys(properties); const required = schema.required;
    if (required !== undefined && (!Array.isArray(required) || required.some(key => typeof key !== 'string' || !Object.hasOwn(properties,key)) || new Set(required).size !== required.length)) return undefined;
    if (!normalize && (schema.additionalProperties !== false || !Array.isArray(required) || required.length !== keys.length)) return undefined;
    result.properties = properties; result.required = normalize ? keys : required as readonly JsonValue[]; result.additionalProperties = false;
  } else if (base === 'array') { if (!objectSchema(schema.items)) return undefined; const items = normalizeSchema(schema.items, normalize, depth + 1); if (!items) return undefined; result.items = items; }
  return result;
}
