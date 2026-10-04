import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { createAdminRequestsApi, createRequestsApi } from '@cheapai/api-client/requests';
import type { AdminRequestQuery, RequestQuery } from '@cheapai/api-client/requests';
import type { ApiClient } from '@cheapai/api-client/types';
import { nextPageCursor } from '../../shared/lib/pagination';

export type RequestHistoryScope = 'personal' | 'admin';

export interface RequestHistoryContext {
  readonly client: ApiClient;
  /** Cache owner: the signed-in user for personal pages and the admin actor for global pages. */
  readonly userId: string;
  readonly scope: RequestHistoryScope;
  readonly epoch?: number;
}

export type RequestHistoryFilters = RequestQuery | AdminRequestQuery;

function scopedQuery(
  scope: RequestHistoryScope,
  filters: RequestHistoryFilters,
): RequestQuery | AdminRequestQuery {
  const base = {
    ...(filters.cursor === undefined ? {} : { cursor: filters.cursor }),
    ...(filters.from === undefined ? {} : { from: filters.from }),
    ...(filters.to === undefined ? {} : { to: filters.to }),
    ...(filters.status === undefined ? {} : { status: filters.status }),
    ...(filters.billingStatus === undefined ? {} : { billingStatus: filters.billingStatus }),
    ...(filters.model === undefined ? {} : { model: filters.model }),
  };
  if (scope === 'admin' && 'userId' in filters && filters.userId !== undefined) {
    return { ...base, userId: filters.userId };
  }
  return base;
}

export const requestHistoryKeys = Object.freeze({
  root: (userId: string, scope: RequestHistoryScope) => ['request-history', userId, scope] as const,
  list: (userId: string, scope: RequestHistoryScope, filters: RequestHistoryFilters) =>
    [...requestHistoryKeys.root(userId, scope), 'list', scopedQuery(scope, filters)] as const,
  detail: (userId: string, scope: RequestHistoryScope, requestId: string) =>
    [...requestHistoryKeys.root(userId, scope), 'detail', requestId] as const,
});

/** Query options keep each admin/personal page and filter set in its own cache entry. */
export function requestListQueryOptions(
  context: RequestHistoryContext,
  filters: RequestHistoryFilters = {},
) {
  const query = scopedQuery(context.scope, filters);
  const api =
    context.scope === 'admin'
      ? createAdminRequestsApi(context.client)
      : createRequestsApi(context.client);
  return queryOptions({
    queryKey:
      context.epoch === undefined
        ? requestHistoryKeys.list(context.userId, context.scope, query)
        : ([
            ...requestHistoryKeys.list(context.userId, context.scope, query),
            'session-epoch',
            context.epoch,
          ] as const),
    queryFn: ({ signal }) => api.list(query, { signal }),
  });
}

/** Detail queries use the route ID directly; the API client safely encodes it as one path segment. */
export function requestDetailQueryOptions(context: RequestHistoryContext, requestId: string) {
  const api =
    context.scope === 'admin'
      ? createAdminRequestsApi(context.client)
      : createRequestsApi(context.client);
  return queryOptions({
    queryKey: requestHistoryKeys.detail(context.userId, context.scope, requestId),
    queryFn: ({ signal }) => api.get(requestId, { signal }),
  });
}

export function adminRequestListQueryOptions(
  context: RequestHistoryContext,
  filters: AdminRequestQuery = {},
) {
  const api = createAdminRequestsApi(context.client);
  return infiniteQueryOptions({
    queryKey: requestHistoryKeys.list(context.userId, 'admin', filters),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => api.list({ ...filters, cursor: pageParam }, { signal }),
    getNextPageParam: (page, pages) => nextPageCursor(page, pages, '请求'),
  });
}
