import type { ChatRegenerateInput, ChatSelectInput, ConversationDetail } from '@cheapai/contracts/chat';
import { canRegenerateLastAssistant, canSelectAssistantVariant } from './variants';
import type { RegenerateBlockReason, SelectVariantBlockReason } from './variants';

export interface RegenerateCommand {
  readonly groupId: string;
  readonly modelId: string;
  readonly maxOutputTokens?: number;
}

export type PrepareRegenerateResult =
  | { readonly accepted: true; readonly input: ChatRegenerateInput; readonly previousMessageId: string }
  | { readonly accepted: false; readonly reason: RegenerateBlockReason };

/** Captures the selected final turn and conversation version at command time. */
export function prepareRegenerateCommand(
  detail: ConversationDetail | null,
  command: RegenerateCommand,
  operationId: string,
): PrepareRegenerateResult {
  const availability = canRegenerateLastAssistant(detail);
  if (!availability.allowed) return { accepted: false, reason: availability.reason };
  return {
    accepted: true,
    previousMessageId: availability.assistant.id,
    input: {
      operationId,
      conversationVersion: availability.conversationVersion,
      groupId: command.groupId,
      modelId: command.modelId,
      ...(command.maxOutputTokens === undefined ? {} : { maxOutputTokens: command.maxOutputTokens }),
    },
  };
}

export type PrepareSelectVersionResult =
  | { readonly accepted: true; readonly input: ChatSelectInput }
  | { readonly accepted: false; readonly reason: SelectVariantBlockReason };

/** Captures a current final variant; the server remains the source of selected state. */
export function prepareSelectVersionCommand(
  detail: ConversationDetail | null,
  messageId: string,
): PrepareSelectVersionResult {
  const availability = canSelectAssistantVariant(detail, messageId);
  if (!availability.allowed) return { accepted: false, reason: availability.reason };
  return {
    accepted: true,
    input: {
      conversationVersion: availability.conversationVersion,
      messageId: availability.message.id,
    },
  };
}
