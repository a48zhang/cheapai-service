import { queryOptions } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { createMappingsApi } from '@cheapai/api-client/mappings';
import type {
  ModelMappingInput,
  ModelMappingPatch,
  ModelMappingQuery,
  ModelMappingView,
  Protocol,
} from '@cheapai/api-client/mappings';
import type { ApiClient } from '@cheapai/api-client/types';

export interface AdminMappingsContext {
  readonly client: ApiClient;
  readonly actorId: string;
}

export const modelMappingQueryKeys = Object.freeze({
  root: (actorId: string, publicModelId: string) =>
    ['admin-models', actorId, publicModelId, 'mappings'] as const,
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
    queryFn: ({ signal }) => api.listMappings(publicModelId, query, { signal }),
  });
}

function invalidateModelMappings(
  queryClient: QueryClient,
  actorId: string,
  publicModelId: string,
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: modelMappingQueryKeys.root(actorId, publicModelId),
  });
}

export function recordMappingSaved(
  queryClient: QueryClient,
  actorId: string,
  mapping: ModelMappingView,
): Promise<void> {
  void queryClient.cancelQueries({
    queryKey: modelMappingQueryKeys.root(actorId, mapping.publicModelId),
  });
  queryClient.setQueryData<{ items: ModelMappingView[] }>(
    modelMappingQueryKeys.list(actorId, mapping.publicModelId),
    (current) => {
      if (!current) return current;
      const other = current.items.filter(
        (item) => item.channelId !== mapping.channelId || item.protocol !== mapping.protocol,
      );
      const previous = current.items.find(
        (item) => item.channelId === mapping.channelId && item.protocol === mapping.protocol,
      );
      return {
        ...current,
        items: [
          ...other,
          previous && previous.configVersion > mapping.configVersion ? previous : mapping,
        ],
      };
    },
  );
  return invalidateModelMappings(queryClient, actorId, mapping.publicModelId);
}

export type { ModelMappingInput, ModelMappingPatch, ModelMappingQuery, ModelMappingView, Protocol };
