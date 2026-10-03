import { infiniteQueryOptions, mutationOptions, queryOptions } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { createChatApi } from '@cheapai/api-client/chat';
import type {
  ChatApi,
  ChatApiOptions,
  ChatList,
  ConversationCreateInput,
  ConversationDetail,
  ConversationPatchInput,
} from '@cheapai/api-client/chat';
import type { ApiClient } from '@cheapai/api-client/types';
import { chatQueryKeys } from './query-keys';

export interface ChatQueryOwner {
  /** Cache owner; queries are disabled until a current authenticated user exists. */
  readonly userId: string;
  /** Distinguishes a restored/replaced identity even when the user ID is unchanged. */
  readonly epoch: number;
}

export interface ChatApiContext extends ChatQueryOwner, Omit<ChatApiOptions, 'client'> {
  readonly client: ApiClient;
}

export function createChatFeatureApi(context: ChatApiContext): ChatApi {
  return createChatApi({
    client: context.client,
    ...(context.fetch === undefined ? {} : { fetch: context.fetch }),
    ...(context.getCsrfToken === undefined ? {} : { getCsrfToken: context.getCsrfToken }),
    ...(context.captureIdentity === undefined ? {} : { captureIdentity: context.captureIdentity }),
    ...(context.onUnauthorized === undefined ? {} : { onUnauthorized: context.onUnauthorized }),
  });
}

export function chatModelsQueryOptions(context: ChatApiContext) {
  const api = createChatFeatureApi(context);
  return queryOptions({
    queryKey: chatQueryKeys.models(context.userId, context.epoch),
    queryFn: () => api.models(),
    enabled: context.userId.length > 0,
  });
}

export function chatConversationListQueryOptions(context: ChatApiContext) {
  const api = createChatFeatureApi(context);
  return infiniteQueryOptions({
    queryKey: chatQueryKeys.list(context.userId, context.epoch),
    queryFn: ({ pageParam }) => api.listConversations(pageParam),
    initialPageParam: null as string | null,
    retry: false,
    getNextPageParam: (page: ChatList) => page.nextCursor === null || page.nextCursor.length === 0
      ? undefined
      : page.nextCursor,
    enabled: context.userId.length > 0,
  });
}

export function chatConversationDetailQueryOptions(context: ChatApiContext, conversationId: string) {
  const api = createChatFeatureApi(context);
  return queryOptions<ConversationDetail>({
    queryKey: chatQueryKeys.detail(context.userId, context.epoch, conversationId),
    queryFn: () => api.getConversation(conversationId),
    enabled: context.userId.length > 0 && conversationId.length > 0,
  });
}

export function createConversationMutationOptions(context: ChatApiContext, queryClient: QueryClient) {
  const api = createChatFeatureApi(context);
  return mutationOptions({
    mutationFn: (input: ConversationCreateInput = {}) => api.createConversation(input),
    onSuccess: () => queryClient.invalidateQueries({
      queryKey: chatQueryKeys.lists(context.userId, context.epoch),
    }),
  });
}

export function updateConversationMutationOptions(context: ChatApiContext, queryClient: QueryClient) {
  const api = createChatFeatureApi(context);
  return mutationOptions({
    mutationFn: (input: { readonly id: string; readonly patch: ConversationPatchInput }) =>
      api.updateConversation(input.id, input.patch),
    onSuccess: conversation => Promise.all([
      queryClient.invalidateQueries({ queryKey: chatQueryKeys.lists(context.userId, context.epoch) }),
      queryClient.invalidateQueries({
        queryKey: chatQueryKeys.detail(context.userId, context.epoch, conversation.id),
      }),
    ]),
  });
}

export function deleteConversationMutationOptions(context: ChatApiContext, queryClient: QueryClient) {
  const api = createChatFeatureApi(context);
  return mutationOptions({
    mutationFn: (input: { readonly id: string; readonly version: number }) =>
      api.deleteConversation(input.id, input.version),
    onSuccess: (_result, input) => Promise.all([
      queryClient.invalidateQueries({ queryKey: chatQueryKeys.lists(context.userId, context.epoch) }),
      queryClient.removeQueries({
        queryKey: chatQueryKeys.detail(context.userId, context.epoch, input.id),
        exact: true,
      }),
    ]),
  });
}
