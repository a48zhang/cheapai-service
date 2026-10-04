import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@cheapai/api-client/errors';
import type { ChatApi, ChatStreamHandlers } from '@cheapai/api-client/chat';
import type {
  ChatMessage,
  ChatRegenerateInput,
  ChatSendInput,
  ChatSendResult,
  Conversation,
  ConversationDetail,
} from '@cheapai/contracts/chat';
import { createChatController } from './controller';
import { mergeConversationDetail } from './reconcile';

const timestamp = 1_700_000_000_000;

function makeConversation(id: string, version = 1): Conversation {
  return {
    id,
    title: 'Chat',
    groupId: 'group-1',
    modelId: 'model-1',
    version,
    createdAt: timestamp,
    updatedAt: timestamp + version,
  };
}

function makeMessage(
  id: string,
  role: ChatMessage['role'],
  turnIndex: number,
  patch: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    conversationId: 'controller-conversation',
    turnIndex,
    role,
    content: role === 'user' ? 'Question' : 'Answer',
    status: 'completed',
    variant: 1,
    selected: true,
    requestId: role === 'assistant' ? 'request-old' : null,
    groupId: 'group-1',
    modelId: 'model-1',
    createdAt: timestamp,
    updatedAt: timestamp,
    ...patch,
  };
}

function makeDetail(
  id = 'controller-conversation',
  version = 1,
  messages?: readonly ChatMessage[],
): ConversationDetail {
  return {
    conversation: makeConversation(id, version),
    messages: messages
      ? [...messages]
      : [
          makeMessage('user-old', 'user', 0, { conversationId: id }),
          makeMessage('assistant-old', 'assistant', 0, { conversationId: id }),
        ],
  };
}

function makeApi(overrides: Partial<ChatApi> = {}): ChatApi {
  return {
    getConversation: vi.fn(),
    sendMessage: vi.fn(),
    regenerate: vi.fn(),
    selectVersion: vi.fn(),
    ...overrides,
  } as unknown as ChatApi;
}

function generatedDetail(
  previous: ConversationDetail,
  message: ChatMessage,
  version = previous.conversation.version + 1,
): ConversationDetail {
  return {
    conversation: makeConversation(previous.conversation.id, version),
    messages: [...previous.messages, message],
  };
}

function sendCommand(content = 'A new question') {
  return { content, groupId: 'group-1', modelId: 'model-1', maxOutputTokens: 2048 };
}

function regenerateCommand() {
  return { groupId: 'group-1', modelId: 'model-1', maxOutputTokens: 2048 };
}

