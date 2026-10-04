import { ApiClientError } from '@cheapai/api-client/errors';
import { chatRegenerateInputSchema, chatSendInputSchema } from '@cheapai/contracts/chat';
import type {
  ChatErrorEvent,
  ChatMessage,
  Conversation,
  ConversationDetail,
} from '@cheapai/contracts/chat';
import type { ChatApi } from '@cheapai/api-client/chat';
import {
  canRetryOperation,
  createChatOperationId,
  markOperationUnknown,
  prepareRegenerateOperation,
  prepareSendOperation,
} from './operation';
import type { ChatOperationOwner, ChatRegenerateOperation, ChatWriteOperation } from './operation';
import { prepareRegenerateCommand, prepareSelectVersionCommand } from './regenerate';
import type { RegenerateCommand } from './regenerate';
import { mergeConversationDetail } from './reconcile';
import {
  forgetPendingOperation,
  getPendingOperation,
  ownerKey,
  rememberPendingOperation,
} from './pending-registry';
import { asChatFailure, executeChatOperation } from './operation-executor';
import { executeChatSelection } from './selection-executor';
import { chatReducer } from './reducer';
import { initialChatState } from './state';
import type { ChatEvent, ChatState } from './state';

export interface ChatSendCommand {
  readonly content: string;
  readonly groupId: string;
  readonly modelId: string;
}

export type ChatRegenerateCommand = RegenerateCommand;

export type ChatCommandResult =
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'rejected'
  | 'interrupted'
  | 'busy'
  | 'idle'
  | 'superseded'
  | 'disposed'
  | 'selected';

export interface ChatControllerOptions {
  readonly api: ChatApi;
  readonly getOwner: () => ChatOperationOwner | null;
  readonly subscribeOwner?: (listener: () => void) => () => void;
  readonly conversationId?: string | null;
  readonly initialDetail?: ConversationDetail | null;
  readonly idFactory?: () => string;
  readonly onConversationCreated?: (conversation: Conversation) => void | Promise<void>;
  readonly onDetailConfirmed?: (detail: ConversationDetail) => void | Promise<void>;
}

interface ActiveRun {
  readonly commandId: string;
  readonly commandKind: 'send' | 'regenerate' | 'select';
  readonly owner: ChatOperationOwner;
  readonly abortController: AbortController;
  readonly routeEpoch: number;
  operation: ChatWriteOperation | null;
  conversationId: string | null;
  stopRequested: boolean;
  disposeRequested: boolean;
  identityChanged: boolean;
  terminalMessage: ChatMessage | null;
  streamError: ChatErrorEvent | null;
  promise: Promise<ChatCommandResult> | null;
}

const operationIdentifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

function samePrincipal(left: ChatOperationOwner, right: ChatOperationOwner | null): boolean {
  return right !== null && left.userId === right.userId;
}

function operationBelongsToPrincipal(
  operation: ChatWriteOperation,
  owner: ChatOperationOwner,
  conversationId: string,
): boolean {
  return operation.owner.userId === owner.userId && operation.conversationId === conversationId;
}

function takeOverOperation(
  operation: ChatWriteOperation,
  owner: ChatOperationOwner,
): ChatWriteOperation {
  return Object.freeze({
    ...operation,
    owner: Object.freeze({ ...owner }),
    state: 'unknown' as const,
  });
}

function sameOwner(left: ChatOperationOwner, right: ChatOperationOwner | null): boolean {
  return right !== null && left.userId === right.userId && left.epoch === right.epoch;
}

function createResultMayBeUnknown(cause: unknown): boolean {
  if (!(cause instanceof ApiClientError)) return true;
  if (cause.kind === 'request') return false;
  if (cause.kind === 'network' || cause.kind === 'invalid_response' || cause.kind === 'aborted')
    return true;
  if (cause.kind === 'api') {
    return (
      cause.status === null ||
      cause.status >= 500 ||
      cause.code === 'internal_error' ||
      cause.code === 'service_unavailable'
    );
  }
  return cause.status === null || cause.status >= 500;
}

function validSendCommand(command: ChatSendCommand, operationId: string): boolean {
  if (!operationIdentifier.test(operationId)) return false;
  return chatSendInputSchema.safeParse({
    operationId,
    conversationVersion: 1,
    groupId: command.groupId,
    modelId: command.modelId,
    content: command.content,
  }).success;
}

