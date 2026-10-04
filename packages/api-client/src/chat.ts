import {
  decodeChatModels,
  decodeConversation,
  decodeConversationDetail,
  decodeConversationPage,
  decodeDeleted,
  chatRegenerateInputSchema,
  chatSendInputSchema,
} from '@cheapai/contracts/chat';
import type {
  ChatList,
  ChatModels,
  ChatRegenerateInput,
  ChatSendInput,
  ChatSendResult,
  ChatSelectInput,
  ChatStreamHandlers,
  Conversation,
  ConversationCreateInput,
  ConversationDetail,
  ConversationPatchInput,
} from '@cheapai/contracts/chat';
import { createAuthApi } from './auth.js';
import { ApiClientError } from './errors.js';
import { readCsrfCookie } from './csrf.js';
import { createApiClient } from './client.js';
import { sendChatStream } from './chat-stream.js';
import type { ApiClient, ApiClientOptions, ApiReadOptions } from './types.js';

export type {
  ChatList,
  ChatMessage,
  ChatMessageStatus,
  ChatModel,
  ChatModels,
  ChatGroup,
  ChatRegenerateInput,
  ChatReplayResult,
  ChatRole,
  ChatSendInput,
  ChatSendResult,
  ChatSelectInput,
  ChatStreamHandlers,
  ChatStreamResult,
  Conversation,
  ConversationCreateInput,
  ConversationDetail,
  ConversationPage,
  ConversationPatchInput,
} from '@cheapai/contracts/chat';
export {
  decodeChatMessage,
  decodeChatModels,
  decodeChatReplay,
  decodeConversation,
  decodeConversationDetail,
  decodeConversationPage,
  decodeDeleted,
} from '@cheapai/contracts/chat';

export interface ChatApiOptions extends ApiClientOptions {
  readonly client?: ApiClient;
}

export interface ChatApi {
  models(options?: ApiReadOptions): Promise<ChatModels>;
  listConversations(cursor?: string | null, options?: ApiReadOptions): Promise<ChatList>;
  getConversation(id: string, options?: ApiReadOptions): Promise<ConversationDetail>;
  createConversation(input?: ConversationCreateInput): Promise<Conversation>;
  updateConversation(id: string, input: ConversationPatchInput): Promise<Conversation>;
  deleteConversation(id: string, version: number): Promise<{ readonly deleted: true }>;
  sendMessage(
    id: string,
    input: ChatSendInput,
    handlers?: ChatStreamHandlers,
    signal?: AbortSignal,
  ): Promise<ChatSendResult>;
  regenerate(
    id: string,
    input: ChatRegenerateInput,
    handlers?: ChatStreamHandlers,
    signal?: AbortSignal,
  ): Promise<ChatSendResult>;
  selectVersion(id: string, input: ChatSelectInput): Promise<ConversationDetail>;
}

const nonEmptyText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value;

function validId(value: string, label: string): string {
  if (!nonEmptyText(value, 256) || /[\u0000-\u0020\u007f\\/?#]/u.test(value)) {
    throw new ApiClientError('request', label + '无效。');
  }
  return encodeURIComponent(value);
}

export function createChatApi(options: ChatApiOptions = {}): ChatApi {
  const { client: injectedClient, ...clientOptions } = options;
  const authApi = createAuthApi(clientOptions);
  const csrfToken =
    clientOptions.getCsrfToken ??
    (async () => readCsrfCookie() ?? (await authApi.bootstrap()).csrfToken);
  const client = injectedClient ?? createApiClient({ ...clientOptions, getCsrfToken: csrfToken });
  const streamOptions = { ...clientOptions, getCsrfToken: csrfToken };
  const conversationPath = (id: string): string =>
    '/api/v1/chat/conversations/' + validId(id, '会话编号');

  const api: ChatApi = Object.freeze({
    async models(readOptions?: ApiReadOptions): Promise<ChatModels> {
      return (
        await client.get('/api/v1/chat/models', {
          decode: decodeChatModels,
          ...(readOptions?.signal === undefined ? {} : { signal: readOptions.signal }),
        })
      ).data;
    },
    async listConversations(
      cursor?: string | null,
      readOptions?: ApiReadOptions,
    ): Promise<ChatList> {
      return (
        await client.get('/api/v1/chat/conversations', {
          query: { cursor: cursor ?? null },
          decode: decodeConversationPage,
          ...(readOptions?.signal === undefined ? {} : { signal: readOptions.signal }),
        })
      ).data;
    },
    async getConversation(id: string, readOptions?: ApiReadOptions): Promise<ConversationDetail> {
      return (
        await client.get(conversationPath(id), {
          decode: decodeConversationDetail,
          ...(readOptions?.signal === undefined ? {} : { signal: readOptions.signal }),
        })
      ).data;
    },
    async createConversation(input: ConversationCreateInput = {}): Promise<Conversation> {
      return (
        await client.post(
          '/api/v1/chat/conversations',
          {
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
            ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
          },
          { decode: decodeConversation },
        )
      ).data;
    },
    async updateConversation(id: string, input: ConversationPatchInput): Promise<Conversation> {
      return (
        await client.patch(
          conversationPath(id),
          {
            version: input.version,
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
            ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
          },
          { decode: decodeConversation },
        )
      ).data;
    },
    async deleteConversation(id: string, version: number): Promise<{ readonly deleted: true }> {
      return (await client.delete(conversationPath(id), { version }, { decode: decodeDeleted }))
        .data;
    },
    async sendMessage(
      id: string,
      input: ChatSendInput,
      handlers: ChatStreamHandlers = {},
      signal?: AbortSignal,
    ): Promise<ChatSendResult> {
      const parsed = chatSendInputSchema.safeParse(input);
      if (!parsed.success) throw new ApiClientError('request', '聊天请求参数无效。');
      const body = {
        operationId: parsed.data.operationId,
        conversationVersion: parsed.data.conversationVersion,
        groupId: parsed.data.groupId,
        modelId: parsed.data.modelId,
        content: parsed.data.content,
      };
      return sendChatStream(conversationPath(id) + '/messages', body, {
        ...streamOptions,
        handlers,
        ...(signal === undefined ? {} : { signal }),
      });
    },
    async regenerate(
      id: string,
      input: ChatRegenerateInput,
      handlers: ChatStreamHandlers = {},
      signal?: AbortSignal,
    ): Promise<ChatSendResult> {
      const parsed = chatRegenerateInputSchema.safeParse(input);
      if (!parsed.success) throw new ApiClientError('request', '重新生成参数无效。');
      const body = {
        operationId: parsed.data.operationId,
        conversationVersion: parsed.data.conversationVersion,
        groupId: parsed.data.groupId,
        modelId: parsed.data.modelId,
      };
      return sendChatStream(conversationPath(id) + '/regenerate', body, {
        ...streamOptions,
        handlers,
        ...(signal === undefined ? {} : { signal }),
      });
    },
    async selectVersion(id: string, input: ChatSelectInput): Promise<ConversationDetail> {
      return (
        await client.post(
          conversationPath(id) + '/select',
          {
            conversationVersion: input.conversationVersion,
            messageId: input.messageId,
          },
          { decode: decodeConversationDetail },
        )
      ).data;
    },
  });
  return api;
}

export const chatApi = createChatApi();
