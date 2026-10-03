import { ApiClientError } from '@cheapai/api-client/errors';
import { chatRegenerateInputSchema, chatSendInputSchema } from '@cheapai/contracts/chat';
import type {
  ChatErrorEvent,
  ChatMessage,
  ChatSendResult,
  Conversation,
  ConversationDetail,
} from '@cheapai/contracts/chat';
import type { ChatApi, ChatStreamHandlers } from '@cheapai/api-client/chat';
import {
  canRetryOperation,
  createChatOperationId,
  markOperationAccepted,
  markOperationInFlight,
  markOperationRejected,
  markOperationSettled,
  markOperationUnknown,
  prepareRegenerateOperation,
  prepareSendOperation,
} from './operation';
import type { ChatOperationOwner, ChatRegenerateOperation, ChatWriteOperation } from './operation';
import { prepareRegenerateCommand, prepareSelectVersionCommand } from './regenerate';
import type { RegenerateCommand } from './regenerate';
import {
  findOperationAssistant,
  inspectOperationSnapshot,
  mergeConversationDetail,
  snapshotConfirmsVersion,
} from './reconcile';
import type { ChatSnapshotOutcome } from './reconcile';
import { chatReducer } from './reducer';
import { initialChatState } from './state';
import type { ChatEvent, ChatFailure, ChatState } from './state';

export interface ChatSendCommand {
  readonly content: string;
  readonly groupId: string;
  readonly modelId: string;
  readonly maxOutputTokens?: number;
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
const reconcileDelays = [100, 250, 500] as const;
const pendingOperations = new Map<string, ChatWriteOperation>();

function pendingKey(userId: string, conversationId: string): string {
  return JSON.stringify([userId, conversationId]);
}

function samePrincipal(left: ChatOperationOwner, right: ChatOperationOwner | null): boolean {
  return right !== null && left.userId === right.userId;
}

function operationBelongsToPrincipal(operation: ChatWriteOperation, owner: ChatOperationOwner, conversationId: string): boolean {
  return operation.owner.userId === owner.userId && operation.conversationId === conversationId;
}

function takeOverOperation(operation: ChatWriteOperation, owner: ChatOperationOwner): ChatWriteOperation {
  return Object.freeze({
    ...operation,
    owner: Object.freeze({ ...owner }),
    state: 'unknown' as const,
  });
}

function ownerKey(owner: ChatOperationOwner | null): string {
  return owner ? JSON.stringify([owner.userId, owner.epoch]) : 'null';
}

function sameOwner(left: ChatOperationOwner, right: ChatOperationOwner | null): boolean {
  return right !== null && left.userId === right.userId && left.epoch === right.epoch;
}

function asFailure(cause: unknown, kind: ChatFailure['kind']): ChatFailure {
  if (cause instanceof ApiClientError) return { kind, message: cause.message, code: cause.code };
  return { kind, message: cause instanceof Error ? cause.message : '聊天请求失败。' };
}

function errorIsKnownRejection(cause: unknown, accepted: boolean): boolean {
  if (accepted) return false;
  if (!(cause instanceof ApiClientError)) return false;
  if (cause.kind === 'request') return true;
  if (cause.kind === 'api') {
    return ['invalid_request', 'unauthorized', 'forbidden', 'not_found', 'conflict',
      'payload_too_large', 'rate_limited', 'insufficient_balance'].includes(cause.code);
  }
  return cause.status === 401 || cause.status === 403 || cause.status === 404
    || cause.status === 409 || cause.status === 413 || cause.status === 422;
}

function createResultMayBeUnknown(cause: unknown): boolean {
  if (!(cause instanceof ApiClientError)) return true;
  if (cause.kind === 'request') return false;
  if (cause.kind === 'network' || cause.kind === 'invalid_response' || cause.kind === 'aborted') return true;
  if (cause.kind === 'api') {
    return cause.status === null || cause.status >= 500
      || cause.code === 'internal_error' || cause.code === 'service_unavailable';
  }
  return cause.status === null || cause.status >= 500;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => globalThis.setTimeout(resolve, milliseconds));
}

