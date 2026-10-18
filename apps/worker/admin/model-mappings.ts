import type { Protocol } from '@sub2api/apicompat/types/shared';
import { batch, prepare } from '../db';
import { ApiError } from '../http';
import { buildAuditStatement } from './audit';
import { getChannelById } from '../catalog/channels';
import { getModelById } from '../catalog/models';
import { getModelMapping, modelMappingProjection as projection, decodeModelMappingRow as view, invalidMappingInput as invalid, mappingInputObject as object, mappingIdentifier as text, mappingUpstreamModel as upstreamModelValue, mappingInteger as integer, mappingKey as key } from '../catalog/model-mappings';
import type { ModelMappingKey, ModelMappingInput, ModelMappingView, ModelMappingRow as Row } from '../catalog/model-mappings';
export { getModelMapping, listModelMappings } from '../catalog/model-mappings';
export type { ModelMappingKey, ModelMappingInput, ModelMappingView, ModelMappingQuery } from '../catalog/model-mappings';

export interface ModelMappingPatch { upstreamModel?: string }
export interface ModelMappingAuditContext { actorId: string; operationId: string; now: number }

async function parents(database: D1Database, identity: ModelMappingKey) {
  const [channel, model] = await Promise.all([getChannelById(database, identity.channelId), getModelById(database, identity.publicModelId)]);
  if (!channel || !model) throw new ApiError('not_found');
  return channel;
}
async function audit(database: D1Database, identity: ModelMappingKey, version: number, context: ModelMappingAuditContext, action: string) {
  const values = object(context, ['actorId', 'operationId', 'now']);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([identity.channelId, identity.publicModelId, identity.protocol]))));
  return buildAuditStatement(database, { actor_id: text(values.actorId), operation_id: text(values.operationId), created_at: integer(values.now, 0),
    action, target_type: 'channel_model', target_id: Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join(''),
    changes: { channel_id: identity.channelId, public_model_id: identity.publicModelId, protocol: identity.protocol,
      config_version: { before: action === 'channel_model.delete' ? version : action === 'channel_model.create' ? null : version - 1, after: action === 'channel_model.delete' ? null : version } } });
}
function guard(database: D1Database) { return prepare(database, "SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('{}','model_mapping_conflict') END AS matched"); }
function writeError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  for (let cause = error, depth = 0; cause instanceof Error && depth < 4; cause = cause.cause, depth++) {
    if (cause.message.includes('model_mapping_conflict')) throw new ApiError('conflict');
  }
  throw new ApiError('service_unavailable', { cause: error });
}
export async function createModelMapping(database: D1Database, input: ModelMappingInput, context: ModelMappingAuditContext): Promise<ModelMappingView> {
  const fields = object(input, ['channelId', 'publicModelId', 'protocol', 'upstreamModel']);
  const identity = key({ channelId: fields.channelId as string, publicModelId: fields.publicModelId as string, protocol: fields.protocol as Protocol });
  const upstreamModel = upstreamModelValue(fields.upstreamModel);
  const channel = await parents(database, identity);
  const statement = await audit(database, identity, channel.configVersion, context, 'channel_model.create');
  try {
    const result = await batch(database, [
      prepare<Row>(database, `INSERT INTO channel_models (${projection}) SELECT ?,?,?,?,config_version FROM channels
        WHERE id=? AND deleted_at IS NULL AND config_version=?
        ON CONFLICT(channel_id,public_model_id,protocol) DO NOTHING RETURNING ${projection}`,
      [identity.channelId, identity.publicModelId, identity.protocol, upstreamModel, identity.channelId, channel.configVersion]), guard(database), statement,
    ] as const);
    if (!result[0].rows[0]) throw new ApiError('service_unavailable');
    return view(result[0].rows[0]);
  } catch (error) { return writeError(error); }
}
export async function updateModelMapping(database: D1Database, input: ModelMappingKey, expectedVersion: number, patch: ModelMappingPatch, context: ModelMappingAuditContext): Promise<ModelMappingView> {
  const identity = key(input);
  integer(expectedVersion);
  if (expectedVersion >= Number.MAX_SAFE_INTEGER) throw new ApiError('conflict');
  const fields = object(patch, ['upstreamModel']);
  if (Object.keys(fields).length === 0) invalid();
  const current = await getModelMapping(database, identity);
  if (!current) throw new ApiError('not_found');
  if (current.configVersion !== expectedVersion) throw new ApiError('conflict');
  const upstreamModel = Object.hasOwn(fields, 'upstreamModel') ? upstreamModelValue(fields.upstreamModel) : current.upstreamModel;
  await parents(database, identity);
  const statement = await audit(database, identity, expectedVersion + 1, context, 'channel_model.update');
  try {
    const result = await batch(database, [prepare<Row>(database, `UPDATE channel_models SET upstream_model=?,config_version=config_version+1
      WHERE channel_id=? AND public_model_id=? AND protocol=? AND config_version=? RETURNING ${projection}`,
    [upstreamModel, identity.channelId, identity.publicModelId, identity.protocol, expectedVersion]), guard(database), statement] as const);
    if (!result[0].rows[0]) throw new ApiError('service_unavailable');
    return view(result[0].rows[0]);
  } catch (error) { return writeError(error); }
}

/** Removing a route never removes its public model or request/billing snapshots. */
export async function deleteModelMapping(database: D1Database, input: ModelMappingKey, expectedVersion: number, context: ModelMappingAuditContext): Promise<void> {
  const identity = key(input);
  integer(expectedVersion);
  if (expectedVersion >= Number.MAX_SAFE_INTEGER) throw new ApiError('conflict');
  const current = await getModelMapping(database, identity);
  if (!current) throw new ApiError('not_found');
  if (current.configVersion !== expectedVersion) throw new ApiError('conflict');
  await parents(database, identity);
  const statement = await audit(database, identity, expectedVersion, context, 'channel_model.delete');
  try {
    await batch(database, [
      prepare(database, `DELETE FROM channel_models WHERE channel_id=? AND public_model_id=? AND protocol=? AND config_version=?`,
        [identity.channelId, identity.publicModelId, identity.protocol, expectedVersion]), guard(database),
      // Invalidate cached/admitted selections even if the same mapping is later re-created.
      prepare(database, `UPDATE channels SET config_version=max(config_version,?)+1,updated_at=max(updated_at,?)
        WHERE id=? AND deleted_at IS NULL AND config_version<9007199254740991`, [expectedVersion, context.now, identity.channelId]), guard(database), statement,
    ]);
  } catch (error) { return writeError(error); }
}
