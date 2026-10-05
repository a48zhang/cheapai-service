import { logError } from '../logging';
import { API_ERRORS, ApiError } from '../http';
import { authenticateWebChat } from '../auth/web-chat-auth';
import { authorizeChatSelection, listAuthorizedChatModels } from './models';
import type { AuthorizedChatSelection, ChatGroup } from './models';
import { boundedChatWork, createChatSseStream, sseResponse } from './stream';
import type { ChatGatewayExecution, ChatSseMeta } from './stream';
import type { ChatConversation, ChatConversationPage, ChatConversationView, ChatContextMessage, ChatStorage } from './storage';
import { createD1ChatStorage } from './d1-storage';
import { dispatchTrustedGatewayRequest } from '../gateway/dispatch';
import type { GatewayDispatchDependencies } from '../gateway/dispatch';
import type { ProtocolRequest } from '@sub2api/apicompat/capabilities/check';
import type { ChatRequest } from '@sub2api/apicompat/types/chat';

export type { ChatRole, ChatMessageStatus, ChatConversation, ChatMessage, ChatConversationPage, ChatConversationView, ChatContextMessage,
  ChatStorageStartInput, ChatStorageAccepted, ChatStorageReplay, ChatStorageStartResult, ChatStorage } from './storage';
export { createD1ChatStorage } from './d1-storage';

export interface ChatStartInput {
  readonly operationId: string;
  readonly conversationVersion: number;
  readonly groupId: string;
  readonly modelId: string;
  readonly content?: string;
  readonly maxOutputTokens?: number;
  /** Request lifecycle fields are supplied by the route, never JSON. */
  readonly signal?: AbortSignal;
  readonly executionContext?: Pick<ExecutionContext, 'waitUntil'>;
}

export interface ChatGatewayRequest {
  readonly userId: string;
  readonly groupId: string;
  readonly modelId: string;
  readonly messages: readonly ChatContextMessage[];
  readonly maxOutputTokens?: number;
  readonly operationId: string;
  readonly auth: unknown;
  readonly signal?: AbortSignal;
  readonly executionContext?: Pick<ExecutionContext, 'waitUntil'>;
  /** Called after request registration but before any upstream bytes are sent. */
  readonly onRegistered: (requestId: string) => Promise<void>;
}

export interface ChatGateway {
  execute(request: ChatGatewayRequest): Promise<ChatGatewayExecution>;
}

export interface ChatServiceOptions {
  readonly database: D1Database;
  readonly storage?: ChatStorage;
  readonly gateway?: ChatGateway;
  readonly gatewayDependencies?: ChatGatewayDependencies;
  readonly now?: () => number;
  /** keys owns virtual-key creation/authentication; no raw key is accepted. */
  readonly authenticate?: (database: D1Database, userId: string, groupId: string, now: number) => Promise<unknown>;
}

export interface ChatGatewayDependencies extends Omit<GatewayDispatchDependencies, 'DB' | 'keyring'> {
  readonly DB: D1Database;
  readonly keyring: GatewayDispatchDependencies['keyring'];
}

export type ChatStartResult =
  | { readonly kind: 'replayed'; readonly view: ChatConversationView }
  | { readonly kind: 'stream'; readonly response: Response; readonly assistantMessageId: string };

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u;
const operationIdentifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
function invalid(): never { throw new ApiError('invalid_request'); }
function id(value: unknown): string { if (typeof value !== 'string' || !identifier.test(value)) invalid(); return value; }
function operation(value: unknown): string { if (typeof value !== 'string' || !operationIdentifier.test(value)) invalid(); return value; }
function version(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid(); return value; }
function text(value: unknown, max = 1_000_000): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) invalid();
  return value;
}
function maxOutput(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid();
  return value;
}
function nowOf(clock: () => number): number {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) throw new ApiError('service_unavailable');
  return value;
}

function replayView(storage: ChatStorage, userId: string, conversationId: string): Promise<ChatConversationView> {
  return storage.getConversation(userId, conversationId).then(view => {
    if (view === null) throw new ApiError('not_found');
    return view;
  });
}

function detachedExecutionContext(): Pick<ExecutionContext, 'waitUntil'> {
  return { waitUntil(_work: Promise<unknown>) { /* local unit calls have no event lifetime */ } };
}

