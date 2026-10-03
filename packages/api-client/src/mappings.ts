import {
  decodeMapping,
  decodeMappings,
  modelMappingInputSchema,
  modelMappingPatchSchema,
} from '@cheapai/contracts/mappings';
import type {
  ChannelCapabilities,
  ModelMappingInput,
  ModelMappingList,
  ModelMappingPatch,
  ModelMappingQuery,
  ModelMappingView,
  Protocol,
} from '@cheapai/contracts/mappings';
import type { ApiClient } from './types.js';

export type {
  CapabilityFeature,
  ChannelCapabilities,
  ExtensionScope,
  ModelMappingInput,
  ModelMappingList,
  ModelMappingPatch,
  ModelMappingQuery,
  ModelMappingView,
  Protocol,
} from '@cheapai/contracts/mappings';
export { CAPABILITY_FEATURES, EXTENSION_SCOPES, decodeCapabilities, decodeMapping, decodeMappings } from '@cheapai/contracts/mappings';

const modelPath = (publicModelId: string) => `/api/v1/admin/models/${encodeURIComponent(publicModelId)}`;
const mappingPath = (publicModelId: string) => `${modelPath(publicModelId)}/mappings`;

function capabilitiesBody(value: ChannelCapabilities) {
  return {
    protocol: value.protocol,
    features: [...value.features],
    ...(value.maxOutputTokens === undefined ? {} : { maxOutputTokens: value.maxOutputTokens }),
    ...(value.reasoningEfforts === undefined ? {} : { reasoningEfforts: [...value.reasoningEfforts] }),
    ...(value.cacheTtls === undefined ? {} : { cacheTtls: [...value.cacheTtls] }),
    ...(value.nativeExtensions === undefined ? {} : {
      nativeExtensions: value.nativeExtensions.map(extension => ({ scope: extension.scope, name: extension.name })),
    }),
  };
}

/** Administrator channel mappings use their independent configVersion for edits. */
export function createMappingsApi(api: ApiClient) {
  async function listMappings(publicModelId: string, options: ModelMappingQuery = {}): Promise<ModelMappingList> {
    return (await api.get(mappingPath(publicModelId), {
      query: { ...options },
      decode: decodeMappings,
    })).data;
  }

  async function createMapping(publicModelId: string, input: ModelMappingInput): Promise<ModelMappingView> {
    const value = modelMappingInputSchema.parse(input);
    return (await api.post(mappingPath(publicModelId), {
      channelId: value.channelId,
      protocol: value.protocol,
      upstreamModel: value.upstreamModel,
      capabilities: capabilitiesBody(value.capabilities),
    }, { decode: decodeMapping })).data;
  }

  async function updateMapping(
    publicModelId: string,
    channelId: string,
    protocol: Protocol,
    configVersion: number,
    input: ModelMappingPatch,
  ): Promise<ModelMappingView> {
    const patch = modelMappingPatchSchema.parse(input);
    if (!Number.isSafeInteger(configVersion) || configVersion < 1) {
      throw new TypeError('Invalid administrator model mapping version.');
    }
    if (patch.capabilities !== undefined && patch.capabilities.protocol !== protocol) {
      throw new TypeError('Model mapping capability protocol must match the mapping protocol.');
    }
    return (await api.patch(`${mappingPath(publicModelId)}/${encodeURIComponent(channelId)}/${protocol}`, {
      version: configVersion,
      ...(patch.upstreamModel === undefined ? {} : { upstreamModel: patch.upstreamModel }),
      ...(patch.capabilities === undefined ? {} : { capabilities: capabilitiesBody(patch.capabilities) }),
    }, { decode: decodeMapping })).data;
  }

  return Object.freeze({
    listMappings,
    mappings: listMappings,
    createMapping,
    updateMapping,
    list: listMappings,
    create: createMapping,
    update: updateMapping,
  });
}

export const createAdminMappingsApi = createMappingsApi;
