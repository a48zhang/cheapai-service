import type { ChatMessage } from '@cheapai/api-client/chat';

export interface ChatMessageTurn {
  readonly turnIndex: number;
  readonly userMessages: readonly ChatMessage[];
  readonly assistantVariants: readonly ChatMessage[];
  readonly selectedAssistant: ChatMessage | null;
}

interface PendingTurn {
  userMessages: ChatMessage[];
  assistantVariants: ChatMessage[];
}

export interface AssistantRow {
  readonly kind: 'assistant';
  readonly message: ChatMessage;
  readonly variants: readonly ChatMessage[];
  readonly selectedId: string | null;
}

export interface UserRow {
  readonly kind: 'user';
  readonly message: ChatMessage;
}

export type MessageRow = AssistantRow | UserRow;

export interface MessageRows {
  readonly groups: readonly ChatMessageTurn[];
  readonly rows: readonly MessageRow[];
  readonly latestAssistantTurnIndex: number | null;
}

function compareAssistantVariants(left: ChatMessage, right: ChatMessage): number {
  return (
    left.variant - right.variant ||
    left.createdAt - right.createdAt ||
    left.id.localeCompare(right.id)
  );
}

/** Groups every message by turn once, preserving input order for user messages. */
export function groupChatMessagesByTurn(messages: readonly ChatMessage[]): ChatMessageTurn[] {
  const byTurn = new Map<number, PendingTurn>();
  for (const message of messages) {
    let turn = byTurn.get(message.turnIndex);
    if (!turn) {
      turn = { userMessages: [], assistantVariants: [] };
      byTurn.set(message.turnIndex, turn);
    }
    if (message.role === 'user') turn.userMessages.push(message);
    else if (message.role === 'assistant') turn.assistantVariants.push(message);
  }

  return [...byTurn.entries()]
    .sort(([left], [right]) => left - right)
    .map(([turnIndex, turn]) => {
      const assistantVariants = turn.assistantVariants.sort(compareAssistantVariants);
      return {
        turnIndex,
        userMessages: turn.userMessages,
        assistantVariants,
        selectedAssistant: assistantVariants.find((message) => message.selected) ?? null,
      };
    });
}

/** Builds the visible timeline and its permission boundary from the same turn groups. */
export function createMessageRows(
  messages: readonly ChatMessage[],
  streamMessageId: string | null,
): MessageRows {
  const groups = groupChatMessagesByTurn(messages);
  const rows: MessageRow[] = [];
  let latestAssistantTurnIndex: number | null = null;

  for (const group of groups) {
    for (const message of group.userMessages) rows.push({ kind: 'user', message });

    const variants = group.assistantVariants;
    if (variants.length === 0) continue;
    latestAssistantTurnIndex = group.turnIndex;

    const activeStream = streamMessageId
      ? variants.find((message) => message.id === streamMessageId)
      : undefined;
    const message = activeStream ?? group.selectedAssistant ?? variants[0];
    if (message)
      rows.push({
        kind: 'assistant',
        message,
        variants,
        selectedId: group.selectedAssistant?.id ?? null,
      });
  }

  return { groups, rows, latestAssistantTurnIndex };
}