export function createChatController(options: ChatControllerOptions) {
  let state: ChatState = initialChatState;
  const listeners = new Set<() => void>();
  let activeConversationId =
    options.conversationId ?? options.initialDetail?.conversation.id ?? null;
  let activeRun: ActiveRun | null = null;
  let pendingOperation: ChatWriteOperation | null = null;
  let loadEpoch = 0;
  let disposed = false;
  let observedOwner = ownerKey(options.getOwner());

  if (options.initialDetail)
    state = chatReducer(state, { type: 'hydrate', detail: options.initialDetail });

  function notify(): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* One subscriber must not block the rest. */
      }
    }
  }

  function dispatch(event: ChatEvent): void {
    if (disposed) return;
    const next = chatReducer(state, event);
    if (next === state) return;
    state = next;
    notify();
  }

  function rememberPending(operation: ChatWriteOperation): void {
    pendingOperation = operation;
    rememberPendingOperation(operation);
  }

  function forgetPending(operation: ChatWriteOperation): void {
    if (pendingOperation?.operationId === operation.operationId) pendingOperation = null;
    forgetPendingOperation(operation);
  }

  function isRunCurrent(run: ActiveRun): boolean {
    return (
      activeRun === run &&
      run.routeEpoch === loadEpoch &&
      !run.identityChanged &&
      sameOwner(run.owner, options.getOwner())
    );
  }

  function canDispatchForRun(run: ActiveRun): boolean {
    return !disposed && isRunCurrent(run);
  }

  function restorePendingForConversation(conversationId: string, owner: ChatOperationOwner): void {
    let pending = pendingOperation;
    if (!pending || !operationBelongsToPrincipal(pending, owner, conversationId)) {
      pending = getPendingOperation(owner, conversationId);
    }
    if (!pending || !operationBelongsToPrincipal(pending, owner, conversationId)) return;
    if (pending.state === 'in-flight') pending = markOperationUnknown(pending);
    if (!canRetryOperation(pending)) return;
    rememberPending(pending);
    dispatch({
      type: 'begin',
      operationId: pending.operationId,
      operationKind: pending.kind,
      needsConversation: false,
    });
    dispatch({
      type: 'interrupted',
      operationId: pending.operationId,
      failure: { kind: 'interrupted', message: '上次请求的结果尚未确认，可使用原操作安全重试。' },
    });
  }

  function release(run: ActiveRun): void {
    if (activeRun === run) activeRun = null;
  }

  function makeRun(
    owner: ChatOperationOwner,
    commandId: string,
    commandKind: ActiveRun['commandKind'],
  ): ActiveRun {
    return {
      commandId,
      commandKind,
      owner: Object.freeze({ ...owner }),
      abortController: new AbortController(),
      routeEpoch: loadEpoch,
      operation: null,
      conversationId: activeConversationId,
      stopRequested: false,
      disposeRequested: false,
      identityChanged: false,
      terminalMessage: null,
      streamError: null,
      promise: null,
    };
  }

  async function finishBeforeSend(
    run: ActiveRun,
    cause: unknown,
    ambiguousCreate = false,
  ): Promise<ChatCommandResult> {
    if (!isRunCurrent(run)) return 'superseded';
    const failure = ambiguousCreate
      ? {
          kind: 'failed' as const,
          code: 'conversation_creation_unknown',
          message:
            '会话创建结果暂时无法确认。请刷新会话列表核对是否已创建；若不存在，再明确新建会话。',
        }
      : asChatFailure(cause, 'rejected');
    if (canDispatchForRun(run)) {
      dispatch({ type: 'failed', operationId: run.commandId, failure });
    }
    return ambiguousCreate ? 'interrupted' : 'rejected';
  }

  function performOperation(
    run: ActiveRun,
    prepared: ChatWriteOperation,
    retry: boolean,
  ): Promise<ChatCommandResult> {
    return executeChatOperation({
      api: options.api,
      run,
      prepared,
      retry,
      isCurrent: () => isRunCurrent(run),
      currentDetail: () => state.detail,
      dispatch: (event) => {
        if (canDispatchForRun(run)) dispatch(event);
      },
      rememberPending,
      forgetPending,
      ...(options.onDetailConfirmed === undefined
        ? {}
        : { onDetailConfirmed: options.onDetailConfirmed }),
    });
  }

  async function performSend(run: ActiveRun, command: ChatSendCommand): Promise<ChatCommandResult> {
    if (!validSendCommand(command, run.commandId)) {
      return finishBeforeSend(run, new ApiClientError('request', '聊天请求参数无效。'));
    }
    if (run.abortController.signal.aborted) {
      if (canDispatchForRun(run)) {
        if (state.detail)
          dispatch({
            type: 'settled',
            operationId: run.commandId,
            outcome: 'stopped',
            detail: state.detail,
          });
        else dispatch({ type: 'reset' });
      }
      return run.disposeRequested ? 'interrupted' : 'stopped';
    }

    let detail: ConversationDetail | null = null;
    const requestedId = activeConversationId;
    if (requestedId) {
      detail = state.detail?.conversation.id === requestedId ? state.detail : null;
      if (!detail) return 'busy';
    } else {
      try {
        const conversation = await options.api.createConversation({
          groupId: command.groupId,
          modelId: command.modelId,
        });
        if (!isRunCurrent(run)) return 'superseded';
        run.conversationId = conversation.id;
        detail = { conversation, messages: [] };
        if (run.abortController.signal.aborted) {
          const sameRoute = run.routeEpoch === loadEpoch;
          if (sameRoute) activeConversationId = conversation.id;
          if (sameRoute && canDispatchForRun(run)) {
            dispatch({ type: 'conversation-created', operationId: run.commandId, conversation });
            try {
              await options.onConversationCreated?.(conversation);
            } catch {
              /* URL/cache integration cannot block the stopped send result. */
            }
            if (canDispatchForRun(run)) {
              dispatch({
                type: 'settled',
                operationId: run.commandId,
                outcome: 'stopped',
                detail,
              });
            }
          }
          return run.disposeRequested ? 'interrupted' : 'stopped';
        }
        if (run.routeEpoch !== loadEpoch) return run.stopRequested ? 'stopped' : 'superseded';
        activeConversationId = conversation.id;
        if (canDispatchForRun(run))
          dispatch({ type: 'conversation-created', operationId: run.commandId, conversation });
        try {
          await options.onConversationCreated?.(conversation);
        } catch {
          /* URL/cache integration cannot block sending. */
        }
      } catch (cause) {
        if (!isRunCurrent(run)) return 'superseded';
        return finishBeforeSend(run, cause, createResultMayBeUnknown(cause));
      }
    }

    if (!detail || !isRunCurrent(run)) return 'superseded';
    if (run.abortController.signal.aborted) {
      if (canDispatchForRun(run)) {
        dispatch({ type: 'settled', operationId: run.commandId, outcome: 'stopped', detail });
      }
      return run.disposeRequested ? 'interrupted' : 'stopped';
    }
    const operation = prepareSendOperation({
      owner: run.owner,
      conversationId: detail.conversation.id,
      conversationVersion: detail.conversation.version,
      groupId: command.groupId,
      modelId: command.modelId,
      content: command.content,
      baselineMessageIds: detail.messages.map((message) => message.id),
      operationId: run.commandId,
    });
    run.operation = operation;
    run.conversationId = operation.conversationId;
    if (canDispatchForRun(run)) {
      dispatch({
        type: 'begin',
        operationId: operation.operationId,
        operationKind: 'send',
        needsConversation: false,
      });
    }
    return performOperation(run, operation, false);
  }

  function execute(
    run: ActiveRun,
    work: () => Promise<ChatCommandResult>,
  ): Promise<ChatCommandResult> {
    const task = work().catch((cause) => {
      if (!run.operation) return finishBeforeSend(run, cause);
      const operation = markOperationUnknown(run.operation);
      run.operation = operation;
      rememberPending(operation);
      if (canDispatchForRun(run)) {
        dispatch({
          type: 'interrupted',
          operationId: operation.operationId,
          failure: asChatFailure(cause, 'interrupted'),
        });
      }
      return 'interrupted' as const;
    });
    const settled = task.finally(() => release(run));
    run.promise = settled;
    return settled;
  }

  function send(command: ChatSendCommand): Promise<ChatCommandResult> {
    if (disposed) return Promise.resolve('disposed');
    if (activeRun) return Promise.resolve('busy');
    if (state.failure?.code === 'conversation_creation_unknown')
      return Promise.resolve('interrupted');
    if (activeConversationId !== null && state.detail?.conversation.id !== activeConversationId) {
      // The route Query has not supplied this conversation yet. It is the sole ordinary detail reader.
      return Promise.resolve('busy');
    }
    const owner = options.getOwner();
    if (!owner) return Promise.resolve('rejected');
    const pending = activeConversationId
      ? (getPendingOperation(owner, activeConversationId) ??
        (pendingOperation &&
        operationBelongsToPrincipal(pendingOperation, owner, activeConversationId)
          ? pendingOperation
          : null))
      : null;
    if (pending) {
      pendingOperation = pending;
      return Promise.resolve(canRetryOperation(pending) ? 'interrupted' : 'busy');
    }
    const commandId = options.idFactory?.() ?? createChatOperationId();
    if (!operationIdentifier.test(commandId)) {
      return Promise.resolve('rejected');
    }
    const run = makeRun(owner, commandId, 'send');
    activeRun = run;
    const needsConversation = activeConversationId === null;
    dispatch({
      type: 'begin',
      operationId: commandId,
      operationKind: 'send',
      needsConversation,
    });
    return execute(run, () => performSend(run, command));
  }

  function regenerate(command: ChatRegenerateCommand): Promise<ChatCommandResult> {
    if (disposed) return Promise.resolve('disposed');
    if (activeRun) return Promise.resolve('busy');
    const owner = options.getOwner();
    if (!owner) return Promise.resolve('rejected');
    const detail = state.detail;
    if (!detail || detail.conversation.id !== activeConversationId)
      return Promise.resolve('rejected');
    const existing = getPendingOperation(owner, detail.conversation.id) ?? pendingOperation;
    if (existing && operationBelongsToPrincipal(existing, owner, detail.conversation.id)) {
      pendingOperation = existing;
      return Promise.resolve(canRetryOperation(existing) ? 'interrupted' : 'busy');
    }
    const commandId = options.idFactory?.() ?? createChatOperationId();
    if (!operationIdentifier.test(commandId)) return Promise.resolve('rejected');
    const prepared = prepareRegenerateCommand(detail, command, commandId);
    if (!prepared.accepted || !chatRegenerateInputSchema.safeParse(prepared.input).success) {
      return Promise.resolve('rejected');
    }
    const operation: ChatRegenerateOperation = prepareRegenerateOperation({
      owner,
      conversationId: detail.conversation.id,
      conversationVersion: prepared.input.conversationVersion,
      groupId: prepared.input.groupId,
      modelId: prepared.input.modelId,
      previousMessageId: prepared.previousMessageId,
      baselineMessageIds: detail.messages.map((message) => message.id),
      operationId: commandId,
    });
    if (!chatRegenerateInputSchema.safeParse(operation.input).success)
      return Promise.resolve('rejected');
    const run = makeRun(owner, commandId, 'regenerate');
    run.operation = operation;
    run.conversationId = detail.conversation.id;
    activeRun = run;
    dispatch({
      type: 'begin',
      operationId: commandId,
      operationKind: 'regenerate',
      needsConversation: false,
    });
    return execute(run, () => performOperation(run, operation, false));
  }

  function selectVersion(messageId: string): Promise<ChatCommandResult> {
    if (disposed) return Promise.resolve('disposed');
    if (activeRun) return Promise.resolve('busy');
    const owner = options.getOwner();
    const detail = state.detail;
    if (!owner || !detail || detail.conversation.id !== activeConversationId)
      return Promise.resolve('rejected');
    const pending = getPendingOperation(owner, detail.conversation.id) ?? pendingOperation;
    if (pending && operationBelongsToPrincipal(pending, owner, detail.conversation.id)) {
      pendingOperation = pending;
      return Promise.resolve(canRetryOperation(pending) ? 'interrupted' : 'busy');
    }
    const prepared = prepareSelectVersionCommand(detail, messageId);
    if (!prepared.accepted) return Promise.resolve('rejected');
    const commandId = options.idFactory?.() ?? createChatOperationId();
    if (!operationIdentifier.test(commandId)) return Promise.resolve('rejected');
    const run = makeRun(owner, commandId, 'select');
    run.conversationId = detail.conversation.id;
    activeRun = run;
    dispatch({
      type: 'begin',
      operationId: commandId,
      operationKind: 'select',
      needsConversation: false,
    });
    return execute(run, () =>
      executeChatSelection({
        api: options.api,
        commandId: run.commandId,
        conversationId: detail.conversation.id,
        input: prepared.input,
        isCurrent: () => isRunCurrent(run),
        currentDetail: () => state.detail,
        dispatch: (event) => {
          if (canDispatchForRun(run)) dispatch(event);
        },
        ...(options.onDetailConfirmed === undefined
          ? {}
          : { onDetailConfirmed: options.onDetailConfirmed }),
      }),
    );
  }

  function retry(): Promise<ChatCommandResult> {
    if (disposed) return Promise.resolve('disposed');
    if (activeRun) return Promise.resolve('busy');
    const owner = options.getOwner();
    const conversationId = activeConversationId;
    if (!owner || !conversationId) return Promise.resolve('idle');
    const storedOperation = getPendingOperation(owner, conversationId);
    const candidate =
      pendingOperation && operationBelongsToPrincipal(pendingOperation, owner, conversationId)
        ? pendingOperation
        : (storedOperation ?? null);
    if (
      !candidate ||
      !canRetryOperation(candidate) ||
      !operationBelongsToPrincipal(candidate, owner, conversationId)
    )
      return Promise.resolve('idle');
    const operation =
      candidate.owner.epoch === owner.epoch ? candidate : takeOverOperation(candidate, owner);
    rememberPending(operation);
    const run = makeRun(owner, operation.operationId, operation.kind);
    run.operation = operation;
    run.conversationId = operation.conversationId;
    activeRun = run;
    dispatch({
      type: 'begin',
      operationId: operation.operationId,
      operationKind: operation.kind,
      needsConversation: false,
    });
    return execute(run, () => performOperation(run, operation, true));
  }

  function stop(): Promise<ChatCommandResult> {
    const run = activeRun;
    if (!run) return Promise.resolve('idle');
    if (run.commandKind === 'select') return Promise.resolve('busy');
    if (run.stopRequested) return run.promise ?? Promise.resolve('busy');
    run.stopRequested = true;
    if (canDispatchForRun(run)) dispatch({ type: 'stop-requested', operationId: run.commandId });
    run.abortController.abort();
    return run.promise ?? Promise.resolve('busy');
  }

  function cancelRunForRouteChange(): void {
    const run = activeRun;
    if (!run) return;
    if (run.operation) {
      const unknown = markOperationUnknown(run.operation);
      run.operation = unknown;
      rememberPending(unknown);
    }
    activeRun = null;
    run.abortController.abort();
  }

  function syncConversation(conversationId: string | null): void {
    if (disposed) return;
    if (conversationId === activeConversationId) {
      const owner = options.getOwner();
      if (conversationId && owner && !activeRun)
        restorePendingForConversation(conversationId, owner);
      return;
    }
    loadEpoch += 1;
    cancelRunForRouteChange();
    activeConversationId = conversationId;
    dispatch({ type: 'reset' });
    const owner = options.getOwner();
    if (conversationId && owner) restorePendingForConversation(conversationId, owner);
  }

  function hydrate(detail: ConversationDetail | null): void {
    if (detail === null) {
      syncConversation(null);
      return;
    }
    if (disposed || detail.conversation.id !== activeConversationId) return;
    const current = state.detail?.conversation.id === detail.conversation.id ? state.detail : null;
    const latest = mergeConversationDetail(current, detail);
    if (latest !== current) {
      state = { ...state, detail: latest };
      notify();
    }
    const owner = options.getOwner();
    if (
      owner &&
      !(activeRun?.conversationId === detail.conversation.id && activeRun.routeEpoch === loadEpoch)
    ) {
      restorePendingForConversation(detail.conversation.id, owner);
    }
  }

  function resetConversation(): void {
    if (disposed) return;
    loadEpoch += 1;
    cancelRunForRouteChange();
    activeConversationId = null;
    dispatch({ type: 'reset' });
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function identityChanged(): void {
    const currentOwner = options.getOwner();
    const nextOwner = ownerKey(currentOwner);
    if (nextOwner === observedOwner) return;
    observedOwner = nextOwner;
    const run = activeRun;
    if (run) {
      run.identityChanged = true;
      if (run.operation) {
        const unknown = markOperationUnknown(run.operation);
        run.operation = unknown;
        rememberPending(unknown);
      }
      run.abortController.abort();
      activeRun = null;
    }
    if (pendingOperation && !samePrincipal(pendingOperation.owner, currentOwner))
      pendingOperation = null;
    if (!disposed) {
      state = initialChatState;
      notify();
    }
  }

  const unsubscribeOwner = options.subscribeOwner?.(identityChanged);
  const initialOwner = options.getOwner();
  if (options.initialDetail && initialOwner) {
    restorePendingForConversation(options.initialDetail.conversation.id, initialOwner);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    unsubscribeOwner?.();
    const run = activeRun;
    if (run) {
      run.disposeRequested = true;
      if (run.operation) {
        const unknown = markOperationUnknown(run.operation);
        run.operation = unknown;
        rememberPending(unknown);
      }
      run.abortController.abort();
    }
    listeners.clear();
  }

  return Object.freeze({
    getSnapshot: () => state,
    getConversationId: () => activeConversationId,
    subscribe,
    syncConversation,
    identityChanged,
    hydrate,
    resetConversation,
    send,
    regenerate,
    selectVersion,
    stop,
    retry,
    dispose,
  });
}

export type ChatController = ReturnType<typeof createChatController>;
