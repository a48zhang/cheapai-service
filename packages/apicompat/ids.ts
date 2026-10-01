import type { ResponseContext } from './types/adapter.js';
import type { ContentIdentity, ConversionResult, ProtocolError, ResponseIdentity } from './types/shared.js';

export type ResponseIdKind = 'item' | 'tool_call';

export interface ResponseIdOptions {
  /**
   * Caller-generated, response-unique opaque seed (1–48 ASCII letters/digits/_/-).
   * This module has no RNG. Reusing a seed reproduces IDs, not global uniqueness.
   * Never use a client request ID as this seed or use these IDs as billing keys.
   */
  readonly seed: string;
  /** Kept separately as upstream evidence; never substituted for responseId. */
  readonly upstreamResponseId?: string;
  /** Maximum item + tool mappings retained by this response; default 4096. */
  readonly maxIds?: number;
}

export interface ResponseIds {
  readonly identity: ResponseIdentity;
  /**
   * ResponseContext-compatible facade. Throws ResponseIdError on invalid input or
   * exhaustion; adapters must turn it into their normal failed conversion/step.
   * Prefer allocate() where an explicit ConversionResult is convenient.
   */
  readonly idFor: ResponseContext['idFor'];
  readonly allocate: (kind: ResponseIdKind, key: string) => ConversionResult<string>;
  /**
   * Call when the upstream tool ID becomes known, before publishing a generated
   * ID for this key. Existing mappings are never rewritten. Collisions and late
   * conflicting originals fail explicitly, without partially changing state.
   */
  readonly preserveToolCallId: (key: string, originalId: string) => ConversionResult<string>;
}

/** Static safe diagnostics; never contains the seed, original ID or caller key. */
export class ResponseIdError extends Error {
  readonly protocolError: ProtocolError;
  constructor(error: ProtocolError) {
    super(error.message);
    this.name = 'ResponseIdError';
    this.protocolError = error;
  }
}

function failure<T>(code: string, param: string): ConversionResult<T> {
  return { ok: false, error: {
    kind: 'invalid_response', code, message: 'Response identifier allocation failed.', param,
  } };
}

/** Conservative common wire subset; IDs are opaque, never trimmed or truncated. */
export function isRepresentableWireId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[^A-Za-z0-9_-]/u.test(value);
}

function validKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** Missing content index and index zero are distinct; only safe integers work. */
export function contentIdKey(identity: Pick<ContentIdentity, 'outputIndex' | 'contentIndex'>): ConversionResult<string> {
  if (!Number.isSafeInteger(identity.outputIndex) || identity.outputIndex < 0) return failure('invalid_id_index', 'outputIndex');
  if (identity.contentIndex !== undefined && (!Number.isSafeInteger(identity.contentIndex) || identity.contentIndex < 0)) {
    return failure('invalid_id_index', 'contentIndex');
  }
  return { ok: true, value: `output:${identity.outputIndex}/content:${identity.contentIndex ?? 'absent'}` };
}

/**
 * Pure deterministic state local to one response. Allocation order determines
 * generated suffixes; repeating the same seed and operation sequence reproduces
 * IDs. Keys must describe identity/index, not display names or tool names.
 */
export function createResponseIds(options: ResponseIdOptions): ConversionResult<ResponseIds> {
  if (!isRepresentableWireId(options.seed) || options.seed.length > 48) return failure('invalid_id_seed', 'seed');
  if (options.upstreamResponseId !== undefined && !isRepresentableWireId(options.upstreamResponseId)) {
    return failure('invalid_upstream_response_id', 'upstreamResponseId');
  }
  const maxIds = options.maxIds ?? 4096;
  if (!Number.isSafeInteger(maxIds) || maxIds < 1 || maxIds > 65_536) return failure('invalid_id_limit', 'maxIds');
  // Snapshot caller options; mutations after creation cannot alter future IDs.
  const seed = options.seed;
  const identity: ResponseIdentity = Object.freeze(options.upstreamResponseId === undefined
    ? { responseId: `resp_${seed}` }
    : { responseId: `resp_${seed}`, upstreamResponseId: options.upstreamResponseId });
  const mappings: Record<ResponseIdKind, Map<string, string>> = { item: new Map(), tool_call: new Map() };
  const used = new Set<string>([identity.responseId]);
  const sequence: Record<ResponseIdKind, number> = { item: 0, tool_call: 0 };
  let count = 0;

  const allocate = (kind: ResponseIdKind, key: string): ConversionResult<string> => {
    if (kind !== 'item' && kind !== 'tool_call') return failure('invalid_id_kind', 'kind');
    if (!validKey(key)) return failure('invalid_id_key', 'key');
    const existing = mappings[kind].get(key);
    if (existing !== undefined) return { ok: true, value: existing };
    if (count >= maxIds) return failure('id_limit_exceeded', 'maxIds');
    const prefix = kind === 'item' ? 'item' : 'call';
    // Preserved originals may occupy generated names. Skip those deterministically;
    // at most maxIds occupied names exist, so this loop is bounded by retained state.
    let next = sequence[kind];
    let id: string;
    do { id = `${prefix}_${seed}_${next++}`; } while (used.has(id));
    sequence[kind] = next;
    mappings[kind].set(key, id);
    used.add(id);
    count++;
    return { ok: true, value: id };
  };

  const preserveToolCallId = (key: string, originalId: string): ConversionResult<string> => {
    if (!validKey(key)) return failure('invalid_id_key', 'key');
    if (!isRepresentableWireId(originalId)) return failure('unrepresentable_tool_call_id', 'toolCallId');
    const existing = mappings.tool_call.get(key);
    if (existing !== undefined) return existing === originalId
      ? { ok: true, value: existing } : failure('id_mapping_conflict', 'toolCallId');
    if (used.has(originalId)) return failure('id_collision', 'toolCallId');
    if (count >= maxIds) return failure('id_limit_exceeded', 'maxIds');
    mappings.tool_call.set(key, originalId);
    used.add(originalId);
    count++;
    return { ok: true, value: originalId };
  };

  const idFor: ResponseContext['idFor'] = (kind, key) => {
    const result = allocate(kind, key);
    if (!result.ok) throw new ResponseIdError(result.error);
    return result.value;
  };
  return { ok: true, value: Object.freeze({ identity, allocate, preserveToolCallId, idFor }) };
}
