import type { ChatMessage, ConversationDetail } from '@cheapai/contracts/chat';
import type { ChatWriteOperation } from './operation';

export type ChatSnapshotOutcome = 'completed' | 'stopped' | 'failed' | 'pending' | 'unconfirmed';

export interface ChatOperationProof {
  readonly operation: ChatWriteOperation;
  /** An SSE meta or replay response may identify this operation's assistant row. */
  readonly assistantMessageId?: string;
  /** True only for this operation's own replay envelope. */
  readonly belongsToOperation?: boolean;
}

function pickConversation(current: ConversationDetail, incoming: ConversationDetail): ConversationDetail['conversation'] {
  const oldValue = current.conversation;
  const newValue = incoming.conversation;
  if (newValue.version !== oldValue.version) return newValue.version > oldValue.version ? newValue : oldValue;
  return newValue.updatedAt >= oldValue.updatedAt ? newValue : oldValue;
}

function pickMessage(previous: ChatMessage, incoming: ChatMessage): ChatMessage {
  if (incoming.updatedAt !== previous.updatedAt) return incoming.updatedAt > previous.updatedAt ? incoming : previous;
  return incoming;
}

/** Merge concurrent snapshots without allowing a lower CAS version or older message to replace newer state. */
export function mergeConversationDetail(
  current: ConversationDetail | null,
  incoming: ConversationDetail,
): ConversationDetail {
  if (!current || current.conversation.id !== incoming.conversation.id) return incoming;
  if (incoming.conversation.version < current.conversation.version) return current;
  const messages = new Map<string, ChatMessage>();
  for (const message of current.messages) messages.set(message.id, message);
  for (const message of incoming.messages) {
    const previous = messages.get(message.id);
    messages.set(message.id, previous ? pickMessage(previous, message) : message);
  }
  return {
    conversation: pickConversation(current, incoming),
    messages: [...messages.values()].sort((left, right) =>
      left.turnIndex - right.turnIndex
      || (left.role === right.role ? 0 : left.role === 'user' ? -1 : 1)
      || left.variant - right.variant
      || left.createdAt - right.createdAt
      || left.id.localeCompare(right.id)),
  };
}

export function findOperationAssistant(detail: ConversationDetail, proof: ChatOperationProof): ChatMessage | null {
  if (detail.conversation.id !== proof.operation.conversationId) return null;
  const id = proof.assistantMessageId ?? proof.operation.assistantMessageId;
  if (id) return detail.messages.find(message => message.id === id && message.role === 'assistant') ?? null;
  if (!proof.belongsToOperation) return null;
  const baseline = new Set(proof.operation.baselineMessageIds);
  const additions = detail.messages.filter(message => message.role === 'assistant' && !baseline.has(message.id));
  if (proof.operation.kind === 'regenerate') {
    const previousMessageId = proof.operation.previousMessageId;
    const previous = detail.messages.find(item => item.id === previousMessageId);
    return additions.filter(message => message.turnIndex === previous?.turnIndex)
      .sort((left, right) => right.variant - left.variant || right.createdAt - left.createdAt)[0] ?? null;
  }
  return additions.sort((left, right) =>
    right.turnIndex - left.turnIndex || right.variant - left.variant || right.createdAt - left.createdAt)[0] ?? null;
}

export function inspectOperationSnapshot(detail: ConversationDetail, proof: ChatOperationProof): ChatSnapshotOutcome {
  const message = findOperationAssistant(detail, proof);
  if (!message) return 'unconfirmed';
  switch (message.status) {
    case 'completed': return 'completed';
    case 'stopped': return 'stopped';
    case 'failed': return 'failed';
    case 'generating': return 'pending';
  }
}

export function snapshotConfirmsVersion(detail: ConversationDetail, expectedVersion: number): boolean {
  return detail.conversation.version >= expectedVersion;
}
