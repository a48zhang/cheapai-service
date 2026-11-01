import type { ChatMessage } from '@cheapai/api-client/chat';
import type { ChatSubmission } from './state';

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
  readonly renderKey: string;
}

export interface UserRow {
  readonly kind: 'user';
  readonly message: ChatMessage;
}

export interface SubmissionRow {
  readonly kind: 'submission';
  readonly submission: ChatSubmission;
}

export interface PendingResponse {
  readonly operationId: string;
  readonly kind: 'send' | 'regenerate';
}

export interface ResponsePlaceholderRow {
  readonly kind: 'response-placeholder';
  readonly renderKey: string;
}

export type MessageRow = AssistantRow | UserRow | SubmissionRow | ResponsePlaceholderRow;

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
  submission: ChatSubmission | null = null,
  pendingResponse: PendingResponse | null = null,
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
        renderKey:
          activeStream && pendingResponse ? `response:${pendingResponse.operationId}` : message.id,
      });
  }

  if (submission && !submission.userMessageId) rows.push({ kind: 'submission', submission });
  if (
    pendingResponse &&
    !rows.some((row) => row.kind === 'assistant' && row.message.id === streamMessageId)
  ) {
    // A local response slot exists before the server assigns an assistant ID.
    // It is a view row, never a fabricated persisted ChatMessage.
    const placeholder: ResponsePlaceholderRow = {
      kind: 'response-placeholder',
      renderKey: `response:${pendingResponse.operationId}`,
    };
    let previousAnswer = -1;
    if (pendingResponse.kind === 'regenerate') {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (rows[index]?.kind === 'assistant') {
          previousAnswer = index;
          break;
        }
      }
    }
    if (previousAnswer >= 0) rows.splice(previousAnswer, 1, placeholder);
    else rows.push(placeholder);
  }
  return { groups, rows, latestAssistantTurnIndex };
}