function validSendCommand(command: ChatSendCommand, operationId: string): boolean {
  if (!operationIdentifier.test(operationId)) return false;
  return chatSendInputSchema.safeParse({
    operationId,
    conversationVersion: 1,
    groupId: command.groupId,
    modelId: command.modelId,
    content: command.content,
    ...(command.maxOutputTokens === undefined ? {} : { maxOutputTokens: command.maxOutputTokens }),
  }).success;
}

export function createChatController(options: ChatControllerOptions) {
  let state: ChatState = initialChatState;
  const listeners = new Set<() => void>();
  let activeConversationId = options.conversationId ?? options.initialDetail?.conversation.id ?? null;
  let activeRun: ActiveRun | null = null;
  let pendingOperation: ChatWriteOperation | null = null;
  let loadEpoch = 0;
  let disposed = false;
  let observedOwner = ownerKey(options.getOwner());

  if (options.initialDetail) state = chatReducer(state, { type: 'hydrate', detail: options.initialDetail });

  function notify(): void {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* One subscriber must not block the rest. */ }
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
    pendingOperations.set(pendingKey(operation.owner.userId, operation.conversationId), operation);
  }

  function forgetPending(operation: ChatWriteOperation): void {
    if (pendingOperation?.operationId === operation.operationId) pendingOperation = null;
    const key = pendingKey(operation.owner.userId, operation.conversationId);
    if (pendingOperations.get(key)?.operationId === operation.operationId) pendingOperations.delete(key);
  }

  function isRunCurrent(run: ActiveRun): boolean {
    return activeRun === run && !run.identityChanged && sameOwner(run.owner, options.getOwner());
  }

  function canDispatchForRun(run: ActiveRun): boolean {
    return !disposed && isRunCurrent(run);
  }

  function restorePendingForConversation(conversationId: string, owner: ChatOperationOwner): void {
    let pending = pendingOperation;
    if (!pending || !operationBelongsToPrincipal(pending, owner, conversationId)) {
      pending = pendingOperations.get(pendingKey(owner.userId, conversationId)) ?? null;
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

  function makeRun(owner: ChatOperationOwner, commandId: string, commandKind: ActiveRun['commandKind']): ActiveRun {
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

  async function finishBeforeSend(run: ActiveRun, cause: unknown, ambiguousCreate = false): Promise<ChatCommandResult> {
    if (!isRunCurrent(run)) return 'superseded';
    const failure = asFailure(cause, ambiguousCreate ? 'failed' : 'rejected');
    if (canDispatchForRun(run)) {
      dispatch({ type: 'failed', operationId: run.commandId, failure });
    }
    return ambiguousCreate ? 'interrupted' : 'rejected';
  }

  async function readConversationForRun(run: ActiveRun, conversationId: string): Promise<ConversationDetail | null> {
    try {
      const detail = await options.api.getConversation(conversationId);
      if (!isRunCurrent(run)) return null;
      activeConversationId = conversationId;
      if (canDispatchForRun(run)) {
        dispatch({ type: 'hydrate', detail });
        dispatch({
          type: 'begin',
          operationId: run.commandId,
          operationKind: 'send',
          needsConversation: false,
        });
      }
      return detail;
    } catch (cause) {
      if (!isRunCurrent(run)) return null;
      await finishBeforeSend(run, cause);
      return null;
    }
  }

  async function reconcileFinalSnapshot(
    run: ActiveRun,
    initialOperation: ChatWriteOperation,
    replayDetail: ConversationDetail | null,
    isReplay: boolean,
    failure: ChatFailure | null,
  ): Promise<ChatCommandResult> {
    let operation = initialOperation;
    if (isReplay && replayDetail) {
      const replayedMessage = findOperationAssistant(replayDetail, { operation, belongsToOperation: true });
      if (replayedMessage) {
        operation = markOperationAccepted(operation, { id: replayedMessage.id, requestId: replayedMessage.requestId });
        run.operation = operation;
        rememberPending(operation);
      }
    }

    const expectedVersion = operation.input.conversationVersion + 1;
    let lastOutcome: ChatSnapshotOutcome = 'unconfirmed';
    let latest: ConversationDetail | null = replayDetail;
    for (let attempt = 0; attempt <= reconcileDelays.length; attempt += 1) {
      if (attempt > 0) await delay(reconcileDelays[attempt - 1]!);
      if (!isRunCurrent(run)) return 'superseded';
      let fetched: ConversationDetail;
      try {
        fetched = await options.api.getConversation(operation.conversationId);
      } catch {
        if (!isRunCurrent(run)) return 'superseded';
        continue;
      }
      if (!isRunCurrent(run)) return 'superseded';
      latest = mergeConversationDetail(state.detail?.conversation.id === fetched.conversation.id ? state.detail : latest, fetched);
      const proof = {
        operation,
        ...(operation.assistantMessageId === null ? {} : { assistantMessageId: operation.assistantMessageId }),
      };
      lastOutcome = inspectOperationSnapshot(fetched, proof);
      if ((lastOutcome === 'completed' || lastOutcome === 'stopped' || lastOutcome === 'failed')
        && snapshotConfirmsVersion(fetched, expectedVersion)) {
        operation = markOperationSettled(operation);
        run.operation = operation;
        forgetPending(operation);
        const outcome = lastOutcome;
        const terminalFailure = outcome === 'failed'
          ? failure ?? (run.streamError
            ? { kind: 'failed' as const, message: run.streamError.message, code: run.streamError.code }
            : { kind: 'failed' as const, message: '回答未能完成。' })
          : undefined;
        if (canDispatchForRun(run)) {
          dispatch({
            type: 'settled',
            operationId: operation.operationId,
            outcome,
            detail: latest,
            ...(terminalFailure === undefined ? {} : { failure: terminalFailure }),
          });
        }
        try { await options.onDetailConfirmed?.(latest); } catch { /* Cache writes/navigation are advisory. */ }
        return outcome;
      }
      if (lastOutcome !== 'pending') break;
    }

    operation = markOperationUnknown(operation);
    run.operation = operation;
    rememberPending(operation);
    if (canDispatchForRun(run)) {
      dispatch({
        type: 'interrupted',
        operationId: operation.operationId,
        failure: failure ?? { kind: 'interrupted', message: '连接已中断，服务端结果尚未确认。可使用原操作重试。' },
      });
    }
    return 'interrupted';
  }

  async function performOperation(
    run: ActiveRun,
    prepared: ChatWriteOperation,
    retry: boolean,
  ): Promise<ChatCommandResult> {
    let operation = markOperationInFlight(prepared, retry);
    run.operation = operation;
    rememberPending(operation);
    if (canDispatchForRun(run)) dispatch({ type: 'submitting', operationId: operation.operationId });

    const handlers: ChatStreamHandlers = {
      onMeta: value => {
        if (!isRunCurrent(run)) return;
        operation = markOperationAccepted(operation, {
          id: value.assistantMessage.id,
          requestId: value.assistantMessage.requestId,
        });
        run.operation = operation;
        rememberPending(operation);
        if (canDispatchForRun(run)) dispatch({ type: 'meta', operationId: operation.operationId, value });
      },
      onDelta: text => {
        if (canDispatchForRun(run)) dispatch({ type: 'delta', operationId: operation.operationId, text });
      },
      onDone: (message, billingStatus) => {
        if (!isRunCurrent(run)) return;
        run.terminalMessage = message;
        operation = markOperationAccepted(operation, { id: message.id, requestId: message.requestId });
        run.operation = operation;
        rememberPending(operation);
        if (canDispatchForRun(run)) {
          dispatch({
            type: 'done',
            operationId: operation.operationId,
            value: { message, ...(billingStatus === undefined ? {} : { billingStatus }) },
          });
        }
      },
      onError: (event: ChatErrorEvent) => {
        if (!isRunCurrent(run)) return;
        run.streamError = event;
        if (event.messageId) {
          operation = markOperationAccepted(operation, { id: event.messageId, requestId: operation.requestId });
          run.operation = operation;
          rememberPending(operation);
        }
      },
    };

    try {
      const result: ChatSendResult = operation.kind === 'send'
        ? await options.api.sendMessage(
          operation.conversationId,
          operation.input,
          handlers,
          run.abortController.signal,
        )
        : await options.api.regenerate(
          operation.conversationId,
          operation.input,
          handlers,
          run.abortController.signal,
        );
      if (!isRunCurrent(run)) return 'superseded';
      let replayDetail: ConversationDetail | null = null;
      let replay = false;
      if (result.kind === 'replay') {
        replay = true;
        replayDetail = { conversation: result.conversation, messages: result.messages };
        const message = findOperationAssistant(replayDetail, { operation, belongsToOperation: true });
        if (message) {
          operation = markOperationAccepted(operation, { id: message.id, requestId: message.requestId });
          run.operation = operation;
          rememberPending(operation);
        }
      } else {
        run.terminalMessage = result.message;
        operation = markOperationAccepted(operation, { id: result.message.id, requestId: result.message.requestId });
        run.operation = operation;
        rememberPending(operation);
        if (canDispatchForRun(run) && run.terminalMessage) {
          dispatch({
            type: 'done',
            operationId: operation.operationId,
            value: {
              message: result.message,
              ...(result.billingStatus === undefined ? {} : { billingStatus: result.billingStatus }),
            },
          });
        }
      }
      if (canDispatchForRun(run)) dispatch({ type: 'finalizing', operationId: operation.operationId });
      const failure = run.streamError
        ? { kind: 'failed' as const, message: run.streamError.message, code: run.streamError.code }
        : null;
      return reconcileFinalSnapshot(run, operation, replayDetail, replay, failure);
    } catch (cause) {
      if (!isRunCurrent(run)) return 'superseded';
      const accepted = operation.state === 'accepted' || operation.assistantMessageId !== null || run.terminalMessage !== null;
      if (errorIsKnownRejection(cause, accepted)) {
        operation = markOperationRejected(operation);
        run.operation = operation;
        forgetPending(operation);
        if (canDispatchForRun(run)) {
          dispatch({ type: 'failed', operationId: operation.operationId, failure: asFailure(cause, 'rejected') });
        }
        return 'rejected';
      }
      operation = markOperationUnknown(operation);
      run.operation = operation;
      rememberPending(operation);
      if (canDispatchForRun(run)) dispatch({ type: 'finalizing', operationId: operation.operationId });
      const failure = run.streamError
        ? { kind: 'failed' as const, message: run.streamError.message, code: run.streamError.code }
        : asFailure(cause, 'interrupted');
      return reconcileFinalSnapshot(run, operation, null, false, failure);
    }
  }

  async function performSend(run: ActiveRun, command: ChatSendCommand): Promise<ChatCommandResult> {
    if (!validSendCommand(command, run.commandId)) {
      return finishBeforeSend(run, new ApiClientError('request', '聊天请求参数无效。'));
    }
    if (run.abortController.signal.aborted) {
      if (canDispatchForRun(run)) {
        if (state.detail) dispatch({ type: 'settled', operationId: run.commandId, outcome: 'stopped', detail: state.detail });
        else dispatch({ type: 'reset' });
      }
      return run.disposeRequested ? 'interrupted' : 'stopped';
    }

    let detail: ConversationDetail | null = null;
    const requestedId = activeConversationId;
    if (requestedId) {
      detail = state.detail?.conversation.id === requestedId
        ? state.detail
        : await readConversationForRun(run, requestedId);
      if (!detail) return 'rejected';
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
            dispatch({
              type: 'settled',
              operationId: run.commandId,
              outcome: 'stopped',
              detail,
            });
          }
          return run.disposeRequested ? 'interrupted' : 'stopped';
        }
        if (run.routeEpoch !== loadEpoch) return run.stopRequested ? 'stopped' : 'superseded';
        activeConversationId = conversation.id;
        if (canDispatchForRun(run)) dispatch({ type: 'conversation-created', operationId: run.commandId, conversation });
        try { await options.onConversationCreated?.(conversation); } catch { /* URL/cache integration cannot block sending. */ }
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
      ...(command.maxOutputTokens === undefined ? {} : { maxOutputTokens: command.maxOutputTokens }),
      baselineMessageIds: detail.messages.map(message => message.id),
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

  function execute(run: ActiveRun, work: () => Promise<ChatCommandResult>): Promise<ChatCommandResult> {
    const task = work().catch(cause => {
      if (!run.operation) return finishBeforeSend(run, cause);
      const operation = markOperationUnknown(run.operation);
      run.operation = operation;
      rememberPending(operation);
      if (canDispatchForRun(run)) {
        dispatch({
          type: 'interrupted',
          operationId: operation.operationId,
          failure: asFailure(cause, 'interrupted'),
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
    const owner = options.getOwner();
    if (!owner) return Promise.resolve('rejected');
    const pending = activeConversationId
      ? pendingOperations.get(pendingKey(owner.userId, activeConversationId))
        ?? (pendingOperation && operationBelongsToPrincipal(pendingOperation, owner, activeConversationId)
          ? pendingOperation
          : null)
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
    if (!detail || detail.conversation.id !== activeConversationId) return Promise.resolve('rejected');
    const existing = pendingOperations.get(pendingKey(owner.userId, detail.conversation.id)) ?? pendingOperation;
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
      ...(prepared.input.maxOutputTokens === undefined ? {} : { maxOutputTokens: prepared.input.maxOutputTokens }),
      previousMessageId: prepared.previousMessageId,
      baselineMessageIds: detail.messages.map(message => message.id),
      operationId: commandId,
    });
    if (!chatRegenerateInputSchema.safeParse(operation.input).success) return Promise.resolve('rejected');
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

  function selectionIsConfirmed(detail: ConversationDetail, messageId: string, minimumVersion: number): boolean {
    return detail.conversation.id === activeConversationId
      && detail.conversation.version >= minimumVersion
      && detail.messages.some(message => message.id === messageId && message.role === 'assistant' && message.selected);
  }

  async function performSelectVersion(
    run: ActiveRun,
    input: { readonly conversationVersion: number; readonly messageId: string },
  ): Promise<ChatCommandResult> {
    const conversationId = run.conversationId;
    if (!conversationId) return 'rejected';
    const minimumVersion = input.conversationVersion + 1;
    async function confirm(detail: ConversationDetail): Promise<ChatCommandResult> {
      if (!isRunCurrent(run)) return 'superseded';
      if (!selectionIsConfirmed(detail, input.messageId, minimumVersion)) {
        if (canDispatchForRun(run)) {
          dispatch({
            type: 'interrupted',
            operationId: run.commandId,
            failure: { kind: 'interrupted', message: '版本切换结果尚未确认，请重新读取对话后再选择。' },
          });
        }
        return 'interrupted';
      }
      const latest = mergeConversationDetail(
        state.detail?.conversation.id === detail.conversation.id ? state.detail : null,
        detail,
      );
      if (canDispatchForRun(run)) {
        dispatch({ type: 'settled', operationId: run.commandId, outcome: 'completed', detail: latest });
      }
      try { await options.onDetailConfirmed?.(latest); } catch { /* Cache writes are advisory. */ }
      return 'selected';
    }

    try {
      const detail = await options.api.selectVersion(conversationId, input);
      if (!isRunCurrent(run)) return 'superseded';
      if (selectionIsConfirmed(detail, input.messageId, minimumVersion)) return confirm(detail);
      const latest = await options.api.getConversation(conversationId);
      return confirm(latest);
    } catch (cause) {
      if (!isRunCurrent(run)) return 'superseded';
      if (errorIsKnownRejection(cause, false)) {
        if (canDispatchForRun(run)) {
          dispatch({ type: 'failed', operationId: run.commandId, failure: asFailure(cause, 'rejected') });
        }
        return 'rejected';
      }
      try {
        const latest = await options.api.getConversation(conversationId);
        if (!isRunCurrent(run)) return 'superseded';
        if (selectionIsConfirmed(latest, input.messageId, minimumVersion)) return confirm(latest);
      } catch { /* The selection response and follow-up read were both inconclusive. */ }
      if (canDispatchForRun(run)) {
        dispatch({
          type: 'interrupted',
          operationId: run.commandId,
          failure: asFailure(cause, 'interrupted'),
        });
      }
      return 'interrupted';
    }
  }

  function selectVersion(messageId: string): Promise<ChatCommandResult> {
    if (disposed) return Promise.resolve('disposed');
    if (activeRun) return Promise.resolve('busy');
    const owner = options.getOwner();
    const detail = state.detail;
    if (!owner || !detail || detail.conversation.id !== activeConversationId) return Promise.resolve('rejected');
    const pending = pendingOperations.get(pendingKey(owner.userId, detail.conversation.id)) ?? pendingOperation;
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
    dispatch({ type: 'begin', operationId: commandId, operationKind: 'select', needsConversation: false });
    return execute(run, () => performSelectVersion(run, prepared.input));
  }

  function retry(): Promise<ChatCommandResult> {
    if (disposed) return Promise.resolve('disposed');
    if (activeRun) return Promise.resolve('busy');
    const owner = options.getOwner();
    const conversationId = activeConversationId;
    if (!owner || !conversationId) return Promise.resolve('idle');
    const storedOperation = pendingOperations.get(pendingKey(owner.userId, conversationId));
    const candidate = pendingOperation && operationBelongsToPrincipal(pendingOperation, owner, conversationId)
      ? pendingOperation
      : storedOperation ?? null;
    if (!candidate || !canRetryOperation(candidate)
      || !operationBelongsToPrincipal(candidate, owner, conversationId)) return Promise.resolve('idle');
    const operation = candidate.owner.epoch === owner.epoch ? candidate : takeOverOperation(candidate, owner);
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

  function hydrate(detail: ConversationDetail | null): void {
    if (disposed) return;
    const incomingId = detail?.conversation.id ?? null;
    if (detail && activeRun && activeRun.conversationId === incomingId && state.detail?.conversation.id === incomingId) return;
    if (activeRun && activeRun.conversationId !== incomingId) void stop();
    activeConversationId = incomingId;
    loadEpoch += 1;
    if (detail) dispatch({ type: 'hydrate', detail });
    else dispatch({ type: 'reset' });
    const owner = options.getOwner();
    if (detail && owner) restorePendingForConversation(detail.conversation.id, owner);
  }

  function resetConversation(): void {
    if (activeRun) void stop();
    activeConversationId = null;
    loadEpoch += 1;
    dispatch({ type: 'reset' });
  }

  async function loadConversation(conversationId: string): Promise<ConversationDetail | null> {
    if (disposed || conversationId.length === 0) return null;
    const ticket = ++loadEpoch;
    if (activeRun && activeRun.conversationId !== conversationId) await stop();
    if (disposed || ticket !== loadEpoch) return null;
    if (state.detail?.conversation.id === conversationId) {
      const owner = options.getOwner();
      if (owner) restorePendingForConversation(conversationId, owner);
      return state.detail;
    }
    const owner = options.getOwner();
    if (!owner) return null;
    try {
      const detail = await options.api.getConversation(conversationId);
      if (disposed || ticket !== loadEpoch || !sameOwner(owner, options.getOwner())) return null;
      activeConversationId = conversationId;
      dispatch({ type: 'hydrate', detail });
      restorePendingForConversation(conversationId, owner);
      return detail;
    } catch {
      return null;
    }
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  function onOwnerChanged(): void {
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
    if (pendingOperation && !samePrincipal(pendingOperation.owner, currentOwner)) pendingOperation = null;
    if (!disposed) {
      state = initialChatState;
      notify();
    }
  }

  const unsubscribeOwner = options.subscribeOwner?.(onOwnerChanged);
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
    subscribe,
    hydrate,
    resetConversation,
    loadConversation,
    send,
    regenerate,
    selectVersion,
    stop,
    retry,
    dispose,
  });
}

export type ChatController = ReturnType<typeof createChatController>;
