import { ApiClientError, createApiClient, readCsrfCookie } from './client.js';
import { authApi } from './auth.js';
import type { ApiClientOptions, Page } from './types.js';

export type ChatRole = 'user' | 'assistant';
export type ChatMessageStatus = 'generating' | 'completed' | 'stopped' | 'failed';

export interface ChatModel {
  readonly publicModelId: string;
  /** Configured model output ceiling. It is absent only for older API responses. */
  readonly maxOutputTokens?: number;
}

export interface ChatGroup {
  readonly id: string;
  readonly name: string;
  readonly billingMultiplier: string;
  readonly models: readonly ChatModel[];
}

export interface Conversation {
  readonly id: string;
  readonly title: string;
  readonly groupId: string | null;
  readonly modelId: string | null;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ChatMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly turnIndex: number;
  readonly role: ChatRole;
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

export interface ConversationDetail {
  readonly conversation: Conversation;
  readonly messages: readonly ChatMessage[];
}

export interface ChatList extends Page<Conversation> {}

export interface ConversationCreateInput {
  readonly title?: string;
  readonly groupId?: string | null;
  readonly modelId?: string | null;
}

export interface ConversationPatchInput {
  readonly version: number;
  readonly title?: string;
  readonly groupId?: string | null;
  readonly modelId?: string | null;
}

export interface ChatSendInput {
  readonly operationId: string;
  readonly conversationVersion: number;
  readonly groupId: string;
  readonly modelId: string;
  readonly content: string;
  readonly maxOutputTokens?: number;
}

export interface ChatRegenerateInput {
  readonly operationId: string;
  readonly conversationVersion: number;
  readonly groupId: string;
  readonly modelId: string;
  readonly maxOutputTokens?: number;
}

export interface ChatSelectInput {
  readonly conversationVersion: number;
  readonly messageId: string;
}

export interface ChatMetaEvent {
  readonly conversation: Conversation;
  readonly userMessage: ChatMessage | null;
  readonly assistantMessage: ChatMessage;
}

export interface ChatErrorEvent {
  readonly code: string;
  readonly message: string;
  readonly messageId?: string;
}

export interface ChatStreamHandlers {
  readonly onMeta?: (value: ChatMetaEvent) => void | Promise<void>;
  readonly onDelta?: (text: string) => void | Promise<void>;
  readonly onDone?: (value: ChatMessage, billingStatus?: string) => void | Promise<void>;
  readonly onError?: (value: ChatErrorEvent) => void | Promise<void>;
}

export interface ChatStreamResult {
  readonly kind: 'stream';
  readonly message: ChatMessage;
  readonly billingStatus?: string;
}

export interface ChatReplayResult extends ConversationDetail {
  readonly kind: 'replay';
  readonly replayed: true;
}

export type ChatSendResult = ChatStreamResult | ChatReplayResult;

export interface ChatApiOptions extends Pick<ApiClientOptions, 'fetch'> {
  readonly getCsrfToken?: () => string | null | undefined | Promise<string | null | undefined>;
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 512): value is string => typeof value === 'string' && value.length <= max && value.trim() === value;
const nonEmptyText = (value: unknown, max = 512): value is string => text(value, max) && value.length > 0;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const positive = (value: unknown): value is number => count(value) && value > 0;
const nullableText = (value: unknown, max = 512): value is string | null => value === null || nonEmptyText(value, max);
const messageStatus = (value: unknown): value is ChatMessageStatus => value === 'generating' || value === 'completed' || value === 'stopped' || value === 'failed';
const role = (value: unknown): value is ChatRole => value === 'user' || value === 'assistant';

function invalid(): never { throw new TypeError('聊天响应数据结构无效。'); }

function decodeModel(value: unknown): ChatModel {
  if (!object(value) || !nonEmptyText(value.publicModelId, 256)) invalid();
  const maxOutputTokens = value.maxOutputTokens;
  if (maxOutputTokens === undefined) return { publicModelId: value.publicModelId };
  if (!positive(maxOutputTokens)) invalid();
  return { publicModelId: value.publicModelId, maxOutputTokens };
}

export function decodeChatModels(value: unknown): { readonly items: readonly ChatGroup[] } {
  if (!object(value) || !Array.isArray(value.items)) invalid();
  const items = value.items.map(item => {
    if (!object(item) || !nonEmptyText(item.id, 128) || !nonEmptyText(item.name, 256)
      || !text(item.billingMultiplier, 128) || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(item.billingMultiplier)
      || !Array.isArray(item.models)) invalid();
    return { id: item.id, name: item.name, billingMultiplier: item.billingMultiplier, models: item.models.map(decodeModel) };
  });
  return { items };
}

export function decodeConversation(value: unknown): Conversation {
  if (!object(value) || !nonEmptyText(value.id, 128) || !text(value.title, 512)
    || !nullableText(value.groupId, 128) || !nullableText(value.modelId, 256)
    || !positive(value.version) || !count(value.createdAt) || !count(value.updatedAt) || value.updatedAt < value.createdAt) invalid();
  return { id: value.id, title: value.title, groupId: value.groupId, modelId: value.modelId, version: value.version,
    createdAt: value.createdAt, updatedAt: value.updatedAt };
}

export function decodeChatMessage(value: unknown): ChatMessage {
  if (!object(value) || !nonEmptyText(value.id, 128) || !nonEmptyText(value.conversationId, 128)
    || !count(value.turnIndex) || !role(value.role) || !text(value.content, 1_000_000) || !messageStatus(value.status)
    || !positive(value.variant) || typeof value.selected !== 'boolean' || !nullableText(value.requestId, 256)
    || !nullableText(value.groupId, 128) || !nullableText(value.modelId, 256) || !count(value.createdAt) || !count(value.updatedAt)
    || value.updatedAt < value.createdAt) invalid();
  return { id: value.id, conversationId: value.conversationId, turnIndex: value.turnIndex, role: value.role, content: value.content,
    status: value.status, variant: value.variant, selected: value.selected, requestId: value.requestId, groupId: value.groupId,
    modelId: value.modelId, createdAt: value.createdAt, updatedAt: value.updatedAt };
}

export function decodeConversationDetail(value: unknown): ConversationDetail {
  if (!object(value) || !Object.hasOwn(value, 'conversation') || !Array.isArray(value.messages)) invalid();
  return { conversation: decodeConversation(value.conversation), messages: value.messages.map(decodeChatMessage) };
}

function decodeConversationPage(value: unknown): ChatList {
  if (!object(value) || !Array.isArray(value.items) || !(value.nextCursor === null || text(value.nextCursor, 2048))) invalid();
  return { items: value.items.map(decodeConversation), nextCursor: value.nextCursor };
}

function decodeDeleted(value: unknown): { readonly deleted: true } {
  if (!object(value) || value.deleted !== true) invalid();
  return { deleted: true };
}

const validId = (value: string, label: string): string => {
  if (!nonEmptyText(value, 256) || /[\u0000-\u0020\u007f\\/?#]/u.test(value)) throw new ApiClientError('request', `${label}无效。`);
  return encodeURIComponent(value);
};

function bodyWithOutput<T extends Record<string, unknown>>(body: T, maxOutputTokens: number | undefined): T & Record<string, unknown> {
  return maxOutputTokens === undefined ? body : { ...body, maxOutputTokens };
}

function decodeStreamError(value: unknown): ChatErrorEvent {
  if (!object(value) || !nonEmptyText(value.code, 128) || !nonEmptyText(value.message, 4_096)
    || (Object.hasOwn(value, 'messageId') && value.messageId !== undefined && !nonEmptyText(value.messageId, 128))) invalid();
  const messageId = value.messageId;
  if (messageId === undefined) return { code: value.code, message: value.message };
  if (!nonEmptyText(messageId, 128)) invalid();
  return { code: value.code, message: value.message, messageId };
}

function parseEventFrame(frame: string): { readonly event: string; readonly data: unknown } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const raw of frame.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).startsWith(' ') ? line.slice(6) : line.slice(5));
  }
  if (dataLines.length === 0) return null;
  let data: unknown;
  try { data = JSON.parse(dataLines.join('\n')) as unknown; } catch (cause) { throw new ApiClientError('invalid_response', '流式响应数据无法解析。', { cause }); }
  return { event, data };
}

