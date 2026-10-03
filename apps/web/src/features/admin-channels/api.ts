import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { createChannelsApi } from '@cheapai/api-client/channels';
import type { ChannelStatus } from '@cheapai/api-client/channels';
import type { ApiClient } from '@cheapai/api-client/types';

export type AdminChannelsApi = ReturnType<typeof createChannelsApi>;
export type ChannelStatusFilter = ChannelStatus | 'all';

export const adminChannelsQueryKeys = {
  all: (userId: string, epoch: number) => ['admin', 'channels', userId, epoch] as const,
  lists: (userId: string, epoch: number) => [...adminChannelsQueryKeys.all(userId, epoch), 'list'] as const,
  list: (userId: string, epoch: number, status: ChannelStatusFilter) =>
    [...adminChannelsQueryKeys.lists(userId, epoch), status] as const,
  details: (userId: string, epoch: number) => [...adminChannelsQueryKeys.all(userId, epoch), 'detail'] as const,
  detail: (userId: string, epoch: number, channelId: string) =>
    [...adminChannelsQueryKeys.details(userId, epoch), channelId] as const,
};

export function createAdminChannelsFeatureApi(client: ApiClient): AdminChannelsApi {
  return createChannelsApi(client);
}

export function channelsListQueryOptions(
  api: AdminChannelsApi,
  userId: string,
  epoch: number,
  status: ChannelStatusFilter,
  enabled = true,
) {
  return infiniteQueryOptions({
    queryKey: adminChannelsQueryKeys.list(userId, epoch, status),
    enabled,
    queryFn: ({ pageParam }) => api.list({
      cursor: pageParam,
      ...(status === 'all' ? {} : { status }),
    }),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor ?? undefined,
  });
}

export function channelDetailQueryOptions(
  api: AdminChannelsApi,
  userId: string,
  epoch: number,
  channelId: string,
) {
  return queryOptions({
    queryKey: adminChannelsQueryKeys.detail(userId, epoch, channelId),
    queryFn: () => api.get(channelId),
    enabled: channelId.length > 0,
  });
}

export function invalidateAdminChannels(queryClient: QueryClient, userId: string, epoch: number) {
  return queryClient.invalidateQueries({ queryKey: adminChannelsQueryKeys.all(userId, epoch) });
}
