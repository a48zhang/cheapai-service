import type { Protocol } from '@sub2api/apicompat/types/shared';
import type { ChannelCapabilities } from '@sub2api/apicompat/capabilities/check';
import { prepare } from '../db';
import { ApiError } from '../http';

export interface ModelMappingKey { channelId: string; publicModelId: string; protocol: Protocol }
export interface ModelMappingInput extends ModelMappingKey { upstreamModel: string; capabilities: ChannelCapabilities }
export interface ModelMappingView extends ModelMappingInput { configVersion: number }
export interface ModelMappingQuery { publicModelId: string; protocol?: Protocol; activeOnly?: boolean }

function invalid(): never { throw new ApiError('invalid_request'); }
function object(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of fields) {
    if (Object.hasOwn(input, key)) result[key] = (input as Record<string, unknown>)[key];
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
function strings(input: unknown): string[] {
  if (!Array.isArray(input) || !input.every(value => typeof value === 'string')) invalid();
  return [...new Set(input)].sort();
}

/** Capability declarations are descriptive metadata. Only the protocol and
 * actual output budget affect routing; extension permissions are obsolete. */
export function validateMappingCapabilities(input: unknown, expectedProtocol: Protocol): ChannelCapabilities {
  const fields = object(input, ['protocol', 'features', 'maxOutputTokens', 'reasoningEfforts', 'cacheTtls']);
  if (protocol(fields.protocol) !== expectedProtocol) invalid();
  const result: Record<string, unknown> = {
    protocol: expectedProtocol,
    features: fields.features === undefined ? [] : strings(fields.features),
  };
  if (fields.maxOutputTokens !== undefined) result.maxOutputTokens = integer(fields.maxOutputTokens);
  if (fields.reasoningEfforts !== undefined) result.reasoningEfforts = strings(fields.reasoningEfforts);
  if (fields.cacheTtls !== undefined) result.cacheTtls = strings(fields.cacheTtls);
  return result as unknown as ChannelCapabilities;
}

interface Row { channel_id: string; public_model_id: string; protocol: Protocol; upstream_model: string; capabilities_json: string; config_version: number }
const projection = 'channel_id,public_model_id,protocol,upstream_model,capabilities_json,config_version';
function view(row: Row): ModelMappingView {
  try {
    if (typeof row.capabilities_json !== 'string' || row.capabilities_json.length > 16384) invalid();
    return { channelId: text(row.channel_id), publicModelId: text(row.public_model_id), protocol: protocol(row.protocol), upstreamModel: text(row.upstream_model),
      capabilities: validateMappingCapabilities(JSON.parse(row.capabilities_json), row.protocol), configVersion: integer(row.config_version) };
  } catch (error) { throw new ApiError('service_unavailable', { cause: error }); }
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

export type { Row as ModelMappingRow };
export { projection as modelMappingProjection, view as decodeModelMappingRow, invalid as invalidMappingInput, object as mappingInputObject, text as mappingIdentifier, integer as mappingInteger, key as mappingKey };
