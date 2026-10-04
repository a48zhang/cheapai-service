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

function pickConversation(
  current: ConversationDetail,
  incoming: ConversationDetail,
): ConversationDetail['conversation'] {
  const oldValue = current.conversation;
  const newValue = incoming.conversation;
  if (newValue.version !== oldValue.version)
    return newValue.version > oldValue.version ? newValue : oldValue;
  return newValue.updatedAt >= oldValue.updatedAt ? newValue : oldValue;
}

function pickMessage(previous: ChatMessage, incoming: ChatMessage): ChatMessage {
  // Finalization is monotonic: a late generating snapshot must never replace
  // the terminal row, including content and request/model/group attribution.
  if (previous.role === 'assistant' && incoming.role === 'assistant') {
    if (previous.status !== 'generating' && incoming.status === 'generating') return previous;
    if (previous.status === 'generating' && incoming.status !== 'generating') return incoming;
  }
  if (incoming.updatedAt !== previous.updatedAt)
    return incoming.updatedAt > previous.updatedAt ? incoming : previous;
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
  const currentMessages = new Map<string, ChatMessage>(
    current.messages.map((message) => [message.id, message] as const),
  );
  const incomingMessages = new Map<string, ChatMessage>(
    incoming.messages.map((message) => [message.id, message] as const),
  );
  const staleGeneratingTurns = new Set<number>();
  if (incoming.conversation.version === current.conversation.version) {
    for (const [id, previous] of currentMessages) {
      const next = incomingMessages.get(id);
      if (previous?.role !== 'assistant' || next?.role !== 'assistant') continue;
      if (previous.status !== 'generating' && next.status === 'generating')
        staleGeneratingTurns.add(previous.turnIndex);
    }
  }
  for (const message of current.messages) messages.set(message.id, message);
  for (const message of incoming.messages) {
    const previous = messages.get(message.id);
    messages.set(message.id, previous ? pickMessage(previous, message) : message);
  }
  const mergedMessages = [...messages.values()].map((message) => {
    if (message.role !== 'assistant') return message;
    const currentMessage = currentMessages.get(message.id);
    const incomingMessage = incomingMessages.get(message.id);
    let selectedFrom: ChatMessage | undefined;
    if (incoming.conversation.version > current.conversation.version) {
      selectedFrom = incomingMessage;
    } else if (incoming.conversation.version === current.conversation.version) {
      selectedFrom = staleGeneratingTurns.has(message.turnIndex) ? currentMessage : incomingMessage;
    }
    return selectedFrom && selectedFrom.selected !== message.selected
      ? { ...message, selected: selectedFrom.selected }
      : message;
  });
  return {
    conversation: pickConversation(current, incoming),
    messages: mergedMessages.sort(
      (left, right) =>
        left.turnIndex - right.turnIndex ||
        (left.role === right.role ? 0 : left.role === 'user' ? -1 : 1) ||
        left.variant - right.variant ||
        left.createdAt - right.createdAt ||
        left.id.localeCompare(right.id),
    ),
  };
}

export function findOperationAssistant(
  detail: ConversationDetail,
  proof: ChatOperationProof,
): ChatMessage | null {
  if (detail.conversation.id !== proof.operation.conversationId) return null;
  const id = proof.assistantMessageId ?? proof.operation.assistantMessageId;
  if (id)
    return (
      detail.messages.find((message) => message.id === id && message.role === 'assistant') ?? null
    );
  if (!proof.belongsToOperation) return null;
  const baseline = new Set(proof.operation.baselineMessageIds);
  const additions = detail.messages.filter(
    (message) => message.role === 'assistant' && !baseline.has(message.id),
  );
  if (proof.operation.kind === 'regenerate') {
    const previousMessageId = proof.operation.previousMessageId;
    const previous = detail.messages.find((item) => item.id === previousMessageId);
    return (
      additions
        .filter((message) => message.turnIndex === previous?.turnIndex)
        .sort(
          (left, right) => right.variant - left.variant || right.createdAt - left.createdAt,
        )[0] ?? null
    );
  }
  return (
    additions.sort(
      (left, right) =>
        right.turnIndex - left.turnIndex ||
        right.variant - left.variant ||
        right.createdAt - left.createdAt,
    )[0] ?? null
  );
}

export function inspectOperationSnapshot(
  detail: ConversationDetail,
  proof: ChatOperationProof,
): ChatSnapshotOutcome {
  const message = findOperationAssistant(detail, proof);
  if (!message) return 'unconfirmed';
  switch (message.status) {
    case 'completed':
      return 'completed';
    case 'stopped':
      return 'stopped';
    case 'failed':
      return 'failed';
    case 'generating':
      return 'pending';
  }
}

export function snapshotConfirmsVersion(
  detail: ConversationDetail,
  expectedVersion: number,
): boolean {
  return detail.conversation.version >= expectedVersion;
}
