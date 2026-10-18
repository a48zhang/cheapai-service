import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '../../session/public';
import { invalidatePersonalBilling } from '../../billing/public';
import {
  createChatFeatureApi,
  chatConversationDetailQueryOptions,
  type ChatApiContext,
} from '../api';
import { chatQueryKeys } from '../query-keys';
import { createChatController, type ChatSendCommand } from '../model/controller';
import { initialChatState, isChatBusy } from '../model/state';
import { conversationView } from '../model/view-state';
import { mergeConversationDetail } from '../model/reconcile';
import type { ConversationDetail } from '@cheapai/contracts/chat';

export interface UseChatControllerOptions {
  context: ChatApiContext;
  conversationId: string | null;
  onConversationCreated: (id: string) => void;
  onDraftRestore: (content: string, userId: string) => void;
}
export function useChatController(options: UseChatControllerOptions) {
  const { session, queryClient } = useSession();
  const { context, conversationId } = options;
  const callbacks = useRef(options);
  callbacks.current = options;
  // Only a locally created conversation may remain visible while its URL catches up.
  const createdRoute = useRef<{ id: string; userId: string; epoch: number } | null>(null);
  const api = useMemo(() => createChatFeatureApi(context), [context]);
  const controller = useMemo(
    () =>
      createChatController({
        api,
        getOwner: session.requestIdentity,
        onConversationCreated: (conversation) => {
          createdRoute.current = {
            id: conversation.id,
            userId: context.userId,
            epoch: context.epoch,
          };
          queryClient.setQueryData<ConversationDetail>(
            chatQueryKeys.detail(context.userId, context.epoch, conversation.id),
            (previous) => mergeConversationDetail(previous ?? null, { conversation, messages: [] }),
          );
          callbacks.current.onConversationCreated(conversation.id);
          void queryClient.invalidateQueries({
            queryKey: chatQueryKeys.lists(context.userId, context.epoch),
          });
        },
        onIdentityInterrupted: (content, owner) => {
          if (session.getSnapshot().expiry?.userId === owner.userId)
            callbacks.current.onDraftRestore(content, owner.userId);
        },
        onDetailConfirmed: (detail) => {
          queryClient.setQueryData(
            chatQueryKeys.detail(context.userId, context.epoch, detail.conversation.id),
            detail,
          );
          void queryClient.invalidateQueries({
            queryKey: chatQueryKeys.lists(context.userId, context.epoch),
          });
          void invalidatePersonalBilling(queryClient, context.userId);
        },
      }),
    [api, session, queryClient, context.userId, context.epoch],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const query = useQuery(chatConversationDetailQueryOptions(context, conversationId ?? ''));
  const lifetimes = useRef(new Map<typeof controller, number>());
  useEffect(() => {
    const counts = lifetimes.current;
    counts.set(controller, (counts.get(controller) ?? 0) + 1);
    return () => {
      counts.set(controller, (counts.get(controller) ?? 1) - 1);
      // StrictMode immediately reattaches this same instance; actual unmount disposes it.
      queueMicrotask(() => {
        if (counts.get(controller) === 0) {
          controller.dispose();
          counts.delete(controller);
        }
      });
    };
  }, [controller]);
  useEffect(() => {
    const unsubscribe = session.subscribe(controller.identityChanged);
    controller.identityChanged();
    return unsubscribe;
  }, [controller, session]);
  useEffect(() => {
    controller.syncConversation(conversationId);
    if (conversationId !== null) createdRoute.current = null;
  }, [controller, conversationId]);
  useEffect(() => {
    if (query.data && query.data.conversation.id === conversationId) controller.hydrate(query.data);
  }, [controller, query.data, conversationId]);
  const send = useCallback(
    async (command: ChatSendCommand) => {
      if (isChatBusy(controller.getSnapshot().phase)) return 'busy' as const;
      if (
        controller.getConversationId() !== conversationId ||
        (controller.getSnapshot().detail?.conversation.id ?? null) !== conversationId
      )
        return 'busy' as const;
      const owner = session.requestIdentity();
      if (!owner) return 'superseded' as const;
      const result = await controller.send(command);
      if (
        result === 'interrupted' &&
        controller.getSnapshot().failure?.code === 'conversation_creation_unknown'
      ) {
        const currentOwner = session.requestIdentity();
        if (currentOwner?.userId === owner.userId && currentOwner.epoch === owner.epoch)
          callbacks.current.onDraftRestore(command.content, owner.userId);
      }
      if (result === 'rejected' && session.requestIdentity()?.userId === owner.userId)
        callbacks.current.onDraftRestore(command.content, owner.userId);
      return result;
    },
    [controller, conversationId, session],
  );
  const continuingNewConversation =
    (conversationId === null || conversationId === createdRoute.current?.id) &&
    createdRoute.current?.userId === context.userId &&
    createdRoute.current?.epoch === context.epoch &&
    createdRoute.current?.id === state.detail?.conversation.id;
  const routeMatches =
    controller.getConversationId() === conversationId || continuingNewConversation;
  const visibleState =
    routeMatches &&
    (!state.detail || state.detail.conversation.id === controller.getConversationId())
      ? state
      : initialChatState;
  const view = conversationView(conversationId, visibleState, query.error);
  return {
    controller,
    state: visibleState,
    view,
    draftConversationId: visibleState.detail?.conversation.id ?? conversationId,
    continuingNewConversation,
    send,
    busy: isChatBusy(visibleState.phase),
    loading: view === 'opening',
    error: query.error,
    reload: () => query.refetch(),
    retry: () => controller.retry(),
    stop: () => controller.stop(),
  };
}
