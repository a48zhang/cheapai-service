import { describe, expect, it } from 'vitest';
import type { ConversationDetail } from '@cheapai/contracts/chat';
import { mergeConversationDetail } from './reconcile';

const conversation = {
  id: 'conversation-reconcile',
  title: 'Chat',
  groupId: 'group-1',
  modelId: 'model-1',
  version: 2,
  createdAt: 100,
  updatedAt: 200,
} as const;

function makeDetail(
  assistantStatus: 'generating' | 'completed',
  assistantContent: string,
  assistantSelected: boolean,
  previousSelected: boolean,
  requestId: string | null,
  groupId: string | null,
  modelId: string | null,
): ConversationDetail {
  return {
    conversation,
    messages: [
      {
        id: 'user-message',
        conversationId: conversation.id,
        turnIndex: 0,
        role: 'user',
        content: 'Question',
        status: 'completed',
        variant: 1,
        selected: true,
        requestId: null,
        groupId: null,
        modelId: null,
        createdAt: 100,
        updatedAt: 100,
      },
      {
        id: 'assistant-previous',
        conversationId: conversation.id,
        turnIndex: 0,
        role: 'assistant',
        content: 'Earlier answer',
        status: 'completed',
        variant: 1,
        selected: previousSelected,
        requestId: 'request-previous',
        groupId: 'group-previous',
        modelId: 'model-previous',
        createdAt: 110,
        updatedAt: 110,
      },
      {
        id: 'assistant-regenerated',
        conversationId: conversation.id,
        turnIndex: 0,
        role: 'assistant',
        content: assistantContent,
        status: assistantStatus,
        variant: 2,
        selected: assistantSelected,
        requestId,
        groupId,
        modelId,
        createdAt: 200,
        updatedAt: 200,
      },
    ],
  };
}

describe('mergeConversationDetail', () => {
  it('accepts same-version server selection after the stream snapshot temporarily selects both variants', () => {
    const streamSnapshot = makeDetail(
      'completed',
      'Persisted answer',
      true,
      true,
      'request-final',
      'group-final',
      'model-final',
    );
    const serverSnapshot = makeDetail(
      'completed',
      'Persisted answer',
      true,
      false,
      'request-final',
      'group-final',
      'model-final',
    );

    const merged = mergeConversationDetail(streamSnapshot, serverSnapshot);

    expect(
      merged.messages
        .filter((message) => message.role === 'assistant' && message.selected)
        .map((message) => message.id),
    ).toEqual(['assistant-regenerated']);
    expect(merged.conversation.version).toBe(serverSnapshot.conversation.version);
  });

  it('preserves terminal message and turn selection over a same-time generating snapshot', () => {
    const completed = makeDetail(
      'completed',
      'Persisted answer',
      true,
      false,
      'request-final',
      'group-final',
      'model-final',
    );
    const staleGenerating = makeDetail(
      'generating',
      '',
      false,
      true,
      null,
      'group-stale',
      'model-stale',
    );

    const merged = mergeConversationDetail(completed, staleGenerating);
    const terminal = merged.messages.find((message) => message.id === 'assistant-regenerated');

    expect(terminal).toMatchObject({
      content: 'Persisted answer',
      status: 'completed',
      selected: true,
      requestId: 'request-final',
      groupId: 'group-final',
      modelId: 'model-final',
    });
    expect(
      merged.messages
        .filter((message) => message.role === 'assistant' && message.selected)
        .map((message) => message.id),
    ).toEqual(['assistant-regenerated']);
    expect(merged.conversation.version).toBe(completed.conversation.version);

    const selectionWithNewVersion: ConversationDetail = {
      conversation: { ...conversation, version: 3, updatedAt: 201 },
      messages: completed.messages.map((message) =>
        message.id === 'assistant-regenerated'
          ? { ...message, selected: false }
          : message.id === 'assistant-previous'
            ? { ...message, selected: true }
            : message,
      ),
    };
    const selected = mergeConversationDetail(merged, selectionWithNewVersion);
    expect(
      selected.messages
        .filter((message) => message.role === 'assistant' && message.selected)
        .map((message) => message.id),
    ).toEqual(['assistant-previous']);
  });
});
