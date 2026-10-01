import type { ConversionResult, JsonObject, JsonValue } from './shared.js';

// Original, deliberately bounded Chat wire contract; no upstream code/fixtures copied.
/** Preserved JSON extensions are data, never permission for cross-protocol forwarding. */
export interface ChatExtensions { readonly [key: string]: unknown }
export interface ChatTextPart extends ChatExtensions { readonly type: 'text'; readonly text: string }
export interface ChatImagePart extends ChatExtensions {
  readonly type: 'image_url';
  readonly image_url: { readonly url: string; readonly detail?: 'auto' | 'low' | 'high' };
}
export interface ChatRefusalPart extends ChatExtensions { readonly type: 'refusal'; readonly refusal: string }
export interface ChatToolCall extends ChatExtensions {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}
export interface ChatTool extends ChatExtensions {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: JsonObject;
    readonly strict?: boolean | null;
  };
}
export type ChatMessage = ChatExtensions & (
  | { readonly role: 'system' | 'developer'; readonly content: string | readonly ChatTextPart[]; readonly name?: string }
  | { readonly role: 'user'; readonly content: string | readonly (ChatTextPart | ChatImagePart)[]; readonly name?: string }
  | {
      readonly role: 'assistant';
      readonly content?: string | readonly (ChatTextPart | ChatRefusalPart)[] | null;
      readonly name?: string;
      readonly tool_calls?: readonly ChatToolCall[];
      readonly refusal?: string | null;
      /** Recognized provider aliases; never turn private reasoning into visible text. */
      readonly reasoning_content?: string | null;
      readonly reasoning?: string | null;
    }
  | { readonly role: 'tool'; readonly content: string | readonly ChatTextPart[]; readonly tool_call_id: string });
export type ChatToolChoice = 'auto' | 'none' | 'required'
  | { readonly type: 'function'; readonly function: { readonly name: string } };
export type ChatResponseFormat =
  | { readonly type: 'text' | 'json_object' }
  | { readonly type: 'json_schema'; readonly json_schema: {
      readonly name: string; readonly description?: string; readonly schema: JsonObject; readonly strict?: boolean | null;
    } };
export interface ChatRequest extends ChatExtensions {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly stream?: boolean;
  readonly stream_options?: { readonly include_usage?: boolean } | null;
  readonly tools?: readonly ChatTool[];
  readonly tool_choice?: ChatToolChoice;
  readonly parallel_tool_calls?: boolean;
  readonly max_tokens?: number | null;
  readonly max_completion_tokens?: number | null;
  readonly temperature?: number | null;
  readonly top_p?: number | null;
  readonly stop?: string | readonly string[] | null;
  readonly n?: number | null;
  readonly seed?: number | null;
  readonly frequency_penalty?: number | null;
  readonly presence_penalty?: number | null;
  readonly response_format?: ChatResponseFormat;
  readonly reasoning_effort?: string | null;
  readonly service_tier?: string | null;
  readonly user?: string;
  readonly metadata?: Readonly<Record<string, string>> | null;
}
/** Partial counts are retained as evidence; an extractor validates billing semantics. */
export interface ChatUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
  readonly prompt_tokens_details?: JsonObject & { readonly cached_tokens?: number };
  readonly completion_tokens_details?: JsonObject & { readonly reasoning_tokens?: number };
  readonly [key: string]: JsonValue | undefined;
}
/** Unknown provider reasons remain strings for the later terminal-state mapper. */
export type ChatFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' | (string & {});
export interface ChatResponseMessage extends ChatExtensions {
  readonly role: 'assistant';
  readonly content: string | null;
  readonly refusal?: string | null;
  readonly tool_calls?: readonly ChatToolCall[];
  readonly reasoning_content?: string | null;
  readonly reasoning?: string | null;
  readonly annotations?: readonly ChatUrlCitation[];
}
/** Official Chat response annotation schema; these are response data, not tools. */
export interface ChatUrlCitation extends ChatExtensions {
  readonly type: 'url_citation';
  readonly url_citation: { readonly start_index: number; readonly end_index: number; readonly title: string; readonly url: string };
}
export interface ChatResponse extends ChatExtensions {
  readonly id: string;
  readonly object: 'chat.completion';
  readonly created: number;
  readonly model: string;
  readonly choices: readonly { readonly index: number; readonly message: ChatResponseMessage; readonly finish_reason: ChatFinishReason; readonly logprobs?: JsonObject | null }[];
  readonly usage?: ChatUsage | null;
  readonly system_fingerprint?: string | null;
  readonly service_tier?: string | null;
}
export interface ChatDelta extends ChatExtensions {
  readonly role?: 'assistant';
  readonly content?: string | null;
  readonly refusal?: string | null;
  readonly reasoning_content?: string | null;
  readonly reasoning?: string | null;
  /** Arguments may be incomplete JSON; ID/name may appear only in the first chunk. */
  readonly tool_calls?: readonly {
    readonly index: number; readonly id?: string; readonly type?: 'function';
    readonly function?: { readonly name?: string; readonly arguments?: string };
  }[];
}
export interface ChatChunk extends ChatExtensions {
  readonly id: string;
  readonly object: 'chat.completion.chunk';
  readonly created: number;
  readonly model: string;
  /** An empty choices array is valid for the final usage-only chunk. */
  readonly choices: readonly { readonly index: number; readonly delta: ChatDelta; readonly finish_reason: ChatFinishReason | null; readonly logprobs?: JsonObject | null }[];
  readonly usage?: ChatUsage | null;
  readonly system_fingerprint?: string | null;
  readonly service_tier?: string | null;
}
export interface ChatErrorBody {
  readonly error: { readonly message: string; readonly type: string; readonly param?: string | null; readonly code?: string | number | null };
}
export interface ChatValidationOptions {
  /** Preserve validated JSON in place; converters must still select fields explicitly. */
  readonly unknownFields?: 'reject' | 'preserve';
  /** Explicit caller-owned top-level allowlist; default rejects every unknown key. */
  readonly allowedExtensions?: readonly string[];
}