function nextSseFrame(buffer: string): { readonly frame: string; readonly rest: string } | null {
  // EventSource accepts LF, CRLF, and mixed line endings. In particular,
  // searching only for "\n\n" leaves a CRLF stream buffered forever.
  const boundary = /\r?\n\r?\n/u.exec(buffer);
  if (!boundary || boundary.index === undefined) return null;
  return { frame: buffer.slice(0, boundary.index), rest: buffer.slice(boundary.index + boundary[0].length) };
}

async function readSse(response: Response, handlers: ChatStreamHandlers): Promise<ChatStreamResult> {
  if (!response.body) throw new ApiClientError('invalid_response', '服务未返回流式响应。', { status: response.status, code: 'empty_stream' });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done: ChatStreamResult | undefined;
  const consume = async (frame: string) => {
    const parsed = parseEventFrame(frame);
    if (!parsed) return;
    if (parsed.event === 'meta') {
      if (!object(parsed.data) || !Object.hasOwn(parsed.data, 'conversation') || !Object.hasOwn(parsed.data, 'userMessage') || !Object.hasOwn(parsed.data, 'assistantMessage')) invalid();
      const meta: ChatMetaEvent = { conversation: decodeConversation(parsed.data.conversation),
        userMessage: parsed.data.userMessage === null ? null : decodeChatMessage(parsed.data.userMessage), assistantMessage: decodeChatMessage(parsed.data.assistantMessage) };
      await handlers.onMeta?.(meta);
    } else if (parsed.event === 'delta') {
      if (!object(parsed.data) || !text(parsed.data.text, 1_000_000)) invalid();
      await handlers.onDelta?.(parsed.data.text);
    } else if (parsed.event === 'done') {
      if (!object(parsed.data) || !Object.hasOwn(parsed.data, 'message') || (Object.hasOwn(parsed.data, 'billingStatus') && parsed.data.billingStatus !== undefined && !text(parsed.data.billingStatus, 128))) invalid();
      const message = decodeChatMessage(parsed.data.message);
      const billingStatus = parsed.data.billingStatus;
      if (billingStatus !== undefined && typeof billingStatus !== 'string') invalid();
      await handlers.onDone?.(message, billingStatus);
      done = { kind: 'stream', message, ...(billingStatus === undefined ? {} : { billingStatus }) };
    } else if (parsed.event === 'error') {
      const error = decodeStreamError(parsed.data);
      await handlers.onError?.(error);
      throw new ApiClientError('api', error.message, { status: response.status, code: error.code });
    }
  };
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let next = nextSseFrame(buffer);
    while (next) {
      const frame = next.frame;
      buffer = next.rest;
      await consume(frame);
      if (done) { await reader.cancel(); return done; }
      next = nextSseFrame(buffer);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) await consume(buffer);
  if (done) return done;
  if (!done) throw new ApiClientError('invalid_response', '流式响应提前结束。', { status: response.status, code: 'incomplete_stream' });
  return done;
}

