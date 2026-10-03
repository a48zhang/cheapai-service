import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '../../session/public';
import { createChatFeatureApi, chatConversationDetailQueryOptions, type ChatApiContext } from '../api';
import { chatQueryKeys } from '../query-keys';
import { createChatController, type ChatSendCommand } from '../model/controller';
import { isChatBusy } from '../model/state';

export interface UseChatControllerOptions {
  context: ChatApiContext;
  conversationId: string | null;
  onConversationCreated: (id: string) => void;
  onDraftRestore: (content: string, userId: string) => void;
}
export function useChatController(options: UseChatControllerOptions) {
  const { session, queryClient, expiry } = useSession();
  const { context, conversationId } = options;
  const callbacks = useRef(options);
  callbacks.current = options;
  const pendingDraft = useRef<{ content: string; userId: string } | null>(null);
  const api = useMemo(() => createChatFeatureApi(context), [context]);
  const controller = useMemo(() => createChatController({
    api, getOwner: session.requestIdentity,
    onConversationCreated: conversation => {
      callbacks.current.onConversationCreated(conversation.id);
      void queryClient.invalidateQueries({ queryKey: chatQueryKeys.lists(context.userId, context.epoch) });
    },
    onDetailConfirmed: detail => {
      queryClient.setQueryData(chatQueryKeys.detail(context.userId, context.epoch, detail.conversation.id), detail);
      void queryClient.invalidateQueries({ queryKey: chatQueryKeys.lists(context.userId, context.epoch) });
    },
  }), [api, session, queryClient, context.userId, context.epoch]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const query = useQuery(chatConversationDetailQueryOptions(context, conversationId ?? ''));
  const lifetimes = useRef(new Map<typeof controller, number>());
  useEffect(() => {
    const counts = lifetimes.current;
    counts.set(controller, (counts.get(controller) ?? 0) + 1);
    return () => {
      counts.set(controller, (counts.get(controller) ?? 1) - 1);
      // StrictMode immediately reattaches this same instance; actual unmount disposes it.
      queueMicrotask(() => { if (counts.get(controller) === 0) { controller.dispose(); counts.delete(controller); } });
    };
  }, [controller]);
  useEffect(() => {
    if (conversationId === null) {
      if (controller.getSnapshot().detail !== null) controller.hydrate(null);
    } else if (controller.getSnapshot().detail?.conversation.id !== conversationId) {
      void controller.loadConversation(conversationId);
    }
  }, [controller, conversationId]);
  useEffect(() => { if (query.data && query.data.conversation.id === conversationId) controller.hydrate(query.data); }, [controller, query.data, conversationId]);
  useEffect(() => {
    const pending = pendingDraft.current;
    if (expiry && pending?.userId === expiry.userId) callbacks.current.onDraftRestore(pending.content, pending.userId);
  }, [expiry]);

  const send = useCallback(async (command: ChatSendCommand) => {
    if (isChatBusy(controller.getSnapshot().phase)) return 'busy' as const;
    const owner = session.requestIdentity();
    if (!owner) return 'superseded' as const;
    pendingDraft.current = { content: command.content, userId: owner.userId };
    const result = await controller.send(command);
    if (result === 'rejected' && session.requestIdentity()?.userId === owner.userId) callbacks.current.onDraftRestore(command.content, owner.userId);
    if (result === 'completed' || result === 'stopped' || result === 'failed') pendingDraft.current = null;
    return result;
  }, [controller, session]);
  return { controller, state, send, busy: isChatBusy(state.phase), loading: conversationId !== null && query.isPending, error: query.error,
    reload: () => query.refetch(), retry: () => controller.retry(), stop: () => controller.stop() };
}
