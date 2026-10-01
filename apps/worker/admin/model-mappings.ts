import type { Protocol } from '@sub2api/apicompat/types/shared';
import type { CapabilityFeature, ChannelCapabilities, ExtensionScope } from '@sub2api/apicompat/capabilities/check';
import { batch, prepare } from '../db';
import { ApiError } from '../http';
import { buildAuditStatement } from './audit';
import { getChannelById } from './channel-repository';
import { getModelById } from './model-repository';

export interface ModelMappingKey { channelId: string; publicModelId: string; protocol: Protocol }
export interface ModelMappingInput extends ModelMappingKey { upstreamModel: string; capabilities: ChannelCapabilities }
export interface ModelMappingView extends ModelMappingInput { configVersion: number }
export interface ModelMappingPatch { upstreamModel?: string; capabilities?: ChannelCapabilities }
export interface ModelMappingAuditContext { actorId: string; operationId: string; now: number }
export interface ModelMappingQuery { publicModelId: string; protocol?: Protocol; activeOnly?: boolean }

// Exhaustive against P10's type: new semantic features require an explicit review.
const features: Record<CapabilityFeature, true> = {
  streaming: true, stream_usage: true, tools: true, tool_choice: true, parallel_tools: true, parallel_tool_control: true, strict_tools: true,
  image_url: true, image_base64: true, image_file_id: true, image_detail: true, tool_result_images: true, tool_result_error: true, refusal_history: true,
  json_object: true, json_schema: true, reasoning_effort: true, reasoning_summary: true, reasoning_history: true, thinking_budget: true,
  thinking_adaptive: true, thinking_control: true, signed_thinking: true, redacted_thinking: true, encrypted_reasoning: true, cache_control: true,
  response_history: true, item_references: true, file_inputs: true, file_references: true, temperature: true, top_p: true, top_k: true,
  stop_sequences: true, seed: true, penalties: true, multiple_choices: true, service_tier: true, metadata: true, message_names: true,
  store: true, verbosity: true, citations: true, logprobs: true, system_developer_priority: true,
};
const scopes: Record<ExtensionScope, true> = {
  request: true, message: true, content: true, image_source: true, tool: true, tool_function: true, tool_call: true,
  tool_choice: true, response_format: true, reasoning: true, text: true, thinking: true, cache_control: true, stream_options: true, metadata: true, output_config: true,
};
function invalid(): never { throw new ApiError('invalid_request'); }
function object(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
      || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowed.includes(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor) || descriptor.value === undefined) invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function text(input: unknown): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > 128 || input.trim() !== input || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(input)) invalid();
  return input;
}
function protocol(input: unknown): Protocol {
  if (input !== 'chat' && input !== 'responses' && input !== 'messages') invalid();
  return input;
}
function integer(input: unknown, minimum = 1): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < minimum) invalid();
  return input;
}
function key(input: ModelMappingKey): ModelMappingKey {
  const fields = object(input, ['channelId', 'publicModelId', 'protocol']);
  return { channelId: text(fields.channelId), publicModelId: text(fields.publicModelId), protocol: protocol(fields.protocol) };
}
function strings(input: unknown, max: number): string[] {
  if (!Array.isArray(input) || input.length > max || !Array.from(input).every((value) => typeof value === 'string' && value.length > 0 && value.length <= 64 && value.trim() === value)
      || new Set(input).size !== input.length) invalid();
  return [...input];
}

/** Validates declared upstream capabilities only. It does not assert that any
 * cross-protocol request/JSON/SSE adapter is implemented or supplier-tested.
 * Missing features remain unsupported, exactly as in P10.
 */