async function responseError(response: Response): Promise<never> {
  let code = `http_${response.status}`;
  let message = `请求失败（HTTP ${response.status}）。`;
  try {
    const payload: unknown = await response.clone().json();
    if (object(payload) && object(payload.error) && nonEmptyText(payload.error.code, 128) && nonEmptyText(payload.error.message, 4_096)) {
      code = payload.error.code; message = payload.error.message;
      const requestId = payload.request_id;
      throw new ApiClientError('api', message, { status: response.status, code, ...(text(requestId, 128) ? { request_id: requestId } : {}) });
    }
  } catch (error) {
    if (error instanceof ApiClientError) throw error;
  }
  throw new ApiClientError('http', message, { status: response.status, code });
}

function decodeReplay(value: unknown): ChatReplayResult {
  if (!object(value) || value.replayed !== true) invalid();
  const detail = decodeConversationDetail(value);
  return { kind: 'replay', replayed: true, ...detail };
}

export function createChatApi(options: ChatApiOptions = {}) {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const csrfToken = options.getCsrfToken ?? (async () => readCsrfCookie() ?? (await authApi.bootstrap()).csrfToken);
  const client = createApiClient({ fetch: fetcher, getCsrfToken: csrfToken });
  const conversationPath = (id: string) => `/api/v1/chat/conversations/${validId(id, '会话编号')}`;

  async function sendStream(path: string, body: Record<string, unknown>, handlers: ChatStreamHandlers = {}, signal?: AbortSignal): Promise<ChatSendResult> {
    let token: string | null | undefined;
    try { token = await csrfToken(); } catch (cause) { throw new ApiClientError('request', '无法读取请求验证令牌。', { cause }); }
    if (token === null || token === undefined || token === '') throw new ApiClientError('request', '缺少请求验证令牌，请刷新页面后重试。', { code: 'csrf_missing' });
    const headers = new Headers({ Accept: 'text/event-stream, application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': token });
    let response: Response;
    try {
      response = await fetcher(path, { method: 'POST', headers, credentials: 'same-origin', redirect: 'error', body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) });
    } catch (cause) {
      if (signal?.aborted || (cause instanceof Error && cause.name === 'AbortError')) throw new ApiClientError('aborted', '请求已取消。', { cause });
      throw new ApiClientError('network', '网络请求失败，请检查连接后重试。', { cause });
    }
    if (!response.ok) return responseError(response);
    const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (mediaType === 'text/event-stream') return readSse(response, handlers);
    if (mediaType !== 'application/json' && !/^application\/[a-z0-9.+-]+\+json$/u.test(mediaType)) throw new ApiClientError('invalid_response', '服务返回了无法识别的聊天响应。', { status: response.status, code: 'non_json_response' });
    let payload: unknown;
    try { payload = await response.json(); } catch (cause) { throw new ApiClientError('invalid_response', '服务返回了无法解析的聊天响应。', { status: response.status, cause }); }
    if (!object(payload) || !Object.hasOwn(payload, 'data')) throw new ApiClientError('invalid_response', '服务返回了无效的聊天响应格式。', { status: response.status });
    return decodeReplay(payload.data);
  }

  const api = Object.freeze({
    async models(): Promise<{ readonly items: readonly ChatGroup[] }> {
      return (await client.get('/api/v1/chat/models', { decode: decodeChatModels })).data;
    },
    async listConversations(cursor?: string | null): Promise<ChatList> {
      return (await client.get('/api/v1/chat/conversations', { query: { cursor: cursor ?? null }, decode: decodeConversationPage })).data;
    },
    async getConversation(id: string): Promise<ConversationDetail> {
      return (await client.get(`${conversationPath(id)}`, { decode: decodeConversationDetail })).data;
    },
    async createConversation(input: ConversationCreateInput = {}): Promise<Conversation> {
      return (await client.post('/api/v1/chat/conversations', {
        ...(input.title === undefined ? {} : { title: input.title }), ...(input.groupId === undefined ? {} : { groupId: input.groupId }), ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      }, { decode: decodeConversation })).data;
    },
    async updateConversation(id: string, input: ConversationPatchInput): Promise<Conversation> {
      return (await client.patch(conversationPath(id), {
        version: input.version, ...(input.title === undefined ? {} : { title: input.title }), ...(input.groupId === undefined ? {} : { groupId: input.groupId }), ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      }, { decode: decodeConversation })).data;
    },
    async deleteConversation(id: string, version: number): Promise<{ readonly deleted: true }> {
      return (await client.delete(conversationPath(id), { version }, { decode: decodeDeleted })).data;
    },
    async sendMessage(id: string, input: ChatSendInput, handlers: ChatStreamHandlers = {}, signal?: AbortSignal): Promise<ChatSendResult> {
      if (!positive(input.conversationVersion) || !nonEmptyText(input.operationId, 128) || !nonEmptyText(input.groupId, 128) || !nonEmptyText(input.modelId, 256) || !text(input.content, 1_000_000) || (input.maxOutputTokens !== undefined && !positive(input.maxOutputTokens))) throw new ApiClientError('request', '聊天请求参数无效。');
      return sendStream(`${conversationPath(id)}/messages`, bodyWithOutput({ operationId: input.operationId, conversationVersion: input.conversationVersion, groupId: input.groupId, modelId: input.modelId, content: input.content }, input.maxOutputTokens), handlers, signal);
    },
    async regenerate(id: string, input: ChatRegenerateInput, handlers: ChatStreamHandlers = {}, signal?: AbortSignal): Promise<ChatSendResult> {
      if (!positive(input.conversationVersion) || !nonEmptyText(input.operationId, 128) || !nonEmptyText(input.groupId, 128) || !nonEmptyText(input.modelId, 256) || (input.maxOutputTokens !== undefined && !positive(input.maxOutputTokens))) throw new ApiClientError('request', '重新生成参数无效。');
      return sendStream(`${conversationPath(id)}/regenerate`, bodyWithOutput({ operationId: input.operationId, conversationVersion: input.conversationVersion, groupId: input.groupId, modelId: input.modelId }, input.maxOutputTokens), handlers, signal);
    },
    async selectVersion(id: string, input: ChatSelectInput): Promise<ConversationDetail> {
      return (await client.post(`${conversationPath(id)}/select`, { conversationVersion: input.conversationVersion, messageId: input.messageId }, { decode: decodeConversationDetail })).data;
    },
  });
  return api;
}

export type ChatApi = ReturnType<typeof createChatApi>;
export const chatApi = createChatApi();