describe('chat controller command lifecycle', () => {
  it('takes the synchronous send lock before the stream can yield', async () => {
    const initial = makeDetail('controller-lock');
    const assistant = makeMessage('assistant-new', 'assistant', 1, {
      conversationId: initial.conversation.id,
      content: 'New answer',
      requestId: 'request-new',
    });
    const final = generatedDetail(
      initial,
      makeMessage('user-new', 'user', 1, {
        conversationId: initial.conversation.id,
      }),
    );
    const finalDetail = { ...final, messages: [...final.messages, assistant] };
    const api = makeApi({
      getConversation: vi.fn(async () => finalDetail),
      sendMessage: vi.fn(
        async (_id: string, _input: ChatSendInput, handlers?: ChatStreamHandlers) => {
          await handlers?.onMeta?.({
            conversation: initial.conversation,
            userMessage: finalDetail.messages[2]!,
            assistantMessage: { ...assistant, content: '', status: 'generating' },
          });
          await handlers?.onDelta?.('New answer');
          await handlers?.onDone?.(assistant);
          return { kind: 'stream' as const, message: assistant };
        },
      ),
    });
    const controller = createChatController({
      api,
      getOwner: () => ({ userId: 'lock-user', epoch: 1 }),
      initialDetail: initial,
      conversationId: initial.conversation.id,
      idFactory: () => 'lock-operation',
    });

    const first = controller.send(sendCommand());
    await expect(controller.send(sendCommand('duplicate click'))).resolves.toBe('busy');
    await expect(first).resolves.toBe('completed');
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', detail: finalDetail });
  });

  it('publishes a conversation created after stop and allows sending after route sync', async () => {
    const created = makeConversation('controller-stop-during-create');
    const userMessage = makeMessage('user-after-create-stop', 'user', 0, {
      conversationId: created.id,
    });
    const assistant = makeMessage('assistant-after-create-stop', 'assistant', 0, {
      conversationId: created.id,
      content: 'Sent after route sync',
      requestId: 'request-after-create-stop',
    });
    const finalDetail: ConversationDetail = {
      conversation: makeConversation(created.id, 2),
      messages: [userMessage, assistant],
    };
    let resolveCreate!: (conversation: Conversation) => void;
    let operationSequence = 0;
    const publishedConversation = vi.fn((id: string) => controller.syncConversation(id));
    const createConversation = vi.fn(
      () =>
        new Promise<Conversation>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const sendMessage = vi.fn(async () => ({ kind: 'stream' as const, message: assistant }));
    const api = makeApi({
      createConversation,
      getConversation: vi.fn(async () => finalDetail),
      sendMessage,
    });
    const controller: ReturnType<typeof createChatController> = createChatController({
      api,
      getOwner: () => ({ userId: 'stop-create-user', epoch: 1 }),
      idFactory: () => `stop-create-operation-${++operationSequence}`,
      onConversationCreated: (conversation) => publishedConversation(conversation.id),
    });

    const stoppedSend = controller.send(sendCommand('Do not send after stop'));
    expect(createConversation).toHaveBeenCalledTimes(1);
    const stop = controller.stop();
    resolveCreate(created);
    await expect(stop).resolves.toBe('stopped');
    await expect(stoppedSend).resolves.toBe('stopped');
    expect(publishedConversation).toHaveBeenCalledWith(created.id);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'idle',
      detail: { conversation: created, messages: [] },
    });

    await expect(controller.send(sendCommand('Send after route sync'))).resolves.toBe('completed');
    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('blocks a second create after an unknown create result until explicit reset', async () => {
    const created = makeConversation('controller-create-after-reset');
    let createCount = 0;
    const createConversation = vi.fn(async () => {
      createCount += 1;
      if (createCount === 1) throw new ApiClientError('network', 'create response lost');
      return created;
    });
    const sendMessage = vi.fn(async () => {
      throw new ApiClientError('api', 'invalid request', { status: 400, code: 'invalid_request' });
    });
    const controller = createChatController({
      api: makeApi({ createConversation, sendMessage }),
      getOwner: () => ({ userId: 'unknown-create-user', epoch: 1 }),
      idFactory: () => 'unknown-create-operation',
    });

    await expect(controller.send(sendCommand('Keep this draft'))).resolves.toBe('interrupted');
    expect(controller.getSnapshot().failure).toMatchObject({
      code: 'conversation_creation_unknown',
    });
    await expect(controller.send(sendCommand('Do not create twice'))).resolves.toBe('interrupted');
    expect(createConversation).toHaveBeenCalledTimes(1);

    controller.resetConversation();
    await expect(controller.send(sendCommand('Explicit new conversation'))).resolves.toBe(
      'rejected',
    );
    expect(createConversation).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('cancels an old route run, keeps its operation retryable, and ignores its late snapshot', async () => {
    const first = makeDetail('controller-route-first');
    const second = makeDetail('controller-route-second');
    let handlers: ChatStreamHandlers | undefined;
    let signal: AbortSignal | undefined;
    let resolveStream!: (result: ChatSendResult) => void;
    const api = makeApi({
      getConversation: vi.fn(),
      sendMessage: vi.fn(
        async (
          _id: string,
          _input: ChatSendInput,
          streamHandlers?: ChatStreamHandlers,
          requestSignal?: AbortSignal,
        ) => {
          handlers = streamHandlers;
          signal = requestSignal;
          return new Promise<ChatSendResult>((resolve) => {
            resolveStream = resolve;
          });
        },
      ),
    });
    const controller = createChatController({
      api,
      getOwner: () => ({ userId: 'route-user', epoch: 1 }),
      initialDetail: first,
      conversationId: first.conversation.id,
      idFactory: () => 'route-operation-id',
    });

    const oldRun = controller.send(sendCommand('keep this operation'));
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    controller.syncConversation(second.conversation.id);
    expect(signal?.aborted).toBe(true);
    controller.hydrate(first);
    controller.hydrate(second);
    await handlers?.onDelta?.('late text');
    expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', detail: second });
    expect(api.getConversation).not.toHaveBeenCalled();

    resolveStream({
      kind: 'stream',
      message: makeMessage('assistant-late', 'assistant', 1, {
        conversationId: first.conversation.id,
      }),
    });
    await expect(oldRun).resolves.toBe('superseded');

    controller.syncConversation(first.conversation.id);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'interrupted',
      operationId: 'route-operation-id',
    });
    controller.dispose();
  });

  it('recovers an unknown send after a same-user epoch change with the original operation and body', async () => {
    const initial = makeDetail('controller-same-user-recovery');
    const owner = { userId: 'recover-user', epoch: 1 };
    const firstBodies: unknown[] = [];
    const oldApi = makeApi({
      getConversation: vi.fn(async () => initial),
      sendMessage: vi.fn(async (_id: string, input: ChatSendInput) => {
        firstBodies.push(input);
        throw new ApiClientError('network', 'response lost');
      }),
    });
    const oldController = createChatController({
      api: oldApi,
      getOwner: () => owner,
      initialDetail: initial,
      conversationId: initial.conversation.id,
      idFactory: () => 'same-operation-id',
    });
    await expect(oldController.send(sendCommand('fixed original prompt'))).resolves.toBe(
      'interrupted',
    );
    expect(oldController.getSnapshot().phase).toBe('interrupted');
    oldController.dispose();

    const finalAssistant = makeMessage('assistant-replayed', 'assistant', 1, {
      conversationId: initial.conversation.id,
      content: 'Recovered answer',
      requestId: 'request-replayed',
    });
    const finalDetail = generatedDetail(
      initial,
      makeMessage('user-replayed', 'user', 1, {
        conversationId: initial.conversation.id,
      }),
    );
    const completed = { ...finalDetail, messages: [...finalDetail.messages, finalAssistant] };
    const retryBodies: unknown[] = [];
    const newApi = makeApi({
      getConversation: vi.fn(async () => completed),
      sendMessage: vi.fn(async (_id: string, input: ChatSendInput) => {
        retryBodies.push(input);
        return { kind: 'replay' as const, replayed: true as const, ...completed };
      }),
    });
    const newController = createChatController({
      api: newApi,
      getOwner: () => ({ userId: 'recover-user', epoch: 2 }),
      initialDetail: initial,
      conversationId: initial.conversation.id,
      idFactory: () => 'must-not-replace-existing-id',
    });

    expect(newController.getSnapshot()).toMatchObject({
      phase: 'interrupted',
      operationId: 'same-operation-id',
    });
    await expect(newController.retry()).resolves.toBe('completed');
    expect(retryBodies[0]).toEqual(firstBodies[0]);
    expect(retryBodies[0]).toMatchObject({
      operationId: 'same-operation-id',
      content: 'fixed original prompt',
    });
  });

  it('does not expose another user’s pending operation to retry', async () => {
    const initial = makeDetail('controller-user-boundary');
    const previous = createChatController({
      api: makeApi({
        getConversation: vi.fn(async () => initial),
        sendMessage: vi.fn(async () => {
          throw new ApiClientError('network', 'response lost');
        }),
      }),
      getOwner: () => ({ userId: 'owner-a', epoch: 1 }),
      initialDetail: initial,
      conversationId: initial.conversation.id,
      idFactory: () => 'private-owner-operation',
    });
    await expect(previous.send(sendCommand())).resolves.toBe('interrupted');
    previous.dispose();

    const retry = vi.fn();
    const other = createChatController({
      api: makeApi({ getConversation: vi.fn(async () => initial), sendMessage: retry }),
      getOwner: () => ({ userId: 'owner-b', epoch: 2 }),
      initialDetail: initial,
      conversationId: initial.conversation.id,
    });
    expect(other.getSnapshot().operationId).toBeNull();
    await expect(other.retry()).resolves.toBe('idle');
    expect(retry).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'completed' as const, expected: 'completed' as const },
    { status: 'failed' as const, expected: 'failed' as const },
  ])(
    'confirms a regenerate terminal status from conversation detail: $status',
    async ({ status, expected }) => {
      const initial = makeDetail('controller-regenerate-' + status);
      const assistant = makeMessage('assistant-regenerated-' + status, 'assistant', 0, {
        conversationId: initial.conversation.id,
        variant: 2,
        selected: status === 'completed',
        status,
        content: status === 'completed' ? 'Alternative answer' : '',
        requestId: 'request-regenerated-' + status,
      });
      const finalDetail: ConversationDetail = {
        conversation: makeConversation(initial.conversation.id, 2),
        messages: [
          ...initial.messages.map((message) =>
            message.id === 'assistant-old'
              ? { ...message, selected: status !== 'completed' }
              : message,
          ),
          assistant,
        ],
      };
      const api = makeApi({
        getConversation: vi.fn(async () => finalDetail),
        regenerate: vi.fn(
          async (_id: string, _input: ChatRegenerateInput, handlers?: ChatStreamHandlers) => {
            const generating = {
              ...assistant,
              status: 'generating' as const,
              content: '',
              selected: false,
            };
            await handlers?.onMeta?.({
              conversation: initial.conversation,
              userMessage: null,
              assistantMessage: generating,
            });
            if (status === 'failed') {
              await handlers?.onError?.({
                code: 'provider_error',
                message: 'provider failed',
                messageId: assistant.id,
              });
              throw new ApiClientError('api', 'provider failed', {
                status: 200,
                code: 'provider_error',
              });
            }
            await handlers?.onDone?.(assistant);
            return { kind: 'stream' as const, message: assistant };
          },
        ),
      });
      const controller = createChatController({
        api,
        getOwner: () => ({ userId: 'regenerate-user-' + status, epoch: 1 }),
        initialDetail: initial,
        conversationId: initial.conversation.id,
        idFactory: () => 'regenerate-operation-' + status,
      });

      await expect(controller.regenerate(regenerateCommand())).resolves.toBe(expected);
      expect(api.regenerate).toHaveBeenCalledTimes(1);
      expect(controller.getSnapshot().phase).toBe(status === 'failed' ? 'failed' : 'idle');
    },
  );

  it('aborts a regenerate stream on stop and trusts the confirmed stopped message', async () => {
    const initial = makeDetail('controller-regenerate-stop');
    const stopped = makeMessage('assistant-stopped', 'assistant', 0, {
      conversationId: initial.conversation.id,
      variant: 2,
      status: 'stopped',
      content: 'Partial answer',
      requestId: 'request-stopped',
    });
    const finalDetail: ConversationDetail = {
      conversation: makeConversation(initial.conversation.id, 2),
      messages: [
        ...initial.messages.map((message) =>
          message.id === 'assistant-old' ? { ...message, selected: false } : message,
        ),
        stopped,
      ],
    };
    const regenerate = vi.fn(
      async (
        _id: string,
        _input: ChatRegenerateInput,
        handlers: ChatStreamHandlers | undefined,
        signal?: AbortSignal,
      ) => {
        const pending = new Promise<ChatSendResult>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new ApiClientError('aborted', 'cancelled')),
            { once: true },
          );
        });
        await handlers?.onMeta?.({
          conversation: initial.conversation,
          userMessage: null,
          assistantMessage: { ...stopped, status: 'generating', content: '', selected: false },
        });
        return pending;
      },
    );
    const api = makeApi({
      getConversation: vi.fn(async () => finalDetail),
      regenerate,
    });
    const controller = createChatController({
      api,
      getOwner: () => ({ userId: 'stop-user', epoch: 1 }),
      initialDetail: initial,
      conversationId: initial.conversation.id,
      idFactory: () => 'stop-regenerate-operation',
    });

    const generation = controller.regenerate(regenerateCommand());
    await expect(controller.stop()).resolves.toBe('stopped');
    await expect(generation).resolves.toBe('stopped');
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', detail: finalDetail });
  });

  it('keeps the current selected version when a lower conversation version arrives late', () => {
    const base = makeDetail('controller-selection-cas');
    const selectedAlternative = makeMessage('assistant-alternative', 'assistant', 0, {
      conversationId: base.conversation.id,
      variant: 2,
      selected: true,
    });
    const current: ConversationDetail = {
      conversation: makeConversation(base.conversation.id, 3),
      messages: [
        ...base.messages.map((message) =>
          message.id === 'assistant-old' ? { ...message, selected: false } : message,
        ),
        selectedAlternative,
      ],
    };
    const stale: ConversationDetail = {
      conversation: makeConversation(base.conversation.id, 2),
      messages: base.messages,
    };

    const merged = mergeConversationDetail(current, stale);
    expect(merged).toBe(current);
    expect(
      merged.messages
        .filter((message) => message.role === 'assistant' && message.selected)
        .map((message) => message.id),
    ).toEqual(['assistant-alternative']);
  });

  it('ignores stale epoch events and disposal never marks an uncertain stream as failed', async () => {
    const initial = makeDetail('controller-stale-events');
    let owner = { userId: 'stale-user', epoch: 1 };
    let ownerChanged!: () => void;
    let handlers: ChatStreamHandlers | undefined;
    let signal: AbortSignal | undefined;
    const sendMessage = vi.fn(
      async (
        _id: string,
        _input: ChatSendInput,
        streamHandlers?: ChatStreamHandlers,
        requestSignal?: AbortSignal,
      ) => {
        handlers = streamHandlers;
        signal = requestSignal;
        const pending = new Promise<ChatSendResult>((_resolve, reject) => {
          requestSignal?.addEventListener(
            'abort',
            () => reject(new ApiClientError('aborted', 'cancelled')),
            { once: true },
          );
          if (requestSignal?.aborted) reject(new ApiClientError('aborted', 'cancelled'));
        });
        await streamHandlers?.onMeta?.({
          conversation: initial.conversation,
          userMessage: makeMessage('user-in-flight', 'user', 1, {
            conversationId: initial.conversation.id,
          }),
          assistantMessage: makeMessage('assistant-in-flight', 'assistant', 1, {
            conversationId: initial.conversation.id,
            status: 'generating',
            content: '',
          }),
        });
        return pending;
      },
    );
    const controller = createChatController({
      api: makeApi({ getConversation: vi.fn(async () => initial), sendMessage }),
      getOwner: () => owner,
      subscribeOwner: (listener) => {
        ownerChanged = listener;
        return () => undefined;
      },
      initialDetail: initial,
      conversationId: initial.conversation.id,
      idFactory: () => 'stale-epoch-operation',
    });
    const pending = controller.send(sendCommand());
    expect(sendMessage).toHaveBeenCalledTimes(1);
    owner = { userId: 'stale-user', epoch: 2 };
    ownerChanged();
    const oldText = controller.getSnapshot().streamText;
    await handlers?.onDelta?.('late delta');
    expect(signal?.aborted).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'idle',
      detail: null,
      streamText: oldText,
    });
    await expect(pending).resolves.toBe('superseded');

    const disposeDetail = makeDetail('controller-dispose-stream');
    let disposeSignal: AbortSignal | undefined;
    const disposable = createChatController({
      api: makeApi({
        getConversation: vi.fn(async () => disposeDetail),
        sendMessage: vi.fn(
          async (
            _id: string,
            _input: ChatSendInput,
            _handlers?: ChatStreamHandlers,
            requestSignal?: AbortSignal,
          ) => {
            disposeSignal = requestSignal;
            return new Promise<ChatSendResult>((_resolve, reject) => {
              requestSignal?.addEventListener(
                'abort',
                () => reject(new ApiClientError('aborted', 'cancelled')),
                { once: true },
              );
              if (requestSignal?.aborted) reject(new ApiClientError('aborted', 'cancelled'));
            });
          },
        ),
      }),
      getOwner: () => ({ userId: 'dispose-user', epoch: 1 }),
      initialDetail: disposeDetail,
      conversationId: disposeDetail.conversation.id,
      idFactory: () => 'disposed-operation',
    });
    const disposedRun = disposable.send(sendCommand());
    disposable.dispose();
    await expect(disposedRun).resolves.toBe('interrupted');
    expect(disposeSignal?.aborted).toBe(true);
    expect(disposable.getSnapshot().phase).not.toBe('failed');
  });
});
