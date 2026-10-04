import { queryOptions } from '@tanstack/react-query';
import { decodeChannelPage } from '@cheapai/contracts/channels';
import type { ChannelPage, ChannelView } from '@cheapai/contracts/channels';
import type { ApiClient } from '@cheapai/api-client/types';

export type ChannelOptionsApi = ApiClient;

export interface ChannelOptionsSnapshot {
  readonly items: readonly ChannelView[];
  /** Cursor used to request the final page. */
  readonly terminalCursor: string | null;
  readonly pageCount: number;
  /** A snapshot is created only after every page has loaded successfully. */
  readonly complete: true;
}

export const channelOptionsQueryKey = (userId: string, epoch: number) =>
  ['admin', 'channels', userId, epoch, 'options'] as const;

/** Loads all channel pages as one query result so a failed middle page cannot look complete. */
export async function loadChannelOptions(
  api: ChannelOptionsApi,
  signal?: AbortSignal,
): Promise<ChannelOptionsSnapshot> {
  const items = new Map<string, ChannelView>();
  const seenNextCursors = new Set<string>();
  let cursor: string | null = null;
  let terminalCursor: string | null = null;
  let pageCount = 0;

  for (;;) {
    const page: ChannelPage = (
      await api.get('/api/v1/admin/channels', {
        query: { cursor, limit: 20 },
        ...(signal === undefined ? {} : { signal }),
        decode: decodeChannelPage,
      })
    ).data;
    pageCount += 1;
    terminalCursor = cursor;
    for (const channel of page.items) items.set(channel.id, channel);

    const nextCursor: string | null = page.nextCursor;
    if (nextCursor === null) break;
    if (seenNextCursors.has(nextCursor)) {
      throw new Error('Channel pagination returned a repeated cursor.');
    }
    seenNextCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return {
    items: [...items.values()],
    terminalCursor,
    pageCount,
    complete: true,
  };
}

/** Candidate data is isolated by admin identity and session epoch. */
export function channelOptionsQueryOptions(
  api: ChannelOptionsApi,
  userId: string,
  epoch: number,
  enabled = true,
) {
  return queryOptions({
    queryKey: channelOptionsQueryKey(userId, epoch),
    enabled,
    retry: false,
    queryFn: ({ signal }) => loadChannelOptions(api, signal),
  });
}
