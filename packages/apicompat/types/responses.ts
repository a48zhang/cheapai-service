import type { ConversionResult, JsonObject, JsonValue } from './shared.js';

/** Native wire subset; provider extensions are data, never mapping permission. */
export interface ResponsesExtensions { readonly [key: string]: unknown }
export type ResponsesStatus = 'queued' | 'in_progress' | 'completed' | 'incomplete' | 'failed' | 'cancelled';
export type ResponsesItemStatus = 'in_progress' | 'completed' | 'incomplete';
export interface ResponsesInputText extends ResponsesExtensions { readonly type: 'input_text'; readonly text: string }
export interface ResponsesInputImage extends ResponsesExtensions {
  readonly type: 'input_image'; readonly image_url?: string | null; readonly file_id?: string | null;
  readonly detail?: 'auto' | 'low' | 'high' | 'original';
}
export interface ResponsesInputFile extends ResponsesExtensions {
  readonly type: 'input_file'; readonly file_id?: string; readonly file_url?: string;
  readonly file_data?: string; readonly filename?: string;
}
export interface ResponsesOutputText extends ResponsesExtensions {
  readonly type: 'output_text'; readonly text: string; readonly annotations: readonly JsonObject[];
  readonly logprobs?: readonly JsonObject[];
}
export interface ResponsesRefusal extends ResponsesExtensions { readonly type: 'refusal'; readonly refusal: string }
export type ResponsesInputContent = ResponsesInputText | ResponsesInputImage | ResponsesInputFile;
export type ResponsesOutputContent = ResponsesOutputText | ResponsesRefusal;
export interface ResponsesInputMessage extends ResponsesExtensions {
  readonly type?: 'message'; readonly role: 'system' | 'developer' | 'user' | 'assistant';
  readonly content: string | readonly (ResponsesInputContent | ResponsesOutputContent)[];
  readonly id?: string; readonly status?: ResponsesItemStatus;
}
export interface ResponsesOutputMessage extends ResponsesExtensions {
  readonly type: 'message'; readonly id: string; readonly role: 'assistant';
  readonly status: ResponsesItemStatus; readonly content: readonly ResponsesOutputContent[];
  readonly phase?: 'commentary' | 'final_answer' | null;
}
export interface ResponsesFunctionCall extends ResponsesExtensions {
  readonly type: 'function_call'; readonly call_id: string; readonly name: string;
  /** Kept as wire text; streaming fragments need not be independently valid JSON. */
  readonly arguments: string; readonly id?: string; readonly status?: ResponsesItemStatus;
}
export interface ResponsesFunctionCallOutput extends ResponsesExtensions {
  readonly type: 'function_call_output'; readonly call_id: string;
  readonly output: string | readonly ResponsesInputContent[]; readonly id?: string; readonly status?: ResponsesItemStatus;
}
export interface ResponsesReasoningItem extends ResponsesExtensions {
  readonly type: 'reasoning'; readonly id: string;
  readonly summary: readonly { readonly type: 'summary_text'; readonly text: string }[];
  readonly encrypted_content?: string | null; readonly status?: ResponsesItemStatus;
}
export interface ResponsesItemReference extends ResponsesExtensions { readonly type: 'item_reference'; readonly id: string }
export type ResponsesOutputItem = ResponsesOutputMessage | ResponsesFunctionCall | ResponsesReasoningItem;
export type ResponsesInputItem = ResponsesInputMessage | ResponsesFunctionCall | ResponsesFunctionCallOutput | ResponsesReasoningItem | ResponsesItemReference;
export interface ResponsesFunctionTool extends ResponsesExtensions {
  readonly type: 'function'; readonly name: string; readonly description?: string;
  readonly parameters?: JsonObject | null; readonly strict?: boolean | null;
}
export interface ResponsesRequest extends ResponsesExtensions {
  readonly model: string; readonly input?: string | readonly ResponsesInputItem[];
  readonly instructions?: string | null; readonly previous_response_id?: string | null;
  readonly stream?: boolean; readonly store?: boolean; readonly background?: boolean;
  readonly max_output_tokens?: number | null; readonly temperature?: number | null; readonly top_p?: number | null;
  readonly tools?: readonly ResponsesFunctionTool[];
  readonly tool_choice?: 'none' | 'auto' | 'required' | { readonly type: 'function'; readonly name: string };
  readonly parallel_tool_calls?: boolean; readonly metadata?: JsonObject | null;
  /** Structural objects only here: feature support and schema semantics belong to P10. */
  readonly reasoning?: JsonObject | null; readonly text?: JsonObject;
}
export interface ResponsesUsage extends ResponsesExtensions {
  readonly input_tokens: number; readonly output_tokens: number; readonly total_tokens: number;
  readonly input_tokens_details?: { readonly cached_tokens: number; readonly cache_write_tokens?: number };
  readonly output_tokens_details?: { readonly reasoning_tokens: number };
}
export type ResponsesServiceTier = 'auto' | 'default' | 'flex' | 'scale' | 'priority' | 'fast' | 'ultrafast';
export interface ResponsesTextConfig {
  readonly format?: { readonly type: 'text' | 'json_object' }
    | { readonly type: 'json_schema'; readonly name: string; readonly schema: JsonObject; readonly description?: string; readonly strict?: boolean | null };
  readonly verbosity?: 'low' | 'medium' | 'high' | null;
}
export interface ResponsesReasoningConfig {
  readonly effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | null;
  readonly summary?: 'auto' | 'concise' | 'detailed' | null;
  readonly generate_summary?: 'auto' | 'concise' | 'detailed' | null;
  readonly context?: 'auto';
  readonly mode?: 'standard';
}
/** Standard response echoes supported by P16, verified 2026-09-06 against
 * https://developers.openai.com/api/reference/typescript/resources/responses/methods/create
 * They are not additions to the accepted request capability surface.
 */
