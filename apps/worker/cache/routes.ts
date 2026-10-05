import { getGroupById } from '../admin/group-repository';
import type { GroupView } from '../admin/group-repository';
import { getChannelById } from '../catalog/channels';
import type { ChannelView } from '../catalog/channels';
import { getModelById } from '../catalog/models';
import type { ModelView } from '../catalog/models';
import { listModelMappings, validateMappingCapabilities } from '../catalog/model-mappings';
import type { ModelMappingView } from '../catalog/model-mappings';
import { validateUpstreamBaseUrl } from '../gateway/upstream-url';
import { DEFAULT_CONFIG } from '../config';
import { ApiError } from '../http';
import { readSnapshot, writeSnapshot } from './snapshot';
import type { Snapshot } from './snapshot';

export interface RouteCandidate {
  channel: Pick<ChannelView, 'id' | 'baseUrl' | 'priority' | 'concurrencyLimit' | 'rpmLimit' | 'configVersion'>;
  mapping: ModelMappingView;
}
export interface RouteData {
  group: Pick<GroupView, 'id' | 'version'>;
  model: Pick<ModelView, 'publicModelId' | 'priceVersion'>;
  candidates: RouteCandidate[];
}
export interface RouteRead { snapshot: Snapshot<RouteData>; source: 'cache' | 'd1'; requiresAuthoritativeRecheck: true }
export interface RouteCacheOptions { now?: () => number; maxAgeMs?: number; forceRefresh?: boolean }

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value);
}
export function routesCacheKey(groupId: string, publicModelId: string): string {
  if (!identifier(groupId) || !identifier(publicModelId)) throw new ApiError('invalid_request');
  return `v1:routes:${encodeURIComponent(groupId)}:${encodeURIComponent(publicModelId)}`;
}
function object(value: unknown, fields: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    fields.every(field => Object.hasOwn(value, field));
}
function integer(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
function validRoutes(value: unknown, groupId: string, modelId: string): value is RouteData {
  if (!object(value, ['group', 'model', 'candidates']) || !object(value.group, ['id', 'version']) ||
      value.group.id !== groupId || !integer(value.group.version, 1) || !object(value.model, ['publicModelId', 'priceVersion']) ||
      value.model.publicModelId !== modelId || !integer(value.model.priceVersion, 1) || !Array.isArray(value.candidates)) return false;
  const seen = new Set<string>();
  try {
    for (const candidate of value.candidates) {
      if (!object(candidate, ['channel', 'mapping']) ||
          !object(candidate.channel, ['id', 'baseUrl', 'priority', 'concurrencyLimit', 'rpmLimit', 'configVersion']) ||
          !object(candidate.mapping, ['channelId', 'publicModelId', 'protocol', 'upstreamModel', 'capabilities', 'configVersion'])) return false;
      const channel = candidate.channel;
      const mapping = candidate.mapping;
      if (!identifier(channel.id) || typeof channel.baseUrl !== 'string' || !integer(channel.priority, 0) ||
          !integer(channel.concurrencyLimit, 1) || !integer(channel.rpmLimit, 1) || !integer(channel.configVersion, 1) ||
          mapping.channelId !== channel.id || mapping.publicModelId !== modelId || !identifier(mapping.upstreamModel) ||
          !integer(mapping.configVersion, 1) || !['chat', 'responses', 'messages'].includes(mapping.protocol as string)) return false;
      validateUpstreamBaseUrl(channel.baseUrl);
      validateMappingCapabilities(mapping.capabilities, mapping.protocol as ModelMappingView['protocol']);
      const identity = JSON.stringify([channel.id, mapping.protocol]);
      if (seen.has(identity)) return false;
      seen.add(identity);
    }
    return true;
  } catch { return false; }
}

/** Candidate configuration only. G03 must recheck current group/channel/model,
 * membership and mapping versions before dispatch; no cache entry grants access.
 * Never calls readChannelForForwarding or accepts a decryption keyring.
 */
export async function readRoutes(database: D1Database, kv: KVNamespace, groupId: string, publicModelId: string,
  options: RouteCacheOptions = {}): Promise<RouteRead | null> {
  const key = routesCacheKey(groupId, publicModelId);
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_CONFIG.routingCacheTtlMs;
  if (!integer(maxAgeMs, 1) || (options.forceRefresh !== undefined && typeof options.forceRefresh !== 'boolean')) throw new ApiError('invalid_request');
  const clock = options.now ?? Date.now;
  const validate = (value: unknown): value is RouteData => validRoutes(value, groupId, publicModelId);
  if (!options.forceRefresh) {
    const cached = await readSnapshot(kv, key, { now: clock(), maxAgeMs }, validate);
    if (cached) {
      const age = clock() - cached.observed_at;
      if (age >= 0 && age < maxAgeMs) return { snapshot: cached, source: 'cache', requiresAuthoritativeRecheck: true };
    }
  }
  const observedAt = clock();
  let data: RouteData;
  try {
    const [group, model] = await Promise.all([getGroupById(database, groupId), getModelById(database, publicModelId)]);
    if (!group || group.status !== 'active' || !model || model.status !== 'active') {
      try { await kv.delete(key); } catch { /* Invalidation is best effort, never an authorization guarantee. */ }
      return null;
    }
    const mappings = (await listModelMappings(database, { publicModelId, activeOnly: true }))
      .filter(mapping => group.channelIds.includes(mapping.channelId));
    const channelIds = [...new Set(mappings.map(mapping => mapping.channelId))];
    const channels = new Map((await Promise.all(channelIds.map(channel => getChannelById(database, channel))))
      .filter((channel): channel is ChannelView => channel !== null && channel.status === 'active').map(channel => [channel.id, channel]));
    const candidates: RouteCandidate[] = [];
    for (const mapping of mappings) {
      const channel = channels.get(mapping.channelId);
      if (!channel) continue;
      // Explicit projection prevents future credential fields from reaching KV.
      candidates.push({ channel: { id: channel.id, baseUrl: channel.baseUrl, priority: channel.priority,
        concurrencyLimit: channel.concurrencyLimit, rpmLimit: channel.rpmLimit, configVersion: channel.configVersion },
      mapping: { channelId: mapping.channelId, publicModelId: mapping.publicModelId, protocol: mapping.protocol,
        upstreamModel: mapping.upstreamModel, capabilities: mapping.capabilities, configVersion: mapping.configVersion } });
    }
    data = { group: { id: group.id, version: group.version }, model: { publicModelId: model.publicModelId, priceVersion: model.priceVersion }, candidates };
  } catch (error) { throw new ApiError('service_unavailable', { cause: error }); }
  const snapshot: Snapshot<RouteData> = { schema_version: 1, observed_at: observedAt, data };
  await writeSnapshot(kv, key, snapshot, { now: clock(), maxAgeMs }, validate);
  return { snapshot, source: 'd1', requiresAuthoritativeRecheck: true };
}
