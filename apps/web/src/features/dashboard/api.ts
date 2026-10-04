import { queryOptions } from '@tanstack/react-query';
import { createAccountApi } from '@cheapai/api-client/account';
import type { AccountApi } from '@cheapai/api-client/account';
import { createRequestsApi } from '@cheapai/api-client/requests';
import type { ApiClient } from '@cheapai/api-client/types';

export interface DashboardApi {
  readonly account: AccountApi;
  readonly requests: ReturnType<typeof createRequestsApi>;
}

export function createDashboardApi(client: ApiClient): DashboardApi {
  return Object.freeze({ account: createAccountApi(client), requests: createRequestsApi(client) });
}

export const dashboardQueryKeys = Object.freeze({
  root: (userId: string) => ['dashboard', userId] as const,
  balance: (userId: string) => [...dashboardQueryKeys.root(userId), 'balance'] as const,
  recentRequests: (userId: string) =>
    [...dashboardQueryKeys.root(userId), 'recent-requests'] as const,
});

export function balanceQueryOptions(api: DashboardApi, userId: string) {
  return queryOptions({
    queryKey: dashboardQueryKeys.balance(userId),
    queryFn: ({ signal }) => api.account.balance({ signal }),
  });
}

export function recentRequestsQueryOptions(api: DashboardApi, userId: string) {
  return queryOptions({
    queryKey: dashboardQueryKeys.recentRequests(userId),
    queryFn: ({ signal }) => api.requests.list({ cursor: null }, { signal }),
  });
}
