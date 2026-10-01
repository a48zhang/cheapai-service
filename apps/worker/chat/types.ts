/**
 * Storage/HTTP boundary for web chat.  The web bundle has its own decoder;
 * these types are kept in the worker so routes and repositories share one
 * spelling of the persisted state.
 */

export type ChatMessageRole = 'user' | 'assistant';
export type ChatMessageStatus = 'generating' | 'completed' | 'stopped' | 'failed';

export interface Conversation {
  readonly id: string;
  readonly title: string;
  readonly groupId: string | null;
  readonly modelId: string | null;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Message {
  readonly id: string;
  readonly conversationId: string;
  readonly turnIndex: number;
  readonly role: ChatMessageRole;
  readonly content: string;
  readonly status: ChatMessageStatus;
  readonly variant: number;
  readonly selected: boolean;
  readonly requestId: string | null;
  readonly groupId: string | null;
  readonly modelId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ConversationWithMessages {
  readonly conversation: Conversation;
  readonly messages: readonly Message[];
}

export interface ConversationListOptions {
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface CreateConversationInput {
  readonly id?: string;
  readonly title?: string;
  readonly groupId?: string | null;
  readonly modelId?: string | null;
  readonly now: number;
}

export interface UpdateConversationInput {
  readonly title?: string;
  readonly groupId?: string | null;
  readonly modelId?: string | null;
}

export interface ChatMessageInputIdentity {
  readonly userId: string;
  readonly conversationId: string;
  readonly operationId: string;
  readonly conversationVersion: number;
  readonly groupId: string | null;
  readonly modelId: string | null;
  readonly now: number;
}

export interface AcceptSendInput extends ChatMessageInputIdentity {
  readonly content: string;
  /** Optional IDs make deterministic local fixtures possible; production may omit them. */
  readonly userMessageId?: string | undefined;
  readonly assistantMessageId?: string | undefined;
}

export interface AcceptRegenerateInput extends ChatMessageInputIdentity {
  readonly assistantMessageId?: string | undefined;
}

export interface AttachRequestInput {
  readonly userId: string;
  readonly messageId: string;
  readonly requestId: string;
  readonly now: number;
  readonly conversationId?: string | undefined;
  readonly operationId?: string | undefined;
}

export interface CheckpointInput {
  readonly userId: string;
  readonly messageId: string;
  readonly content: string;
  readonly now: number;
}

export interface FinalizeInput {
  readonly userId: string;
  readonly messageId: string;
  readonly content: string;
  readonly status: Exclude<ChatMessageStatus, 'generating'>;
  readonly now: number;
}

export interface SelectMessageVersionInput {
  readonly userId: string;
  readonly conversationId: string;
  readonly messageId: string;
  readonly conversationVersion: number;
  readonly now: number;
}

export interface ChatMutationResult {
  readonly conversation: Conversation;
  readonly userMessage: Message | null;
  readonly assistantMessage: Message;
  readonly messages: readonly Message[];
  readonly replayed: boolean;
}

export interface SelectMessageVersionResult {
  readonly conversation: Conversation;
  readonly messages: readonly Message[];
}

export interface ConversationPage {
  readonly items: readonly Conversation[];
  readonly nextCursor: string | null;
}

export interface ChatConversationRow {
  id: string;
  user_id: string;
  title: string;
  group_id: string | null;
  model_id: string | null;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface ChatMessageRow {
  id: string;
  conversation_id: string;
  turn_index: number;
  role: ChatMessageRole;
  content: string;
  status: ChatMessageStatus;
  variant: number;
  selected: number;
  operation_id: string | null;
  request_id: string | null;
  group_id: string | null;
  model_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface ChatGenerationRecoveryResult {
  readonly recovered: number;
  readonly messages: readonly Message[];
}
