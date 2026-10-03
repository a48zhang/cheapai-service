import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { createAdminModelsApi } from '@cheapai/api-client/models';
import type { ModelQuery } from '@cheapai/api-client/models';
import type { ApiClient } from '@cheapai/api-client/types';

export interface AdminModelsContext {
  readonly client: ApiClient;
  /** Admin actor identity keeps privileged data isolated when sessions change. */
  readonly actorId: string;
}

export type ModelListFilters = Omit<ModelQuery, 'cursor'>;

export const adminModelsQueryKeys = Object.freeze({
  root: (actorId: string) => ['admin-models', actorId] as const,
  lists: (actorId: string) => [...adminModelsQueryKeys.root(actorId), 'list'] as const,
  list: (actorId: string, filters: ModelListFilters) => [...adminModelsQueryKeys.lists(actorId), filters] as const,
  details: (actorId: string) => [...adminModelsQueryKeys.root(actorId), 'detail'] as const,
  detail: (actorId: string, publicModelId: string) => [...adminModelsQueryKeys.details(actorId), publicModelId] as const,
});

/** Infinite model catalog query; the cursor stays in page state, outside the cache key. */
export function modelListQueryOptions(context: AdminModelsContext, filters: ModelListFilters = {}) {
  const api = createAdminModelsApi(context.client);
  return infiniteQueryOptions({
    queryKey: adminModelsQueryKeys.list(context.actorId, filters),
    queryFn: ({ pageParam }) => api.list({ ...filters, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor ?? undefined,
  });
}

/** Detail keys include the admin identity and the raw ID; transport encodes it as one path segment. */
export function modelDetailQueryOptions(context: AdminModelsContext, publicModelId: string) {
  const api = createAdminModelsApi(context.client);
  return queryOptions({
    queryKey: adminModelsQueryKeys.detail(context.actorId, publicModelId),
    queryFn: () => api.get(publicModelId),
  });
}
