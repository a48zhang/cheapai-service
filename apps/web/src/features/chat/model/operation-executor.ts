import { ApiClientError } from '@cheapai/api-client/errors';
import type { ChatApi, ChatStreamHandlers } from '@cheapai/api-client/chat';
import type {
  ChatErrorEvent,
  ChatMessage,
  ChatSendResult,
  ConversationDetail,
} from '@cheapai/contracts/chat';
import {
  markOperationAccepted,
  markOperationInFlight,
  markOperationRejected,
  markOperationSettled,
  markOperationUnknown,
} from './operation';
import type { ChatWriteOperation } from './operation';
import {
  findOperationAssistant,
  inspectOperationSnapshot,
  mergeConversationDetail,
  snapshotConfirmsVersion,
} from './reconcile';
import type { ChatSnapshotOutcome } from './reconcile';
import type { ChatEvent, ChatFailure } from './state';

export type ChatOperationResult =
  'completed' | 'stopped' | 'failed' | 'rejected' | 'interrupted' | 'superseded';

export interface ChatOperationRun {
  readonly commandId: string;
  readonly abortController: AbortController;
  operation: ChatWriteOperation | null;
  terminalMessage: ChatMessage | null;
  streamError: ChatErrorEvent | null;
}

export interface ChatOperationExecutorContext {
  readonly api: ChatApi;
  readonly run: ChatOperationRun;
  readonly prepared: ChatWriteOperation;
  readonly retry: boolean;
  readonly isCurrent: () => boolean;
  readonly currentDetail: () => ConversationDetail | null;
  readonly dispatch: (event: ChatEvent) => void;
  readonly rememberPending: (operation: ChatWriteOperation) => void;
  readonly forgetPending: (operation: ChatWriteOperation) => void;
  readonly onDetailConfirmed?: (detail: ConversationDetail) => void | Promise<void>;
}

const reconcileDelays = [100, 250, 500] as const;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

export function asChatFailure(cause: unknown, kind: ChatFailure['kind']): ChatFailure {
  if (cause instanceof ApiClientError) return { kind, message: cause.message, code: cause.code };
  return { kind, message: cause instanceof Error ? cause.message : '聊天请求失败。' };
}

export function isKnownWriteRejection(cause: unknown, accepted: boolean): boolean {
  if (accepted) return false;
  if (!(cause instanceof ApiClientError)) return false;
  if (cause.kind === 'request') return true;
  if (cause.kind === 'api') {
    return [
      'invalid_request',
      'unauthorized',
      'forbidden',
      'not_found',
      'conflict',
      'payload_too_large',
      'rate_limited',
      'insufficient_balance',
    ].includes(cause.code);
  }
  return (
    cause.status === 401 ||
    cause.status === 403 ||
    cause.status === 404 ||
    cause.status === 409 ||
    cause.status === 413 ||
    cause.status === 422
  );
}

async function reconcileFinalSnapshot(
  context: ChatOperationExecutorContext,
  initialOperation: ChatWriteOperation,
  replayDetail: ConversationDetail | null,
  isReplay: boolean,
  failure: ChatFailure | null,
): Promise<ChatOperationResult> {
  const { run } = context;
  let operation = initialOperation;
  if (isReplay && replayDetail) {
    const replayedMessage = findOperationAssistant(replayDetail, {
      operation,
      belongsToOperation: true,
    });
    if (replayedMessage) {
      operation = markOperationAccepted(operation, {
        id: replayedMessage.id,
        requestId: replayedMessage.requestId,
      });
      run.operation = operation;
      context.rememberPending(operation);
    }
  }

  const expectedVersion = operation.input.conversationVersion + 1;
  let lastOutcome: ChatSnapshotOutcome = 'unconfirmed';
  let latest: ConversationDetail | null = replayDetail;
  for (let attempt = 0; attempt <= reconcileDelays.length; attempt += 1) {
    if (attempt > 0) await delay(reconcileDelays[attempt - 1]!);
    if (!context.isCurrent()) return 'superseded';
    let fetched: ConversationDetail;
    try {
      fetched = await context.api.getConversation(operation.conversationId);
    } catch {
      if (!context.isCurrent()) return 'superseded';
      continue;
    }
    if (!context.isCurrent()) return 'superseded';
    const current = context.currentDetail();
    latest = mergeConversationDetail(
      current?.conversation.id === fetched.conversation.id ? current : latest,
      fetched,
    );
    const proof = {
      operation,
      ...(operation.assistantMessageId === null
        ? {}
        : { assistantMessageId: operation.assistantMessageId }),
    };
    lastOutcome = inspectOperationSnapshot(fetched, proof);
    if (
      (lastOutcome === 'completed' || lastOutcome === 'stopped' || lastOutcome === 'failed') &&
      snapshotConfirmsVersion(fetched, expectedVersion)
    ) {
      operation = markOperationSettled(operation);
      run.operation = operation;
      context.forgetPending(operation);
      const outcome = lastOutcome;
      const terminalFailure =
        outcome === 'failed'
          ? (failure ??
            (run.streamError
              ? {
                  kind: 'failed' as const,
                  message: run.streamError.message,
                  code: run.streamError.code,
                }
              : { kind: 'failed' as const, message: '回答未能完成。' }))
          : undefined;
      context.dispatch({
        type: 'settled',
        operationId: operation.operationId,
        outcome,
        detail: latest,
        ...(terminalFailure === undefined ? {} : { failure: terminalFailure }),
      });
      try {
        await context.onDetailConfirmed?.(latest);
      } catch {
        /* Cache writes/navigation are advisory. */
      }
      return outcome;
    }
    if (lastOutcome !== 'pending') break;
  }

  operation = markOperationUnknown(operation);
  run.operation = operation;
  context.rememberPending(operation);
  context.dispatch({
    type: 'interrupted',
    operationId: operation.operationId,
    failure: failure ?? {
      kind: 'interrupted',
      message: '连接已中断，服务端结果尚未确认。可使用原操作重试。',
    },
  });
  return 'interrupted';
}

