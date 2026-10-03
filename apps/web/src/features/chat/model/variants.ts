import type { ChatMessage, ConversationDetail } from '@cheapai/contracts/chat';

export interface AssistantVariantGroup {
  readonly turnIndex: number;
  readonly variants: readonly ChatMessage[];
  /** The selected variant reported by the server, or null for an incomplete turn. */
  readonly selected: ChatMessage | null;
}

export type RegenerateBlockReason =
  | 'conversation-loading'
  | 'no-assistant'
  | 'no-user-message'
  | 'not-latest-turn'
  | 'generation-in-progress';

export type RegenerateAvailability =
  | {
      readonly allowed: true;
      readonly turnIndex: number;
      readonly assistant: ChatMessage;
      readonly nextVariant: number;
      readonly conversationVersion: number;
    }
  | { readonly allowed: false; readonly reason: RegenerateBlockReason };

export type SelectVariantBlockReason =
  | 'conversation-loading'
  | 'message-not-found'
  | 'not-assistant'
  | 'not-latest-turn'
  | 'generation-in-progress'
  | 'already-selected'
  | 'no-selected-variant';

export type SelectVariantAvailability =
  | {
      readonly allowed: true;
      readonly turnIndex: number;
      readonly message: ChatMessage;
      readonly selected: ChatMessage;
      readonly conversationVersion: number;
    }
  | { readonly allowed: false; readonly reason: SelectVariantBlockReason };

function compareVariants(left: ChatMessage, right: ChatMessage): number {
  return left.variant - right.variant
    || left.createdAt - right.createdAt
    || left.id.localeCompare(right.id);
}

/** Groups server messages without changing the server's selected flags or order within a turn. */
export function groupAssistantVariants(messages: readonly ChatMessage[]): AssistantVariantGroup[] {
  const byTurn = new Map<number, ChatMessage[]>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const variants = byTurn.get(message.turnIndex) ?? [];
    variants.push(message);
    byTurn.set(message.turnIndex, variants);
  }

  return [...byTurn.entries()]
    .sort(([left], [right]) => left - right)
    .map(([turnIndex, values]) => {
      const variants = [...values].sort(compareVariants);
      return {
        turnIndex,
        variants,
        selected: variants.find(message => message.selected) ?? null,
      };
    });
}

export function assistantVariantsForTurn(
  messages: readonly ChatMessage[],
  turnIndex: number,
): readonly ChatMessage[] {
  return groupAssistantVariants(messages).find(group => group.turnIndex === turnIndex)?.variants ?? [];
}

export function lastSelectedAssistant(messages: readonly ChatMessage[]): ChatMessage | null {
  const groups = groupAssistantVariants(messages);
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const selected = groups[index]?.selected;
    if (selected) return selected;
  }
  return null;
}

function latestTurnIndex(messages: readonly ChatMessage[]): number | null {
  let latest: number | null = null;
  for (const message of messages) {
    if (latest === null || message.turnIndex > latest) latest = message.turnIndex;
  }
  return latest;
}

export function canRegenerateLastAssistant(detail: ConversationDetail | null): RegenerateAvailability {
  if (!detail) return { allowed: false, reason: 'conversation-loading' };
  const turnIndex = latestTurnIndex(detail.messages);
  const assistant = lastSelectedAssistant(detail.messages);
  if (!assistant) return { allowed: false, reason: 'no-assistant' };
  if (turnIndex === null || !detail.messages.some(message => message.role === 'user' && message.turnIndex === assistant.turnIndex)) {
    return { allowed: false, reason: 'no-user-message' };
  }
  if (assistant.turnIndex !== turnIndex) return { allowed: false, reason: 'not-latest-turn' };
  const variants = assistantVariantsForTurn(detail.messages, assistant.turnIndex);
  if (variants.some(message => message.status === 'generating')) {
    return { allowed: false, reason: 'generation-in-progress' };
  }
  const highestVariant = variants.reduce((highest, message) => Math.max(highest, message.variant), 0);
  return {
    allowed: true,
    turnIndex: assistant.turnIndex,
    assistant,
    nextVariant: highestVariant + 1,
    conversationVersion: detail.conversation.version,
  };
}

export function canSelectAssistantVariant(
  detail: ConversationDetail | null,
  messageId: string,
): SelectVariantAvailability {
  if (!detail) return { allowed: false, reason: 'conversation-loading' };
  const message = detail.messages.find(item => item.id === messageId);
  if (!message) return { allowed: false, reason: 'message-not-found' };
  if (message.role !== 'assistant') return { allowed: false, reason: 'not-assistant' };
  const latest = latestTurnIndex(detail.messages);
  if (latest === null || message.turnIndex !== latest) return { allowed: false, reason: 'not-latest-turn' };
  const variants = assistantVariantsForTurn(detail.messages, message.turnIndex);
  if (variants.some(item => item.status === 'generating')) {
    return { allowed: false, reason: 'generation-in-progress' };
  }
  const selected = variants.find(item => item.selected);
  if (!selected) return { allowed: false, reason: 'no-selected-variant' };
  if (selected.id === message.id) return { allowed: false, reason: 'already-selected' };
  return {
    allowed: true,
    turnIndex: message.turnIndex,
    message,
    selected,
    conversationVersion: detail.conversation.version,
  };
}
