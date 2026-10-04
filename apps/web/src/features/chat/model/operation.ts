import type { ChatRegenerateInput, ChatSendInput } from '@cheapai/contracts/chat';

export interface ChatOperationOwner {
  readonly userId: string;
  readonly epoch: number;
}

export type ChatWriteOperationState =
  'prepared' | 'in-flight' | 'accepted' | 'unknown' | 'settled' | 'rejected';

interface ChatWriteOperationBase {
  readonly operationId: string;
  readonly conversationId: string;
  readonly owner: ChatOperationOwner;
  readonly baselineMessageIds: readonly string[];
  readonly assistantMessageId: string | null;
  readonly requestId: string | null;
  readonly state: ChatWriteOperationState;
  readonly attempts: number;
}

export interface ChatSendOperation extends ChatWriteOperationBase {
  readonly kind: 'send';
  readonly input: ChatSendInput;
}

export interface ChatRegenerateOperation extends ChatWriteOperationBase {
  readonly kind: 'regenerate';
  readonly input: ChatRegenerateInput;
  readonly previousMessageId: string;
}

export type ChatWriteOperation = ChatSendOperation | ChatRegenerateOperation;

export interface PrepareSendOperationInput {
  readonly owner: ChatOperationOwner;
  readonly conversationId: string;
  readonly conversationVersion: number;
  readonly groupId: string;
  readonly modelId: string;
  readonly content: string;
  readonly maxOutputTokens?: number;
  readonly baselineMessageIds: readonly string[];
  readonly operationId?: string;
}

export interface PrepareRegenerateOperationInput {
  readonly owner: ChatOperationOwner;
  readonly conversationId: string;
  readonly conversationVersion: number;
  readonly groupId: string;
  readonly modelId: string;
  readonly maxOutputTokens?: number;
  readonly previousMessageId: string;
  readonly baselineMessageIds: readonly string[];
  readonly operationId?: string;
}

/** Called only when the user starts a new command, never while rendering. */
export function createChatOperationId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  return 'chat-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

function baseOperation(input: {
  readonly owner: ChatOperationOwner;
  readonly conversationId: string;
  readonly baselineMessageIds: readonly string[];
  readonly operationId: string;
}): ChatWriteOperationBase {
  return {
    operationId: input.operationId,
    conversationId: input.conversationId,
    owner: Object.freeze({ ...input.owner }),
    baselineMessageIds: Object.freeze([...new Set(input.baselineMessageIds)]),
    assistantMessageId: null,
    requestId: null,
    state: 'prepared',
    attempts: 0,
  };
}

export function prepareSendOperation(input: PrepareSendOperationInput): ChatSendOperation {
  const operationId = input.operationId ?? createChatOperationId();
  const body: ChatSendInput = Object.freeze({
    operationId,
    conversationVersion: input.conversationVersion,
    groupId: input.groupId,
    modelId: input.modelId,
    content: input.content,
    ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
  });
  return Object.freeze({
    ...baseOperation({ ...input, operationId }),
    kind: 'send' as const,
    input: body,
  });
}

export function prepareRegenerateOperation(
  input: PrepareRegenerateOperationInput,
): ChatRegenerateOperation {
  const operationId = input.operationId ?? createChatOperationId();
  const body: ChatRegenerateInput = Object.freeze({
    operationId,
    conversationVersion: input.conversationVersion,
    groupId: input.groupId,
    modelId: input.modelId,
    ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
  });
  return Object.freeze({
    ...baseOperation({ ...input, operationId }),
    kind: 'regenerate' as const,
    input: body,
    previousMessageId: input.previousMessageId,
  });
}

export function markOperationInFlight(
  operation: ChatWriteOperation,
  retry = false,
): ChatWriteOperation {
  if (operation.state === 'settled' || operation.state === 'rejected') return operation;
  if (retry && operation.state !== 'unknown' && operation.state !== 'accepted') return operation;
  return Object.freeze({
    ...operation,
    state: 'in-flight',
    attempts: operation.attempts + (retry ? 1 : 0),
  });
}

export function markOperationAccepted(
  operation: ChatWriteOperation,
  message: { readonly id: string; readonly requestId: string | null },
): ChatWriteOperation {
  if (operation.state === 'settled' || operation.state === 'rejected') return operation;
  return Object.freeze({
    ...operation,
    state: 'accepted',
    assistantMessageId: message.id,
    requestId: message.requestId,
  });
}

export function markOperationUnknown(operation: ChatWriteOperation): ChatWriteOperation {
  if (operation.state === 'settled' || operation.state === 'rejected') return operation;
  return Object.freeze({ ...operation, state: 'unknown' });
}

export function markOperationSettled(operation: ChatWriteOperation): ChatWriteOperation {
  if (operation.state === 'settled' || operation.state === 'rejected') return operation;
  return Object.freeze({ ...operation, state: 'settled' });
}

export function markOperationRejected(operation: ChatWriteOperation): ChatWriteOperation {
  if (operation.state === 'settled' || operation.state === 'rejected') return operation;
  return Object.freeze({ ...operation, state: 'rejected' });
}

export function canRetryOperation(operation: ChatWriteOperation): boolean {
  return operation.state === 'unknown' || operation.state === 'accepted';
}

export function operationBelongsTo(
  operation: ChatWriteOperation,
  owner: ChatOperationOwner,
  conversationId: string,
): boolean {
  return (
    operation.owner.userId === owner.userId &&
    operation.owner.epoch === owner.epoch &&
    operation.conversationId === conversationId
  );
}