export interface ResponsesResponse extends ResponsesExtensions {
  readonly id: string; readonly object: 'response'; readonly created_at: number; readonly model: string;
  readonly status: ResponsesStatus; readonly output: readonly ResponsesOutputItem[];
  readonly usage?: ResponsesUsage | null;
  readonly error?: { readonly code: string; readonly message: string } | null;
  readonly incomplete_details?: { readonly reason: string } | null;
  readonly previous_response_id?: string | null;
  readonly completed_at?: number | null;
  readonly background?: boolean | null;
  readonly store?: boolean | null;
  readonly instructions?: string | readonly ResponsesInputItem[] | null;
  readonly max_output_tokens?: number | null;
  readonly max_tool_calls?: number | null;
  readonly parallel_tool_calls?: boolean;
  readonly reasoning?: ResponsesReasoningConfig | null;
  readonly service_tier?: ResponsesServiceTier | null;
  readonly temperature?: number | null;
  readonly top_p?: number | null;
  readonly text?: ResponsesTextConfig;
  readonly tool_choice?: ResponsesRequest['tool_choice'];
  readonly tools?: readonly ResponsesFunctionTool[];
  readonly top_logprobs?: number | null;
  readonly truncation?: 'auto' | 'disabled' | null;
  readonly user?: string | null;
  readonly metadata?: Readonly<Record<string, string>> | null;
  readonly conversation?: { readonly id: string } | null;
  readonly prompt_cache_key?: string | null;
  readonly prompt_cache_retention?: 'in_memory' | '24h' | null;
  readonly prompt_cache_options?: { readonly mode: 'implicit' | 'explicit'; readonly ttl: '30m'; readonly comparison_response_id?: string };
  readonly safety_identifier?: string | null;
}
type EventBase = { readonly sequence_number: number };
type IndexedEvent = EventBase & { readonly item_id: string; readonly output_index: number };
export type ResponsesStreamEvent =
  | (EventBase & { readonly type: 'response.created' | 'response.in_progress' | 'response.completed' | 'response.incomplete' | 'response.failed' | 'response.queued'; readonly response: ResponsesResponse })
  | (EventBase & { readonly type: 'response.output_item.added' | 'response.output_item.done'; readonly output_index: number; readonly item: ResponsesOutputItem })
  | (IndexedEvent & { readonly type: 'response.content_part.added' | 'response.content_part.done'; readonly content_index: number; readonly part: ResponsesOutputContent })
  | (IndexedEvent & { readonly type: 'response.output_text.delta' | 'response.refusal.delta'; readonly content_index: number; readonly delta: string })
  | (IndexedEvent & { readonly type: 'response.output_text.done'; readonly content_index: number; readonly text: string })
  | (IndexedEvent & { readonly type: 'response.refusal.done'; readonly content_index: number; readonly refusal: string })
  | (IndexedEvent & { readonly type: 'response.function_call_arguments.delta'; readonly delta: string })
  | (IndexedEvent & { readonly type: 'response.function_call_arguments.done'; readonly arguments: string; readonly name?: string })
  | (IndexedEvent & { readonly type: 'response.reasoning_summary_part.added' | 'response.reasoning_summary_part.done'; readonly summary_index: number; readonly part: { readonly type: 'summary_text'; readonly text: string } })
  | (IndexedEvent & { readonly type: 'response.reasoning_summary_text.delta'; readonly summary_index: number; readonly delta: string })
  | (IndexedEvent & { readonly type: 'response.reasoning_summary_text.done'; readonly summary_index: number; readonly text: string })
  | (EventBase & { readonly type: 'error'; readonly code: string | null; readonly message: string; readonly param: string | null });