export function validateMappingCapabilities(input: unknown, expectedProtocol: Protocol): ChannelCapabilities {
  const fields = object(input, ['protocol', 'features', 'maxOutputTokens', 'reasoningEfforts', 'cacheTtls', 'nativeExtensions']);
  if (protocol(fields.protocol) !== expectedProtocol) invalid();
  const enabled = strings(fields.features, Object.keys(features).length);
  if (enabled.some((feature) => !Object.hasOwn(features, feature))) invalid();
  const requires = (child: string, parent: string) => { if (enabled.includes(child) && !enabled.includes(parent)) invalid(); };
  requires('stream_usage', 'streaming');
  for (const feature of ['tool_choice', 'parallel_tools', 'parallel_tool_control', 'strict_tools', 'tool_result_images', 'tool_result_error']) requires(feature, 'tools');
  const result: { protocol: Protocol; features: CapabilityFeature[]; maxOutputTokens?: number;
    reasoningEfforts?: string[]; cacheTtls?: ('5m' | '1h')[]; nativeExtensions?: { scope: ExtensionScope; name: string }[] } = { protocol: expectedProtocol, features: enabled.sort() as CapabilityFeature[] };
  if (Object.hasOwn(fields, 'maxOutputTokens')) result.maxOutputTokens = integer(fields.maxOutputTokens);
  if (Object.hasOwn(fields, 'reasoningEfforts')) {
    result.reasoningEfforts = strings(fields.reasoningEfforts, 16).sort();
    if (!enabled.includes('reasoning_effort') || result.reasoningEfforts.some((effort) => !/^[a-z][a-z0-9_-]*$/.test(effort))) invalid();
  }
  if (Object.hasOwn(fields, 'cacheTtls')) {
    const ttls = strings(fields.cacheTtls, 2);
    if (!enabled.includes('cache_control') || ttls.some((ttl) => ttl !== '5m' && ttl !== '1h')) invalid();
    result.cacheTtls = ttls.sort() as ('5m' | '1h')[];
  }
  if (Object.hasOwn(fields, 'nativeExtensions')) {
    if (!Array.isArray(fields.nativeExtensions) || fields.nativeExtensions.length > 32) invalid();
    const seen = new Set<string>();
    result.nativeExtensions = fields.nativeExtensions.map((entry: unknown) => {
      const extension = object(entry, ['scope', 'name']);
      if (typeof extension.scope !== 'string' || !Object.hasOwn(scopes, extension.scope)
          || (extension.scope === 'output_config' && expectedProtocol !== 'messages')
          || typeof extension.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(extension.name)
          || ['authorization', 'headers', 'api_key', 'base_url', 'url', 'host', 'constructor', 'prototype'].includes(extension.name.toLowerCase())) invalid();
      const identity = `${extension.scope}:${extension.name}`;
      if (seen.has(identity)) invalid();
      seen.add(identity);
      return { scope: extension.scope as ExtensionScope, name: extension.name };
    });
  }
  return JSON.parse(JSON.stringify(result)) as ChannelCapabilities; // Detached JSON-only value, no caller aliases.
}

interface Row { channel_id: string; public_model_id: string; protocol: Protocol; upstream_model: string; capabilities_json: string; config_version: number }
const projection = 'channel_id,public_model_id,protocol,upstream_model,capabilities_json,config_version';
function view(row: Row): ModelMappingView {
  try {
    if (typeof row.capabilities_json !== 'string' || row.capabilities_json.length > 16384) invalid();
    return { channelId: text(row.channel_id), publicModelId: text(row.public_model_id), protocol: protocol(row.protocol), upstreamModel: text(row.upstream_model),
      capabilities: validateMappingCapabilities(JSON.parse(row.capabilities_json), row.protocol), configVersion: integer(row.config_version) };
  } catch { throw new ApiError('service_unavailable'); }
}
export async function getModelMapping(database: D1Database, input: ModelMappingKey): Promise<ModelMappingView | null> {
  const identity = key(input);
  const row = await prepare<Row>(database, `SELECT ${projection} FROM channel_models WHERE channel_id=? AND public_model_id=? AND protocol=?`, [identity.channelId, identity.publicModelId, identity.protocol]).first();
  return row ? view(row) : null;
}

/** Configuration candidates only: activeOnly filters parent status, not group
 * permissions, billing admission or adapter implementation availability.
 */