type ObjectValue = Record<string, unknown>;
type Check = (value: unknown, path: string, options?: ChatValidationOptions) => string | undefined;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const string: Check = (v, p) => typeof v === 'string' ? undefined : p;
const nonempty: Check = (v, p) => typeof v === 'string' && v.trim().length > 0 ? undefined : p;
const bool: Check = (v, p) => typeof v === 'boolean' ? undefined : p;
const integer: Check = (v, p) => Number.isSafeInteger(v) ? undefined : p;
const positive: Check = (v, p) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? undefined : p;
const range = (min: number, max: number): Check => (v, p) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? undefined : p;
const nullable = (check: Check): Check => (v, p, options) => v === null ? undefined : check(v, p, options);
const oneOf = (...values: readonly string[]): Check => (v, p) => typeof v === 'string' && values.includes(v) ? undefined : p;
const list = (check: Check, min = 0, max = Number.MAX_SAFE_INTEGER): Check => (v, p, options) => {
  if (!Array.isArray(v) || v.length < min || v.length > max) return p;
  for (let i = 0; i < v.length; i++) { const error = check(v[i], `${p}[${i}]`, options); if (error) return error; }
  return undefined;
};
const shape = (required: Record<string, Check>, optional: Record<string, Check> = {}): Check => (v, p, options) => {
  if (!object(v)) return p;
  for (const key of Object.keys(v)) if (!Object.hasOwn(required, key) && !Object.hasOwn(optional, key)
    && options?.unknownFields !== 'preserve' && !(p === '$' && options?.allowedExtensions?.includes(key))) return `${p}.${key}`;
  for (const [key, check] of Object.entries(required)) { const error = check(v[key], `${p}.${key}`, options); if (error) return error; }
  for (const [key, check] of Object.entries(optional)) if (Object.hasOwn(v, key)) { const error = check(v[key], `${p}.${key}`, options); if (error) return error; }
  return undefined;
};

