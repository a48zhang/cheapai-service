import { decodeMapping, decodeMappings } from '@cheapai/contracts/mappings';
import type {
  ChannelCapabilities,
  ModelMappingInput,
  ModelMappingList,
  ModelMappingPatch,
  ModelMappingQuery,
  ModelMappingView,
  Protocol,
} from '@cheapai/contracts/mappings';
import type { ApiClient, ApiReadOptions } from './types.js';

export type {
  CapabilityFeature,
  ChannelCapabilities,
  ModelMappingInput,
  ModelMappingList,
  ModelMappingPatch,
  ModelMappingQuery,
  ModelMappingView,
  Protocol,
} from '@cheapai/contracts/mappings';
export {
  CAPABILITY_FEATURES,
  decodeCapabilities,
  decodeMapping,
  decodeMappings,
} from '@cheapai/contracts/mappings';

const modelPath = (publicModelId: string) =>
  `/api/v1/admin/models/${encodeURIComponent(publicModelId)}`;
const mappingPath = (publicModelId: string) => `${modelPath(publicModelId)}/mappings`;

function capabilitiesBody(value: ChannelCapabilities) {
  return {
    protocol: value.protocol,
    features: [...value.features],
    ...(value.maxOutputTokens === undefined ? {} : { maxOutputTokens: value.maxOutputTokens }),
    ...(value.reasoningEfforts === undefined
      ? {}
      : { reasoningEfforts: [...value.reasoningEfforts] }),
    ...(value.cacheTtls === undefined ? {} : { cacheTtls: [...value.cacheTtls] }),
  };
}

/** Administrator channel mappings use their independent configVersion for edits. */
export function createMappingsApi(api: ApiClient) {
  async function listMappings(
    publicModelId: string,
    options: ModelMappingQuery = {},
    readOptions?: ApiReadOptions,
  ): Promise<ModelMappingList> {
    return (
      await api.get(mappingPath(publicModelId), {
        query: { ...options },
        decode: decodeMappings,
        ...(readOptions?.signal === undefined ? {} : { signal: readOptions.signal }),
      })
    ).data;
  }

  async function createMapping(
    publicModelId: string,
    input: ModelMappingInput,
  ): Promise<ModelMappingView> {
    return (
      await api.post(
        mappingPath(publicModelId),
        {
          channelId: input.channelId,
          protocol: input.protocol,
          upstreamModel: input.upstreamModel,
          capabilities: capabilitiesBody(input.capabilities),
        },
        { decode: decodeMapping },
      )
    ).data;
  }

  async function updateMapping(
    publicModelId: string,
    channelId: string,
    protocol: Protocol,
    configVersion: number,
    input: ModelMappingPatch,
  ): Promise<ModelMappingView> {
    return (
      await api.patch(
        `${mappingPath(publicModelId)}/${encodeURIComponent(channelId)}/${protocol}`,
        {
          version: configVersion,
          ...(input.upstreamModel === undefined ? {} : { upstreamModel: input.upstreamModel }),
          ...(input.capabilities === undefined
            ? {}
            : { capabilities: capabilitiesBody(input.capabilities) }),
        },
        { decode: decodeMapping },
      )
    ).data;
  }

  return Object.freeze({
    listMappings,
    createMapping,
    updateMapping,
  });
}
