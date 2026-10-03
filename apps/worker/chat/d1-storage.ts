import type { ChatStorage } from './storage';
import { createConversation as createStoredConversation, deleteConversation as deleteStoredConversation,
  getConversationWithMessages, listConversations as listStoredConversations, updateConversation as updateStoredConversation } from './messages';
import { acceptRegenerate, acceptSend, attachRequest, checkpoint, finalize, readContext, selectMessageVersion } from './messages';
import type { AcceptRegenerateInput, AcceptSendInput, CheckpointInput, FinalizeInput, SelectMessageVersionInput } from './types';

/** Adapter to the storage owner's atomic state machine.  Keeping this bridge
 * separate lets the HTTP service remain responsible for protocol/auth orchestration
 * while all ownership, CAS, idempotency and generation-lock SQL stays in
 * `chat/messages.ts` and `chat/repository.ts`. */
export function createD1ChatStorage(database: D1Database): ChatStorage {
  return {
    listConversations: (userId, cursor, limit) => listStoredConversations(database, userId, { cursor, limit }),
    getConversation: (userId, conversationId) => getConversationWithMessages(database, userId, conversationId),
    createConversation: (userId, input) => createStoredConversation(database, userId, input),
    updateConversation: (userId, conversationId, expectedVersion, patch, now) =>
      updateStoredConversation(database, userId, conversationId, expectedVersion, patch, now),
    deleteConversation: (userId, conversationId, expectedVersion) =>
      deleteStoredConversation(database, userId, conversationId, expectedVersion),
    async startMessage(userId, conversationId, input) {
      const identity = { userId, conversationId, operationId: input.operationId, conversationVersion: input.conversationVersion,
        groupId: input.groupId, modelId: input.modelId, now: input.now };
      const result = input.regenerate
        ? await acceptRegenerate(database, { ...identity, assistantMessageId: undefined } satisfies AcceptRegenerateInput)
        : await acceptSend(database, { ...identity, content: input.content ?? '', assistantMessageId: undefined, userMessageId: undefined } satisfies AcceptSendInput);
      if (result.replayed) return { kind: 'replayed', conversation: result.conversation, messages: result.messages };
      const contextRows = await readContext(database, userId, conversationId);
      // Regeneration is a new answer for the same final user turn.  The old
      // selected assistant variant remains durable until the new answer is
      // finalized, but it must never be sent as a prompt suffix.
      const context = contextRows
        .filter(message => !input.regenerate || message.role === 'user' || message.turnIndex !== result.assistantMessage.turnIndex)
        .map(message => ({ role: message.role, content: message.content }));
      return { kind: 'accepted', conversation: result.conversation, userMessage: result.userMessage,
        assistantMessage: result.assistantMessage, context };
    },
    async associateRequest(userId, conversationId, assistantMessageId, _operationId, requestId, now) {
      const message = await attachRequest(database, { userId, messageId: assistantMessageId, requestId, now });
      return message.conversationId === conversationId && (message.requestId === requestId);
    },
    async saveAssistantProgress(userId, _conversationId, assistantMessageId, content, now) {
      await checkpoint(database, { userId, messageId: assistantMessageId, content, now } satisfies CheckpointInput);
    },
    finishAssistant(userId, _conversationId, assistantMessageId, status, content, now) {
      return finalize(database, { userId, messageId: assistantMessageId, content, status, now } satisfies FinalizeInput);
    },
    selectVersion(userId, conversationId, messageId, expectedConversationVersion, now) {
      return selectMessageVersion(database, { userId, conversationId, messageId, conversationVersion: expectedConversationVersion, now } satisfies SelectMessageVersionInput);
    },
  };
}
