import type { Protocol } from '@sub2api/apicompat/types/shared';
import type { ChannelCapabilities } from '@sub2api/apicompat/capabilities/check';
import { batch, prepare } from '../db';
import { ApiError } from '../http';
import { buildAuditStatement } from './audit';
import { getChannelById } from '../catalog/channels';
import { getModelById } from '../catalog/models';
import { getModelMapping, validateMappingCapabilities, modelMappingProjection as projection, decodeModelMappingRow as view, invalidMappingInput as invalid, mappingInputObject as object, mappingIdentifier as text, mappingInteger as integer, mappingKey as key } from '../catalog/model-mappings';
import type { ModelMappingKey, ModelMappingInput, ModelMappingView, ModelMappingRow as Row } from '../catalog/model-mappings';
export { getModelMapping, listModelMappings, validateMappingCapabilities } from '../catalog/model-mappings';
export type { ModelMappingKey, ModelMappingInput, ModelMappingView, ModelMappingQuery } from '../catalog/model-mappings';

export interface ModelMappingPatch { upstreamModel?: string; capabilities?: ChannelCapabilities }
export interface ModelMappingAuditContext { actorId: string; operationId: string; now: number }

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