/** Unknown SSE events stay separate so consumers must choose ignore/reject/preserve. */
export interface ResponsesUnknownEvent { readonly type: string; readonly raw: JsonObject }

export interface ResponsesValidationOptions {
  /** Default reject. Preserve retains unknown JSON fields verbatim; it is NOT permission to forward them. */
  readonly unknownFields?: 'reject' | 'preserve';
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const itemStatus = (v: unknown) => v === 'in_progress' || v === 'completed' || v === 'incomplete';
// Bound recursion and reject cycles/non-JSON values even in preserved extensions.
function json(v: unknown, depth = 0, ancestors = new Set<object>()): v is JsonValue {
  if (depth > 64) return false;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v !== 'object' || ancestors.has(v)) return false;
  if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return false;
  ancestors.add(v);
  const valid = (Array.isArray(v) ? Array.from(v) : Object.values(v)).every(x => json(x, depth + 1, ancestors));
  ancestors.delete(v);
  return valid;
}

/** Validates ingress structure only; no I/O, model routing, history lookup or conversion. */
export function validateResponsesRequest(value: unknown, options: ResponsesValidationOptions = {}): ConversionResult<ResponsesRequest> {
  const invalid = (param: string, unsupported = false): ConversionResult<ResponsesRequest> => ({ ok: false, error: {
    kind: unsupported ? 'unsupported_feature' : 'invalid_request',
    code: unsupported ? 'unsupported_responses_field' : 'invalid_responses_request',
    message: unsupported ? 'Unsupported Responses field or item type.' : 'Invalid Responses request structure.', param,
  } });
  if (!object(value) || !json(value)) return invalid('$');
  // Each helper returns the first failing path, keeping payloads out of diagnostics.
  let unsupported = false;
  const keys = (v: Record<string, unknown>, allowed: string[], path: string): string | undefined => {
    if (options.unknownFields === 'preserve') return undefined;
    const key = Object.keys(v).find(k => !allowed.includes(k));
    if (key !== undefined) { unsupported = true; return path ? `${path}.${key}` : key; }
    return undefined;
  };
  const optional = (v: Record<string, unknown>, name: string, test: (x: unknown) => boolean, path: string): string | undefined =>
    name in v && !test(v[name]) ? (path ? `${path}.${name}` : name) : undefined;
  const contents = (v: unknown, path: string, outputAllowed: boolean): string | undefined => {
    if (!Array.isArray(v) || v.length === 0) return path;
    for (const [i, part] of v.entries()) {
      const p = `${path}[${i}]`;
      if (!object(part)) return p;
      let extra: string | undefined;
      switch (part.type) {
        case 'input_text':
          if (typeof part.text !== 'string') return `${p}.text`;
          extra = keys(part, ['type', 'text'], p); break;
        case 'input_image': {
          const sources = [part.image_url, part.file_id].filter(x => x !== undefined && x !== null);
          if (sources.length !== 1 || !sources.every(nonempty)) return p;
          if ('detail' in part && (typeof part.detail !== 'string' || !['auto', 'low', 'high', 'original'].includes(part.detail))) return `${p}.detail`;
          extra = keys(part, ['type', 'image_url', 'file_id', 'detail'], p); break;
        }
        case 'input_file': {
          const sources = [part.file_id, part.file_url, part.file_data].filter(x => x !== undefined);
          if (sources.length !== 1 || !sources.every(nonempty)) return p;
          if ('filename' in part && !nonempty(part.filename)) return `${p}.filename`;
          extra = keys(part, ['type', 'file_id', 'file_url', 'file_data', 'filename'], p); break;
        }
        case 'output_text':
          if (!outputAllowed || typeof part.text !== 'string' || !Array.isArray(part.annotations) || !part.annotations.every(object)) return p;
          if ('logprobs' in part && (!Array.isArray(part.logprobs) || !part.logprobs.every(object))) return `${p}.logprobs`;
          extra = keys(part, ['type', 'text', 'annotations', 'logprobs'], p); break;
        case 'refusal':
          if (!outputAllowed || typeof part.refusal !== 'string') return p;
          extra = keys(part, ['type', 'refusal'], p); break;
        default: unsupported = true; return `${p}.type`;
      }
      if (extra) return extra;
    }
    return undefined;
  };
  const item = (v: unknown, p: string): string | undefined => {
    if (!object(v)) return p;
    const id = optional(v, 'id', nonempty, p) ?? optional(v, 'status', itemStatus, p);
    if (id) return id;
    switch (v.type) {
      case undefined:
      case 'message': {
        if (typeof v.role !== 'string' || !['system', 'developer', 'user', 'assistant'].includes(v.role)) return `${p}.role`;
        if (typeof v.content !== 'string') {
          const bad = contents(v.content, `${p}.content`, v.role === 'assistant');
          if (bad) return bad;
        }
        return keys(v, ['type', 'role', 'content', 'id', 'status'], p);
      }
      case 'function_call':
        if (!nonempty(v.call_id)) return `${p}.call_id`;
        if (!nonempty(v.name)) return `${p}.name`;
        if (typeof v.arguments !== 'string') return `${p}.arguments`;
        return keys(v, ['type', 'call_id', 'name', 'arguments', 'id', 'status'], p);
      case 'function_call_output': {
        if (!nonempty(v.call_id)) return `${p}.call_id`;
        if (typeof v.output !== 'string') { const bad = contents(v.output, `${p}.output`, false); if (bad) return bad; }
        return keys(v, ['type', 'call_id', 'output', 'id', 'status'], p);
      }
      case 'item_reference':
        return !nonempty(v.id) ? `${p}.id` : keys(v, ['type', 'id'], p);
      case 'reasoning':
        if (!nonempty(v.id) || !Array.isArray(v.summary)) return p;
        for (const [i, summary] of v.summary.entries()) {
          const s = `${p}.summary[${i}]`;
          if (!object(summary) || summary.type !== 'summary_text' || typeof summary.text !== 'string') return s;
          const bad = keys(summary, ['type', 'text'], s); if (bad) return bad;
        }
        return optional(v, 'encrypted_content', x => x === null || typeof x === 'string', p)
          ?? keys(v, ['type', 'id', 'summary', 'encrypted_content', 'status'], p);
      default: unsupported = true; return `${p}.type`;
    }
  };
  if (!nonempty(value.model)) return invalid('model');
  if ('input' in value && typeof value.input !== 'string') {
    if (!Array.isArray(value.input)) return invalid('input');
    for (const [i, entry] of value.input.entries()) { const bad = item(entry, `input[${i}]`); if (bad) return invalid(bad, unsupported); }
  }
  for (const name of ['instructions', 'previous_response_id']) {
    const bad = optional(value, name, x => x === null || (name === 'instructions' ? typeof x === 'string' : nonempty(x)), '');
    if (bad) return invalid(bad);
  }
  if (!('input' in value) && !nonempty(value.previous_response_id)) return invalid('input');
  for (const name of ['stream', 'store', 'background', 'parallel_tool_calls']) {
    const bad = optional(value, name, x => typeof x === 'boolean', ''); if (bad) return invalid(bad);
  }
  for (const [name, max] of [['temperature', 2], ['top_p', 1], ['max_output_tokens', Number.MAX_SAFE_INTEGER]] as const) {
    const bad = optional(value, name, x => x === null || (typeof x === 'number' && x >= 0 && x <= max && (name !== 'max_output_tokens' || (Number.isSafeInteger(x) && x > 0))), '');
    if (bad) return invalid(bad);
  }
  for (const name of ['metadata', 'reasoning', 'text']) {
    const bad = optional(value, name, x => object(x) || (name !== 'text' && x === null), ''); if (bad) return invalid(bad);
  }
  if ('tools' in value) {
    if (!Array.isArray(value.tools)) return invalid('tools');
    for (const [i, tool] of value.tools.entries()) {
      const p = `tools[${i}]`;
      if (!object(tool)) return invalid(p);
      if (tool.type !== 'function') return invalid(`${p}.type`, true);
      if (!nonempty(tool.name)) return invalid(`${p}.name`);
      const bad = optional(tool, 'description', x => typeof x === 'string', p)
        ?? optional(tool, 'parameters', x => x === null || object(x), p)
        ?? optional(tool, 'strict', x => x === null || typeof x === 'boolean', p)
        ?? keys(tool, ['type', 'name', 'description', 'parameters', 'strict'], p);
      if (bad) return invalid(bad, unsupported);
    }
  }
  if ('tool_choice' in value) {
    const choice = value.tool_choice;
    if (object(choice)) {
      if (choice.type !== 'function' || !nonempty(choice.name)) return invalid('tool_choice');
      const bad = keys(choice, ['type', 'name'], 'tool_choice'); if (bad) return invalid(bad, unsupported);
    } else if (choice !== 'auto' && choice !== 'none' && choice !== 'required') return invalid('tool_choice');
  }
  const extra = keys(value, ['model', 'input', 'instructions', 'previous_response_id', 'stream', 'store', 'background', 'max_output_tokens', 'temperature', 'top_p', 'tools', 'tool_choice', 'parallel_tool_calls', 'metadata', 'reasoning', 'text'], '');
  if (extra) return invalid(extra, true);
  // Every declared ingress property has been checked above; keep native field order/data.
  return { ok: true, value: value as ResponsesRequest };
}

/** Parser naming shared with the other ingress protocols; validation preserves wire data. */
export const parseResponsesRequest = validateResponsesRequest;