export async function executeChatOperation(
  context: ChatOperationExecutorContext,
): Promise<ChatOperationResult> {
  const { api, run } = context;
  let operation = markOperationInFlight(context.prepared, context.retry);
  run.operation = operation;
  context.rememberPending(operation);
  context.dispatch({ type: 'submitting', operationId: operation.operationId });

  const handlers: ChatStreamHandlers = {
    onMeta: (value) => {
      if (!context.isCurrent()) return;
      operation = markOperationAccepted(operation, {
        id: value.assistantMessage.id,
        requestId: value.assistantMessage.requestId,
      });
      run.operation = operation;
      context.rememberPending(operation);
      const current = context.currentDetail();
      const meta =
        current?.conversation.id === value.conversation.id &&
        current.conversation.version > value.conversation.version
          ? { ...value, conversation: current.conversation }
          : value;
      context.dispatch({ type: 'meta', operationId: operation.operationId, value: meta });
    },
    onDelta: (text) =>
      context.dispatch({ type: 'delta', operationId: operation.operationId, text }),
    onDone: (message, billingStatus) => {
      if (!context.isCurrent()) return;
      run.terminalMessage = message;
      operation = markOperationAccepted(operation, {
        id: message.id,
        requestId: message.requestId,
      });
      run.operation = operation;
      context.rememberPending(operation);
      context.dispatch({
        type: 'done',
        operationId: operation.operationId,
        value: { message, ...(billingStatus === undefined ? {} : { billingStatus }) },
      });
    },
    onError: (event: ChatErrorEvent) => {
      if (!context.isCurrent()) return;
      run.streamError = event;
      if (event.messageId) {
        operation = markOperationAccepted(operation, {
          id: event.messageId,
          requestId: operation.requestId,
        });
        run.operation = operation;
        context.rememberPending(operation);
      }
    },
  };

  try {
    const result: ChatSendResult =
      operation.kind === 'send'
        ? await api.sendMessage(
            operation.conversationId,
            operation.input,
            handlers,
            run.abortController.signal,
          )
        : await api.regenerate(
            operation.conversationId,
            operation.input,
            handlers,
            run.abortController.signal,
          );
    if (!context.isCurrent()) return 'superseded';
    let replayDetail: ConversationDetail | null = null;
    let replay = false;
    if (result.kind === 'replay') {
      replay = true;
      replayDetail = { conversation: result.conversation, messages: result.messages };
      const message = findOperationAssistant(replayDetail, { operation, belongsToOperation: true });
      if (message) {
        operation = markOperationAccepted(operation, {
          id: message.id,
          requestId: message.requestId,
        });
        run.operation = operation;
        context.rememberPending(operation);
      }
    } else {
      run.terminalMessage = result.message;
      operation = markOperationAccepted(operation, {
        id: result.message.id,
        requestId: result.message.requestId,
      });
      run.operation = operation;
      context.rememberPending(operation);
      context.dispatch({
        type: 'done',
        operationId: operation.operationId,
        value: {
          message: result.message,
          ...(result.billingStatus === undefined ? {} : { billingStatus: result.billingStatus }),
        },
      });
    }
    context.dispatch({ type: 'finalizing', operationId: operation.operationId });
    const failure = run.streamError
      ? { kind: 'failed' as const, message: run.streamError.message, code: run.streamError.code }
      : null;
    return reconcileFinalSnapshot(context, operation, replayDetail, replay, failure);
  } catch (cause) {
    if (!context.isCurrent()) return 'superseded';
    const accepted =
      operation.state === 'accepted' ||
      operation.assistantMessageId !== null ||
      run.terminalMessage !== null;
    if (isKnownWriteRejection(cause, accepted)) {
      operation = markOperationRejected(operation);
      run.operation = operation;
      context.forgetPending(operation);
      context.dispatch({
        type: 'failed',
        operationId: operation.operationId,
        failure: asChatFailure(cause, 'rejected'),
      });
      return 'rejected';
    }
    operation = markOperationUnknown(operation);
    run.operation = operation;
    context.rememberPending(operation);
    context.dispatch({ type: 'finalizing', operationId: operation.operationId });
    const failure = run.streamError
      ? { kind: 'failed' as const, message: run.streamError.message, code: run.streamError.code }
      : asChatFailure(cause, 'interrupted');
    return reconcileFinalSnapshot(context, operation, null, false, failure);
  }
}