/** Bound traversal before recursive schema checks; rejects cycles/non-JSON values. */
function jsonBoundary(value: unknown): boolean {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let count = 0;
  while (pending.length) {
    const item = pending.pop();
    if (!item || ++count > 100_000 || item.depth > 64) return false;
    const v = item.value;
    if (v === null || typeof v === 'string' || typeof v === 'boolean') continue;
    if (typeof v === 'number') { if (!Number.isFinite(v)) return false; continue; }
    if (!Array.isArray(v) && !object(v)) return false;
    if (seen.has(v)) return false;
    seen.add(v);
    const keys = Object.keys(v);
    if (keys.length + pending.length > 100_000 || Object.getOwnPropertySymbols(v).length) return false;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      if (!descriptor || !('value' in descriptor)) return false;
      pending.push({ value: descriptor.value, depth: item.depth + 1 });
    }
    if (Array.isArray(v) && keys.length !== v.length) return false;
  }
  return true;
}
const jsonObject: Check = (v, p) => object(v) ? undefined : p;
const textPart = shape({ type: oneOf('text'), text: string });
const imagePart = shape({ type: oneOf('image_url'), image_url: shape({ url: nonempty }, { detail: oneOf('auto', 'low', 'high') }) });
const refusalPart = shape({ type: oneOf('refusal'), refusal: string });
const content = (role: string): Check => (v, p, options) => {
  if (typeof v === 'string') return undefined;
  return list((part, path) => {
    if (!object(part)) return path;
    if (part.type === 'text') return textPart(part, path, options);
    if (role === 'user' && part.type === 'image_url') return imagePart(part, path, options);
    if (role === 'assistant' && part.type === 'refusal') return refusalPart(part, path, options);
    return `${path}.type`;
  }, 1)(v, p, options);
};
const toolCall = shape({ id: nonempty, type: oneOf('function'), function: shape({ name: nonempty, arguments: string }) });
const tool = shape({ type: oneOf('function'), function: shape({ name: nonempty }, { description: string, parameters: jsonObject, strict: nullable(bool) }) });
const message: Check = (v, p, options) => {
  if (!object(v)) return p;
  switch (v.role) {
    case 'system': case 'developer': case 'user':
      return shape({ role: oneOf(v.role), content: content(v.role) }, { name: nonempty })(v, p, options);
    case 'tool':
      return shape({ role: oneOf('tool'), content: content('tool'), tool_call_id: nonempty })(v, p, options);
    case 'assistant': {
      const error = shape({ role: oneOf('assistant') }, {
        content: nullable(content('assistant')), name: nonempty, tool_calls: list(toolCall, 1),
        refusal: nullable(string), reasoning_content: nullable(string), reasoning: nullable(string),
      })(v, p, options);
      if (error) return error;
      if (v.content == null && !v.tool_calls && typeof v.refusal !== 'string'
        && typeof v.reasoning_content !== 'string' && typeof v.reasoning !== 'string') return `${p}.content`;
      return undefined;
    }
    default: return `${p}.role`;
  }
};
const toolChoice: Check = (v, p, options) => typeof v === 'string' ? oneOf('auto', 'none', 'required')(v, p)
  : shape({ type: oneOf('function'), function: shape({ name: nonempty }) })(v, p, options);
const responseFormat: Check = (v, p, options) => object(v) && v.type === 'json_schema'
  ? shape({ type: oneOf('json_schema'), json_schema: shape({ name: nonempty, schema: jsonObject }, { description: string, strict: nullable(bool) }) })(v, p, options)
  : shape({ type: oneOf('text', 'json_object') })(v, p, options);
const requestRequired = { model: nonempty, messages: list(message, 1) };
const requestOptional: Record<string, Check> = {
  stream: bool, stream_options: nullable(shape({}, { include_usage: bool })),
  tools: list(tool), tool_choice: toolChoice, parallel_tool_calls: bool,
  max_tokens: nullable(positive), max_completion_tokens: nullable(positive),
  temperature: nullable(range(0, 2)), top_p: nullable(range(0, 1)),
  stop: nullable((v, p) => typeof v === 'string' ? string(v, p) : list(string, 1, 4)(v, p)),
  n: nullable(positive), seed: nullable(integer),
  frequency_penalty: nullable(range(-2, 2)), presence_penalty: nullable(range(-2, 2)),
  response_format: responseFormat, reasoning_effort: nullable(nonempty), service_tier: nullable(nonempty), user: string,
  metadata: nullable((v, p) => object(v) && Object.values(v).every(entry => typeof entry === 'string') ? undefined : p),
};

/**
 * Validate parsed JSON only, with no coercion, I/O or conversion. Known keys have
 * closed nested shapes by default; explicit preserve retains only JSON data.
 * Caller enforces HTTP bytes; this function bounds JSON depth/node count.
 * URL reachability, model capabilities, schema semantics and complete tool
 * history pairing belong to later capability/conversion nodes (P10 etc.).
 */
