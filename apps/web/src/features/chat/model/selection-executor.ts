import type { ChatApi } from '@cheapai/api-client/chat';
import type { ConversationDetail } from '@cheapai/contracts/chat';
import { mergeConversationDetail } from './reconcile';
import { asChatFailure, isKnownWriteRejection } from './operation-executor';
import type { ChatEvent } from './state';

export type ChatSelectionResult = 'selected' | 'interrupted' | 'rejected' | 'superseded';

export interface ChatSelectionExecutorContext {
  readonly api: ChatApi;
  readonly commandId: string;
  readonly conversationId: string;
  readonly input: { readonly conversationVersion: number; readonly messageId: string };
  readonly isCurrent: () => boolean;
  readonly currentDetail: () => ConversationDetail | null;
  readonly dispatch: (event: ChatEvent) => void;
  readonly onDetailConfirmed?: (detail: ConversationDetail) => void | Promise<void>;
}

function selectionIsConfirmed(
  detail: ConversationDetail,
  conversationId: string,
  messageId: string,
  minimumVersion: number,
): boolean {
  return (
    detail.conversation.id === conversationId &&
    detail.conversation.version >= minimumVersion &&
    detail.messages.some(
      (message) => message.id === messageId && message.role === 'assistant' && message.selected,
    )
  );
}

export async function executeChatSelection(
  context: ChatSelectionExecutorContext,
): Promise<ChatSelectionResult> {
  const { api, commandId, conversationId, input } = context;
  const minimumVersion = input.conversationVersion + 1;

  async function confirm(detail: ConversationDetail): Promise<ChatSelectionResult> {
    if (!context.isCurrent()) return 'superseded';
    if (!selectionIsConfirmed(detail, conversationId, input.messageId, minimumVersion)) {
      context.dispatch({
        type: 'interrupted',
        operationId: commandId,
        failure: { kind: 'interrupted', message: '版本切换结果尚未确认，请重新读取对话后再选择。' },
      });
      return 'interrupted';
    }
    const current = context.currentDetail();
    const latest = mergeConversationDetail(
      current?.conversation.id === detail.conversation.id ? current : null,
      detail,
    );
    context.dispatch({
      type: 'settled',
      operationId: commandId,
      outcome: 'completed',
      detail: latest,
    });
    try {
      await context.onDetailConfirmed?.(latest);
    } catch {
      /* Cache writes are advisory. */
    }
    return 'selected';
  }

  try {
    const detail = await api.selectVersion(conversationId, input);
    if (!context.isCurrent()) return 'superseded';
    if (selectionIsConfirmed(detail, conversationId, input.messageId, minimumVersion))
      return confirm(detail);
    const latest = await api.getConversation(conversationId);
    return confirm(latest);
  } catch (cause) {
    if (!context.isCurrent()) return 'superseded';
    if (isKnownWriteRejection(cause, false)) {
      context.dispatch({
        type: 'failed',
        operationId: commandId,
        failure: asChatFailure(cause, 'rejected'),
      });
      return 'rejected';
    }
    try {
      const latest = await api.getConversation(conversationId);
      if (!context.isCurrent()) return 'superseded';
      if (selectionIsConfirmed(latest, conversationId, input.messageId, minimumVersion))
        return confirm(latest);
    } catch {
      /* The selection response and follow-up read were both inconclusive. */
    }
    context.dispatch({
      type: 'interrupted',
      operationId: commandId,
      failure: asChatFailure(cause, 'interrupted'),
    });
    return 'interrupted';
  }
}
