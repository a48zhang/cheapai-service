import type { Conversation, ConversationPage, ConversationWithMessages, Message, ChatMessageRole, ChatMessageStatus as StoredChatMessageStatus } from './types';

export type ChatRole = ChatMessageRole;
export type ChatMessageStatus = StoredChatMessageStatus;
export type ChatConversation = Conversation;
export type ChatMessage = Message;
export type ChatConversationPage = ConversationPage;
export interface ChatConversationView extends ConversationWithMessages {}
export interface ChatContextMessage { readonly role: ChatRole; readonly content: string }

export interface ChatStorageStartInput {
  readonly operationId: string;
  readonly groupId: string;
  readonly modelId: string;
  readonly content?: string;
  readonly conversationVersion: number;
  readonly now: number;
  readonly regenerate: boolean;
}

export interface ChatStorageAccepted {
  readonly kind: 'accepted';
  readonly conversation: ChatConversation;
  readonly userMessage: ChatMessage | null;
  readonly assistantMessage: ChatMessage;
  /** Server-selected current variants only; clients cannot submit history. */
  readonly context: readonly ChatContextMessage[];
}
export interface ChatStorageReplay {
  readonly kind: 'replayed';
  readonly conversation: ChatConversation;
  readonly messages: readonly ChatMessage[];
}
export type ChatStorageStartResult = ChatStorageAccepted | ChatStorageReplay;

/** Storage owns all CAS/unique operation and generation-lock guarantees.  The
 * chat API never constructs a message row itself, so a late stream cannot
 * resurrect a deleted or replaced conversation. */
export interface ChatStorage {
  listConversations(userId: string, cursor: string | null, limit: number): Promise<ChatConversationPage>;
  getConversation(userId: string, conversationId: string): Promise<ChatConversationView | null>;
  createConversation(userId: string, input: { title?: string; groupId?: string | null; modelId?: string | null; now: number }): Promise<ChatConversation>;
  updateConversation(userId: string, conversationId: string, expectedVersion: number, patch: { title?: string; groupId?: string | null; modelId?: string | null }, now: number): Promise<ChatConversation>;
  deleteConversation(userId: string, conversationId: string, expectedVersion: number, now: number): Promise<boolean>;
  startMessage(userId: string, conversationId: string, input: ChatStorageStartInput): Promise<ChatStorageStartResult>;
  associateRequest(userId: string, conversationId: string, assistantMessageId: string, operationId: string, requestId: string, now: number): Promise<boolean>;
  saveAssistantProgress(userId: string, conversationId: string, assistantMessageId: string, content: string, now: number): Promise<void>;
  finishAssistant(userId: string, conversationId: string, assistantMessageId: string, status: Exclude<ChatMessageStatus, 'generating'>, content: string, now: number): Promise<ChatMessage>;
  selectVersion(userId: string, conversationId: string, messageId: string, expectedConversationVersion: number, now: number): Promise<ChatConversationView>;
}
