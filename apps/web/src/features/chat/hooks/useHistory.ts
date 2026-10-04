import { useCallback, useMemo, useRef } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import type { ChatList, Conversation, ConversationCreateInput } from '@cheapai/api-client/chat';
import {
  chatConversationListQueryOptions,
  createConversationMutationOptions,
  deleteConversationMutationOptions,
  updateConversationMutationOptions,
} from '../api';
import type { ChatApiContext } from '../api';
import { chatQueryKeys } from '../query-keys';

export interface UseHistoryOptions {
  readonly context: ChatApiContext;
}

function hasRepeatedCursor(data: InfiniteData<ChatList, unknown> | undefined): boolean {
  if (!data) return false;
  return data.pages.some((page, index) => {
    const cursor = page.nextCursor;
    return cursor !== null && data.pageParams.slice(0, index + 1).includes(cursor);
  });
}

function mergeConversations(data: InfiniteData<ChatList, unknown> | undefined): Conversation[] {
  if (!data) return [];
  const byId = new Map<string, Conversation>();
  for (const page of data.pages) {
    for (const conversation of page.items) {
      const previous = byId.get(conversation.id);
      if (
        !previous ||
        conversation.version > previous.version ||
        (conversation.version === previous.version && conversation.updatedAt > previous.updatedAt)
      ) {
        byId.set(conversation.id, conversation);
      }
    }
  }
  return [...byId.values()].sort(
    (left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id),
  );
}

/** Cursor-paged conversation history scoped by the current user and session epoch. */
export function useHistory({ context }: UseHistoryOptions) {
  const queryClient = useQueryClient();
  const queryKey = chatQueryKeys.list(context.userId, context.epoch);
  const query = useInfiniteQuery(chatConversationListQueryOptions(context));
  const createMutation = useMutation(createConversationMutationOptions(context, queryClient));
  const updateMutation = useMutation(updateConversationMutationOptions(context, queryClient));
  const deleteMutation = useMutation(deleteConversationMutationOptions(context, queryClient));
  const {
    data,
    error,
    isPending,
    isRefetching,
    isFetchingNextPage,
    hasNextPage,
    isFetchNextPageError,
    fetchNextPage,
    refetch,
  } = query;
  const createConversationAsync = createMutation.mutateAsync;
  const updateConversationAsync = updateMutation.mutateAsync;
  const deleteConversationAsync = deleteMutation.mutateAsync;
  const nextPageLock = useRef(false);
  const repeatedCursor = useMemo(() => hasRepeatedCursor(data), [data]);
  const conversations = useMemo(() => mergeConversations(data), [data]);
  const errorMessage = repeatedCursor
    ? '历史分页位置重复，已停止继续加载。请刷新后重试。'
    : error
      ? '历史对话读取失败。'
      : null;

  const loadMore = useCallback(async () => {
    if (!hasNextPage || isFetchingNextPage || repeatedCursor || nextPageLock.current) return;
    nextPageLock.current = true;
    try {
      await fetchNextPage({ cancelRefetch: false });
    } finally {
      nextPageLock.current = false;
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, repeatedCursor]);

  const retry = useCallback(async () => {
    if (repeatedCursor) {
      await queryClient.resetQueries({ queryKey, exact: true });
    } else if (isFetchNextPageError && hasNextPage) {
      await loadMore();
    } else {
      await refetch();
    }
  }, [hasNextPage, isFetchNextPageError, loadMore, queryClient, queryKey, refetch, repeatedCursor]);

  const createConversation = useCallback(
    (input: ConversationCreateInput = {}) => createConversationAsync(input),
    [createConversationAsync],
  );
  const renameConversation = useCallback(
    (conversation: Conversation, title: string) =>
      updateConversationAsync({
        id: conversation.id,
        patch: { version: conversation.version, title },
      }),
    [updateConversationAsync],
  );
  const deleteConversation = useCallback(
    (conversation: Conversation) =>
      deleteConversationAsync({
        id: conversation.id,
        version: conversation.version,
      }),
    [deleteConversationAsync],
  );

  return {
    conversations,
    loading: isPending,
    refreshing: isRefetching && !isPending,
    loadingMore: isFetchingNextPage,
    hasMore: Boolean(hasNextPage && !repeatedCursor),
    error: error ?? (repeatedCursor ? new Error('Repeated conversation cursor.') : null),
    errorMessage,
    canManage: context.userId.length > 0,
    createConversation,
    renameConversation,
    deleteConversation,
    loadMore,
    retry,
    refresh: refetch,
  };
}