export function parseChatRequest(input: unknown, options: ChatValidationOptions = {}): ConversionResult<ChatRequest> {
  const invalid = (param: string): ConversionResult<ChatRequest> => ({ ok: false, error: {
    kind: 'invalid_request', code: 'invalid_chat_request', message: 'Invalid Chat Completions request structure.', param,
  } });
  if (!jsonBoundary(input) || !object(input)) return invalid('$');
  const error = shape(requestRequired, requestOptional)(input, '$', options);
  if (error) return invalid(error);
  // Every field has been checked above. This assertion does not bypass unknown keys.
  const typed = input as unknown as ChatRequest;
  for (let i = 0; i < typed.messages.length; i++) {
    const entry = typed.messages[i];
    if (entry?.role === 'assistant' && entry.tool_calls) {
      const ids = new Set<string>();
      for (let j = 0; j < entry.tool_calls.length; j++) {
        const call = entry.tool_calls[j];
        if (call && ids.has(call.id)) return invalid(`$.messages[${i}].tool_calls[${j}].id`);
        if (call) ids.add(call.id);
      }
    }
  }
  return { ok: true, value: typed };
}

const nonnegative: Check = (v, p) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? undefined : p;
const usage = shape({}, {
  prompt_tokens: nonnegative, completion_tokens: nonnegative, total_tokens: nonnegative,
  prompt_tokens_details: shape({}, { cached_tokens: nonnegative, audio_tokens: nonnegative }),
  completion_tokens_details: shape({}, { reasoning_tokens: nonnegative, audio_tokens: nonnegative, accepted_prediction_tokens: nonnegative, rejected_prediction_tokens: nonnegative }),
});
const annotationShape = shape({ type: oneOf('url_citation'), url_citation: shape({ start_index: nonnegative, end_index: nonnegative, title: string, url: nonempty }) });
const annotation: Check = (value, path, options) => {
  const bad = annotationShape(value, path, options);
  if (bad) return bad;
  const citation = (value as { url_citation: { start_index: number; end_index: number } }).url_citation;
  return citation.end_index < citation.start_index ? `${path}.url_citation.end_index` : undefined;
};
const outputMessage = shape({ role: oneOf('assistant'), content: nullable(string) }, {
  refusal: nullable(string), tool_calls: list(toolCall), reasoning_content: nullable(string), reasoning: nullable(string),
  annotations: list(annotation),
});
const delta = shape({}, {
  role: oneOf('assistant'), content: nullable(string), refusal: nullable(string),
  reasoning_content: nullable(string), reasoning: nullable(string),
  tool_calls: list(shape({ index: nonnegative }, {
    id: nonempty, type: oneOf('function'), function: shape({}, { name: string, arguments: string }),
  })),
});
const outputOptional = { usage: nullable(usage), system_fingerprint: nullable(string), service_tier: nullable(string) };
const responseShape = shape({
  id: nonempty, object: oneOf('chat.completion'), created: nonnegative, model: nonempty,
  choices: list(shape({ index: nonnegative, message: outputMessage, finish_reason: nonempty }, { logprobs: nullable(jsonObject) }), 1),
}, outputOptional);
const chunkShape = shape({
  id: nonempty, object: oneOf('chat.completion.chunk'), created: nonnegative, model: nonempty,
  choices: list(shape({ index: nonnegative, delta, finish_reason: nullable(nonempty) }, { logprobs: nullable(jsonObject) })),
}, outputOptional);

function parseOutput<T>(input: unknown, check: Check, options: ChatValidationOptions): ConversionResult<T> {
  const param = jsonBoundary(input) ? check(input, '$', options) : '$';
  if (param) return { ok: false, error: { kind: 'invalid_response', code: 'invalid_chat_response', message: 'Invalid Chat Completions response structure.', param } };
  return { ok: true, value: input as T };
}
/** Preserving extensions does not validate their meaning or authorize forwarding. */
export function parseChatResponse(input: unknown, options: ChatValidationOptions = {}): ConversionResult<ChatResponse> {
  return parseOutput(input, responseShape, options);
}
/** Parses decoded chunk JSON, not SSE frames or the separate [DONE] sentinel. */
export function parseChatStreamChunk(input: unknown, options: ChatValidationOptions = {}): ConversionResult<ChatChunk> {
  return parseOutput(input, chunkShape, options);
}
