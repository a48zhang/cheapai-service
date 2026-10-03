import { queryOptions } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { createMappingsApi } from '@cheapai/api-client/mappings';
import type { ModelMappingInput, ModelMappingPatch, ModelMappingQuery, ModelMappingView, Protocol } from '@cheapai/api-client/mappings';
import type { ApiClient } from '@cheapai/api-client/types';

export interface AdminMappingsContext {
  readonly client: ApiClient;
  readonly actorId: string;
}

export const modelMappingQueryKeys = Object.freeze({
  root: (actorId: string, publicModelId: string) => ['admin-models', actorId, publicModelId, 'mappings'] as const,
  list: (actorId: string, publicModelId: string, query: ModelMappingQuery = {}) =>
    [...modelMappingQueryKeys.root(actorId, publicModelId), query] as const,
});

/** Mapping data has its own key beneath the model and admin identity. */
export function modelMappingsQueryOptions(
  context: AdminMappingsContext,
  publicModelId: string,
  query: ModelMappingQuery = {},
) {
  const api = createMappingsApi(context.client);
  return queryOptions({
    queryKey: modelMappingQueryKeys.list(context.actorId, publicModelId, query),
    retry: false,
    queryFn: () => api.listMappings(publicModelId, query),
  });
}

/** Commands carry mapping configVersion so callers cannot accidentally reuse priceVersion. */
export function createModelMappingCommands(context: AdminMappingsContext) {
  const api = createMappingsApi(context.client);
  return Object.freeze({
    create: (publicModelId: string, input: ModelMappingInput) => api.createMapping(publicModelId, input),
    update: (
      publicModelId: string,
      channelId: string,
      protocol: Protocol,
      configVersion: number,
      patch: ModelMappingPatch,
    ) => api.updateMapping(publicModelId, channelId, protocol, configVersion, patch),
  });
}

export function invalidateModelMappings(queryClient: QueryClient, actorId: string, publicModelId: string): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: modelMappingQueryKeys.root(actorId, publicModelId) });
}

export type { ModelMappingInput, ModelMappingPatch, ModelMappingQuery, ModelMappingView, Protocol };