function gatewayErrorCode(status: number, bodyCode: unknown): keyof typeof API_ERRORS {
  if (typeof bodyCode === 'string' && Object.hasOwn(API_ERRORS, bodyCode)) return bodyCode as keyof typeof API_ERRORS;
  if (status === 400) return 'invalid_request';
  if (status === 401) return 'unauthorized';
  if (status === 402) return 'insufficient_balance';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  return 'service_unavailable';
}

/** Trusted dispatch still returns its native protocol envelope for admission
 * failures. Before registration those failures must remain management errors
 * (especially 402/403); the body is inspected only for its allowlisted code,
 * never copied to a browser error. */
async function throwUnregisteredGatewayError(response: Response): Promise<never> {
  let code: unknown;
  try { code = (await boundedChatWork(response.json()) as { error?: { code?: unknown } }).error?.code; } catch { /* status mapping below */ }
  throw new ApiError(gatewayErrorCode(response.status, code));
}

/** Trusted server dispatch adapter.  It creates a Chat request with no
 * credential headers and passes the session-derived InternalPlatformKeyAuth
 * directly to the gateway's trusted entry point. */
export function createTrustedChatGateway(dependencies: ChatGatewayDependencies): ChatGateway {
  return {
    async execute(request) {
      const local = new AbortController();
      const abort = () => local.abort();
      const cleanup = () => request.signal?.removeEventListener('abort', abort);
      request.signal?.addEventListener('abort', abort, { once: true });
      if (request.signal?.aborted) abort();
      const signal = local.signal;
      const completionTasks: Promise<unknown>[] = [];
      const executionContext = request.executionContext;
      const waitUntil = (work: Promise<unknown>) => {
        completionTasks.push(work);
        if (executionContext) executionContext.waitUntil(work);
      };
      const body: ChatRequest = {
        model: request.modelId,
        messages: request.messages.map(message => ({ role: message.role, content: message.content })),
        stream: true,
      };
      const wireBody: ChatRequest = request.maxOutputTokens === undefined ? body : { ...body, max_tokens: request.maxOutputTokens };
      let registered = false;
      let response: Response | undefined;
      try {
        response = await dispatchTrustedGatewayRequest({ ...dependencies }, {
          subject: request.auth as Parameters<typeof dispatchTrustedGatewayRequest>[1]['subject'],
          request: { protocol: 'chat', request: wireBody } as ProtocolRequest,
          onRegistered: async requestId => { await request.onRegistered(requestId); registered = true; },
          signal,
        }, { waitUntil });
        if (!registered && !response.ok) await throwUnregisteredGatewayError(response);
        const requestId = response.headers.get('X-Request-Id') ?? response.headers.get('X-Request-ID');
        if (requestId === null || !identifier.test(requestId)) throw new ApiError('service_unavailable');
        return {
          requestId,
          source: response,
          cancel: () => { local.abort(); cleanup(); },
          resolveTerminal: async () => {
            // The dispatcher registers execution.completion with this exact
            // request context. Awaiting those tasks before reading D1 avoids
            // turning a valid [DONE] frame into a premature “incomplete” state.
            try {
              await Promise.allSettled(completionTasks);
              const row = await dependencies.DB.prepare('SELECT execution_status,billing_status FROM requests WHERE id=?').bind(requestId).first<{ execution_status: string; billing_status: string }>();
              if (row?.execution_status === 'succeeded') return { terminal: 'completed' as const, billingStatus: row.billing_status };
              if (row?.execution_status === 'cancelled') return { terminal: 'stopped' as const, billingStatus: row.billing_status };
              if (row?.execution_status === 'failed' || row?.execution_status === 'abandoned') return { terminal: 'failed' as const, billingStatus: row.billing_status };
              return { terminal: 'failed' as const, billingStatus: 'unknown' };
            } finally { cleanup(); }
          },
        };
      } catch (error) {
        local.abort();
        cleanup();
        try { void response?.body?.cancel().catch(() => undefined); } catch { /* already locked */ }
        throw error;
      }
    },
  };
}

export class ChatService {
  readonly database: D1Database;
  readonly storage: ChatStorage;
  readonly gateway: ChatGateway;
  readonly clock: () => number;
  readonly authenticateKey: NonNullable<ChatServiceOptions['authenticate']>;

  constructor(options: ChatServiceOptions) {
    this.database = options.database;
    this.storage = options.storage ?? createD1ChatStorage(options.database);
    this.gateway = options.gateway ?? (options.gatewayDependencies === undefined
      ? { execute: async () => { throw new ApiError('service_unavailable'); } }
      : createTrustedChatGateway(options.gatewayDependencies));
    this.clock = options.now ?? Date.now;
    this.authenticateKey = options.authenticate ?? (authenticateWebChat as NonNullable<ChatServiceOptions['authenticate']>);
  }