export async function listModelMappings(database: D1Database, input: ModelMappingQuery): Promise<ModelMappingView[]> {
  const fields = object(input, ['publicModelId', 'protocol', 'activeOnly']);
  const model = text(fields.publicModelId);
  const selectedProtocol = Object.hasOwn(fields, 'protocol') ? protocol(fields.protocol) : null;
  if (Object.hasOwn(fields, 'activeOnly') && typeof fields.activeOnly !== 'boolean') invalid();
  const rows = await prepare<Row>(database, `SELECT ${projection.split(',').map((column) => `cm.${column}`).join(',')}
    FROM channel_models cm JOIN channels c ON c.id=cm.channel_id JOIN models m ON m.public_model_id=cm.public_model_id
    WHERE cm.public_model_id=? AND (? IS NULL OR cm.protocol=?) AND (?=0 OR (c.status='active' AND m.status='active'))
    ORDER BY cm.channel_id,cm.protocol`, [model, selectedProtocol, selectedProtocol, fields.activeOnly === true ? 1 : 0]).all();
  return rows.rows.map(view);
}
async function parents(database: D1Database, identity: ModelMappingKey): Promise<void> {
  const [channel, model] = await Promise.all([getChannelById(database, identity.channelId), getModelById(database, identity.publicModelId)]);
  if (!channel || !model) throw new ApiError('not_found');
}
async function audit(database: D1Database, identity: ModelMappingKey, version: number, context: ModelMappingAuditContext, action: string) {
  const values = object(context, ['actorId', 'operationId', 'now']);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([identity.channelId, identity.publicModelId, identity.protocol]))));
  return buildAuditStatement(database, { actor_id: text(values.actorId), operation_id: text(values.operationId), created_at: integer(values.now, 0),
    action, target_type: 'channel_model', target_id: Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join(''),
    changes: { channel_id: identity.channelId, public_model_id: identity.publicModelId, protocol: identity.protocol,
      config_version: { before: version === 1 ? null : version - 1, after: version } } });
}
function guard(database: D1Database) { return prepare(database, "SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('{}','model_mapping_conflict') END AS matched"); }
function writeError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  for (let cause = error, depth = 0; cause instanceof Error && depth < 4; cause = cause.cause, depth++) {
    if (cause.message.includes('model_mapping_conflict')) throw new ApiError('conflict');
  }
  throw new ApiError('service_unavailable');
}
export async function createModelMapping(database: D1Database, input: ModelMappingInput, context: ModelMappingAuditContext): Promise<ModelMappingView> {
  const fields = object(input, ['channelId', 'publicModelId', 'protocol', 'upstreamModel', 'capabilities']);
  const identity = key({ channelId: fields.channelId as string, publicModelId: fields.publicModelId as string, protocol: fields.protocol as Protocol });
  const upstreamModel = text(fields.upstreamModel);
  const capabilities = validateMappingCapabilities(fields.capabilities, identity.protocol);
  await parents(database, identity);
  const statement = await audit(database, identity, 1, context, 'channel_model.create');
  try {
    const result = await batch(database, [
      prepare<Row>(database, `INSERT INTO channel_models (${projection}) VALUES (?,?,?,?,?,1)
        ON CONFLICT(channel_id,public_model_id,protocol) DO NOTHING RETURNING ${projection}`,
      [identity.channelId, identity.publicModelId, identity.protocol, upstreamModel, JSON.stringify(capabilities)]), guard(database), statement,
    ] as const);
    if (!result[0].rows[0]) throw new ApiError('service_unavailable');
    return view(result[0].rows[0]);
  } catch (error) { return writeError(error); }
}
export async function updateModelMapping(database: D1Database, input: ModelMappingKey, expectedVersion: number, patch: ModelMappingPatch, context: ModelMappingAuditContext): Promise<ModelMappingView> {
  const identity = key(input);
  integer(expectedVersion);
  if (expectedVersion >= Number.MAX_SAFE_INTEGER) throw new ApiError('conflict');
  const fields = object(patch, ['upstreamModel', 'capabilities']);
  if (Object.keys(fields).length === 0) invalid();
  const current = await getModelMapping(database, identity);
  if (!current) throw new ApiError('not_found');
  if (current.configVersion !== expectedVersion) throw new ApiError('conflict');
  const upstreamModel = Object.hasOwn(fields, 'upstreamModel') ? text(fields.upstreamModel) : current.upstreamModel;
  const capabilities = Object.hasOwn(fields, 'capabilities') ? validateMappingCapabilities(fields.capabilities, identity.protocol) : current.capabilities;
  await parents(database, identity);
  const statement = await audit(database, identity, expectedVersion + 1, context, 'channel_model.update');
  try {
    const result = await batch(database, [prepare<Row>(database, `UPDATE channel_models SET upstream_model=?,capabilities_json=?,config_version=config_version+1
      WHERE channel_id=? AND public_model_id=? AND protocol=? AND config_version=? RETURNING ${projection}`,
    [upstreamModel, JSON.stringify(capabilities), identity.channelId, identity.publicModelId, identity.protocol, expectedVersion]), guard(database), statement] as const);
    if (!result[0].rows[0]) throw new ApiError('service_unavailable');
    return view(result[0].rows[0]);
  } catch (error) { return writeError(error); }
}
