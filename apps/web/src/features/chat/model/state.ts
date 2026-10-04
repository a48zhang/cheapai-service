import type {
  ChatDoneEvent,
  ChatMetaEvent,
  ChatMessage,
  Conversation,
  ConversationDetail,
} from '@cheapai/contracts/chat';

export type ChatPhase =
  | 'idle'
  | 'creating'
  | 'submitting'
  | 'streaming'
  | 'stopping'
  | 'finalizing'
  | 'interrupted'
  | 'failed';

export type ChatOperationKind = 'send' | 'regenerate' | 'select';
export type ChatTerminalOutcome = 'completed' | 'stopped' | 'failed';

export interface ChatFailure {
  readonly kind: 'rejected' | 'failed' | 'interrupted';
  readonly message: string;
  readonly code?: string;
}

export interface ChatState {
  readonly phase: ChatPhase;
  readonly detail: ConversationDetail | null;
  /** Retained only while an operation can still be reconciled or retried. */
  readonly operationId: string | null;
  readonly operationKind: ChatOperationKind | null;
  readonly streamMessageId: string | null;
  readonly streamText: string;
  readonly billingStatus: string | null;
  readonly failure: ChatFailure | null;
}

export type ChatEvent =
  | { readonly type: 'hydrate'; readonly detail: ConversationDetail }
  | { readonly type: 'reset' }
  | {
      readonly type: 'begin';
      readonly operationId: string;
      readonly operationKind: ChatOperationKind;
      readonly needsConversation: boolean;
    }
  | {
      readonly type: 'conversation-created';
      readonly operationId: string;
      readonly conversation: Conversation;
    }
  | { readonly type: 'submitting'; readonly operationId: string }
  | { readonly type: 'meta'; readonly operationId: string; readonly value: ChatMetaEvent }
  | { readonly type: 'delta'; readonly operationId: string; readonly text: string }
  | { readonly type: 'done'; readonly operationId: string; readonly value: ChatDoneEvent }
  | { readonly type: 'stop-requested'; readonly operationId: string }
  | { readonly type: 'finalizing'; readonly operationId: string }
  | {
      readonly type: 'settled';
      readonly operationId: string;
      readonly outcome: ChatTerminalOutcome;
      readonly detail: ConversationDetail;
      readonly failure?: ChatFailure;
    }
  | { readonly type: 'failed'; readonly operationId: string; readonly failure: ChatFailure }
  | { readonly type: 'interrupted'; readonly operationId: string; readonly failure: ChatFailure };

export const initialChatState: ChatState = Object.freeze({
  phase: 'idle',
  detail: null,
  operationId: null,
  operationKind: null,
  streamMessageId: null,
  streamText: '',
  billingStatus: null,
  failure: null,
});

export function operationMatches(state: ChatState, operationId: string): boolean {
  return state.operationId === operationId;
}

export function isChatBusy(phase: ChatPhase): boolean {
  return (
    phase === 'creating' ||
    phase === 'submitting' ||
    phase === 'streaming' ||
    phase === 'stopping' ||
    phase === 'finalizing'
  );
}

export function upsertChatMessage(
  messages: readonly ChatMessage[],
  message: ChatMessage,
): readonly ChatMessage[] {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index < 0) return [...messages, message];
  return messages.map((item) => (item.id === message.id ? message : item));
}

export function mergeMetaDetail(
  detail: ConversationDetail | null,
  value: ChatMetaEvent,
): ConversationDetail {
  const existing = detail?.conversation.id === value.conversation.id ? detail.messages : [];
  let messages: readonly ChatMessage[] = existing;
  if (value.userMessage) messages = upsertChatMessage(messages, value.userMessage);
  messages = upsertChatMessage(messages, value.assistantMessage);
  return { conversation: value.conversation, messages: [...messages] };
}