  async models(userId: string): Promise<{ items: ChatGroup[] }> {
    return listAuthorizedChatModels(this.database, id(userId), nowOf(this.clock));
  }

  async conversations(userId: string, cursor: string | null, limit: number): Promise<ChatConversationPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid();
    if (cursor !== null && (typeof cursor !== 'string' || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/u.test(cursor))) invalid();
    return this.storage.listConversations(id(userId), cursor, limit);
  }

  async conversation(userId: string, conversationId: string): Promise<ChatConversationView> {
    const view = await this.storage.getConversation(id(userId), id(conversationId));
    if (view === null) throw new ApiError('not_found');
    return view;
  }

  async createConversation(userId: string, input: { title?: string; groupId?: string | null; modelId?: string | null }): Promise<ChatConversation> {
    const owner = id(userId);
    if (input.title !== undefined) text(input.title, 256);
    if (input.groupId !== undefined && input.groupId !== null) id(input.groupId);
    if (input.modelId !== undefined && input.modelId !== null) id(input.modelId);
    if ((input.groupId === null) !== (input.modelId === null) && (input.groupId === null || input.modelId === null)) invalid();
    if (input.groupId !== undefined && input.groupId !== null && input.modelId !== undefined && input.modelId !== null) {
      await authorizeChatSelection(this.database, owner, input.groupId, input.modelId, undefined, nowOf(this.clock));
    }
    return this.storage.createConversation(owner, { ...input, now: nowOf(this.clock) });
  }

  async updateConversation(userId: string, conversationId: string, expectedVersion: number,
    patch: { title?: string; groupId?: string | null; modelId?: string | null }): Promise<ChatConversation> {
    const owner = id(userId); const conversation = id(conversationId); const expected = version(expectedVersion);
    if (patch.title !== undefined) text(patch.title, 256);
    if (patch.groupId !== undefined && patch.groupId !== null) id(patch.groupId);
    if (patch.modelId !== undefined && patch.modelId !== null) id(patch.modelId);
    if (Object.hasOwn(patch, 'groupId') !== Object.hasOwn(patch, 'modelId')) invalid();
    if (Object.hasOwn(patch, 'groupId') && ((patch.groupId === null) !== (patch.modelId === null))) invalid();
    if (patch.groupId !== undefined && patch.groupId !== null && patch.modelId !== undefined && patch.modelId !== null) {
      await authorizeChatSelection(this.database, owner, patch.groupId, patch.modelId, undefined, nowOf(this.clock));
    }
    return this.storage.updateConversation(owner, conversation, expected, patch, nowOf(this.clock));
  }

  async deleteConversation(userId: string, conversationId: string, expectedVersion: number): Promise<{ deleted: true }> {
    const deleted = await this.storage.deleteConversation(id(userId), id(conversationId), version(expectedVersion), nowOf(this.clock));
    if (!deleted) throw new ApiError('conflict');
    return { deleted: true };
  }

  async selectVersion(userId: string, conversationId: string, messageId: string, expectedConversationVersion: number): Promise<ChatConversationView> {
    return this.storage.selectVersion(id(userId), id(conversationId), id(messageId), version(expectedConversationVersion), nowOf(this.clock));
  }

  private async start(owner: string, conversationId: string, input: ChatStartInput, regeneration: boolean): Promise<ChatStartResult> {
    const userId = id(owner); const idOfConversation = id(conversationId);
    operation(input.operationId); version(input.conversationVersion); const groupId = id(input.groupId); const modelId = id(input.modelId);
    if (!regeneration) {
      if (input.content === undefined) invalid();
      text(input.content);
    } else if (input.content !== undefined) invalid();
    const maxTokens = input.maxOutputTokens === undefined ? undefined : maxOutput(input.maxOutputTokens);
    const current = await this.storage.getConversation(userId, idOfConversation);
    if (current === null) throw new ApiError('not_found');
    // The conversation's remembered selector is authoritative for a send.
    // Switching group/model is an explicit conversation PATCH; accepting a
    // body-only switch would let a stale tab route this conversation through a
    // different multiplier or channel set.
    if ((current.conversation.groupId !== null && current.conversation.groupId !== groupId)
      || (current.conversation.modelId !== null && current.conversation.modelId !== modelId)) throw new ApiError('forbidden');
    const selection: AuthorizedChatSelection = await authorizeChatSelection(this.database, userId, groupId, modelId, maxTokens, nowOf(this.clock));
    // Internal virtual-key authentication is scoped to this request's selected
    // group. The browser never supplies a key ID or credential.
    const auth = await this.authenticateKey(this.database, userId, selection.group.id, nowOf(this.clock));
    const started = await this.storage.startMessage(userId, idOfConversation, {
      operationId: input.operationId, conversationVersion: input.conversationVersion, groupId: selection.group.id,
      modelId: selection.model.publicModelId, ...(input.content === undefined ? {} : { content: input.content }), now: nowOf(this.clock), regenerate: regeneration,
    });
    if (started.kind === 'replayed') return { kind: 'replayed', view: await replayView(this.storage, userId, idOfConversation) };
    let answer = '';
    let execution: ChatGatewayExecution | undefined;
    let registered = false;
    let registeredRequestId: string | null = null;
    const onRegistered = async (requestId: string) => {
      if (registered) {
        if (requestId !== registeredRequestId) throw new ApiError('conflict');
        return;
      }
      if (typeof requestId !== 'string' || !identifier.test(requestId)) throw new ApiError('service_unavailable');
      const saved = await boundedChatWork(this.storage.associateRequest(userId, idOfConversation,
        started.assistantMessage.id, input.operationId, requestId, nowOf(this.clock)), 5000, input.signal);
      if (!saved) throw new ApiError('service_unavailable');
      registered = true;
      registeredRequestId = requestId;
    };
    try {
      execution = await this.gateway.execute({ userId, groupId: selection.group.id, modelId: selection.model.publicModelId,
        messages: started.context, operationId: input.operationId, auth, ...(maxTokens === undefined ? {} : { maxOutputTokens: maxTokens }),
        ...(input.signal === undefined ? {} : { signal: input.signal }), ...(input.executionContext === undefined ? {} : { executionContext: input.executionContext }), onRegistered });
      if (!registered) throw new ApiError('service_unavailable');
      const meta: ChatSseMeta = { conversation: started.conversation, userMessage: started.userMessage, assistantMessage: started.assistantMessage };
      const body = createChatSseStream(meta, execution, {
        onDelta: async delta => {
          answer += delta;
          await this.storage.saveAssistantProgress(userId, idOfConversation, started.assistantMessage.id, answer, nowOf(this.clock));
        },
        onDone: billingStatus => this.storage.finishAssistant(userId, idOfConversation, started.assistantMessage.id, 'completed', answer, nowOf(this.clock)),
        onFailed: (_code, _message) => this.storage.finishAssistant(userId, idOfConversation, started.assistantMessage.id, 'failed', answer, nowOf(this.clock)),
        onCancelled: () => this.storage.finishAssistant(userId, idOfConversation, started.assistantMessage.id, 'stopped', answer, nowOf(this.clock)),
      }, { ...(input.signal === undefined ? {} : { signal: input.signal }), ...(input.executionContext === undefined ? {} : {
        waitUntil: (work: Promise<unknown>) => input.executionContext!.waitUntil(work),
      }) });
      return { kind: 'stream', response: sseResponse(body, execution.requestId), assistantMessageId: started.assistantMessage.id };
    } catch (error) {
      // If execution escaped before a response could be installed, stop it
      // first. Gateway cleanup still owns all leases and settlement.
      try { await boundedChatWork(Promise.resolve().then(() => execution?.cancel?.()), 1000); } catch (error) { logError('Chat cancellation failed', error, { conversation_id: idOfConversation }); }
      try {
        await boundedChatWork(Promise.resolve().then(() => this.storage.finishAssistant(userId, idOfConversation,
          started.assistantMessage.id, input.signal?.aborted ? 'stopped' : 'failed', answer, nowOf(this.clock))));
      } catch (error) { logError('Chat failure persistence failed', error, { conversation_id: idOfConversation, message_id: started.assistantMessage.id }); }
      throw error instanceof ApiError ? error : new ApiError('service_unavailable', { cause: error });
    }
  }

  send(userId: string, conversationId: string, input: ChatStartInput): Promise<ChatStartResult> {
    return this.start(userId, conversationId, input, false);
  }

  regenerate(userId: string, conversationId: string, input: Omit<ChatStartInput, 'content'>): Promise<ChatStartResult> {
    return this.start(userId, conversationId, input, true);
  }
}

export function createChatService(options: ChatServiceOptions): ChatService { return new ChatService(options); }
