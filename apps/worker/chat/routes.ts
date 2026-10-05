import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env';
import { ApiError, apiError, apiSuccess, createRequestId, parsePagination } from '../http';
import { requireSession } from '../auth/middleware';
import type { AuthVariables } from '../auth/middleware';
import { validateCsrfRequest } from '../auth/csrf';
import { listAuthorizedChatModels } from './models';
import { ChatService, createChatService } from './service';
import type { ChatGateway, ChatGatewayDependencies, ChatServiceOptions, ChatStorage, ChatStartInput } from './service';
import { readGatewayJson } from '../gateway/read-json';

export const CHAT_API_PATH = '/api/v1/chat';
export const CHAT_MODELS_PATH = `${CHAT_API_PATH}/models`;
export const CHAT_CONVERSATIONS_PATH = `${CHAT_API_PATH}/conversations`;

export interface ChatRouteOptions {
  readonly basePath?: string;
  readonly database?: D1Database;
  readonly service?: ChatService;
  readonly storage?: ChatStorage | ((database: D1Database, env: Env) => ChatStorage);
  readonly gateway?: ChatGateway | ((env: Env) => ChatGateway);
  readonly gatewayDependencies?: Omit<ChatGatewayDependencies, 'DB'>;
  readonly now?: () => number;
  readonly trustedOrigin?: string | ((env: Env) => string);
  readonly authenticate?: ChatServiceOptions['authenticate'];
}

type ChatEnv = { Bindings: Env; Variables: AuthVariables };

function base(value: string | undefined): string {
  const path = value ?? CHAT_API_PATH;
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 256 || /[?#\s]/u.test(path)) throw new TypeError('Invalid chat route base.');
  return path === '/' ? '' : path.replace(/\/+$/u, '');
}

function noStore(response: Response): Response {
  const headers = new Headers(response.headers); headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function requestId(context: { get(name: string): unknown }): string {
  const value = context.get('requestId'); return typeof value === 'string' ? value : createRequestId();
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('invalid_request');
  return value as Record<string, unknown>;
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  // The shared bounded reader intentionally only accepts generation POSTs.
  // Management PATCH/DELETE bodies use the same reader/byte ceiling through a
  // method-normalized one-shot Request; no unbounded request.json path exists.
  const bounded = request.method === 'POST' ? request : new Request(request.url, { method: 'POST', headers: request.headers, body: request.body, signal: request.signal });
  return object(await readGatewayJson(bounded));
}

function required<T>(body: Record<string, unknown>, key: string): T {
  if (!Object.hasOwn(body, key) || body[key] === undefined) throw new ApiError('invalid_request');
  return body[key] as T;
}

function serviceFor(options: ChatRouteOptions, env: Env): ChatService {
  if (options.service) return options.service;
  const database = options.database ?? env.DB;
  if (!database) throw new ApiError('service_unavailable');
  const storage = options.storage === undefined ? undefined : typeof options.storage === 'function' ? options.storage(database, env) : options.storage;
  const gateway = options.gateway === undefined ? undefined : typeof options.gateway === 'function' ? options.gateway(env) : options.gateway;
  const deps = options.gatewayDependencies === undefined ? {
    DB: database, CACHE: env.CACHE, GATE: env.GATE,
  } : {
    ...options.gatewayDependencies, DB: database,
  };
  const serviceOptions: ChatServiceOptions = { database, ...(storage === undefined ? {} : { storage }), ...(gateway === undefined ? {} : { gateway }),
    gatewayDependencies: deps, ...(options.now === undefined ? {} : { now: options.now }), ...(options.authenticate === undefined ? {} : { authenticate: options.authenticate }) };
  return createChatService(serviceOptions);
}

function originFor(options: ChatRouteOptions, env: Env): string {
  const value = typeof options.trustedOrigin === 'function' ? options.trustedOrigin(env) : options.trustedOrigin ?? env.PUBLIC_BASE_URL;
  if (typeof value !== 'string') throw new ApiError('service_unavailable');
  return value;
}

function csrf(options: ChatRouteOptions): MiddlewareHandler<ChatEnv> {
  return async (context, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(context.req.method.toUpperCase())) { await next(); return; }
    try { validateCsrfRequest(context.req.raw, originFor(options, context.env)); }
    catch (error) { return noStore(apiError(error instanceof ApiError ? error : new ApiError('service_unavailable', { cause: error }), requestId(context))); }
    await next();
  };
}

function queryCursor(request: Request): { cursor: string | null; limit: number } {
  const query = new URL(request.url).searchParams;
  return parsePagination(query);
}

function input(body: Record<string, unknown>, regeneration: boolean): ChatStartInput {
  const result: ChatStartInput = {
    operationId: required<string>(body, 'operationId'), conversationVersion: required<number>(body, 'conversationVersion'),
    groupId: required<string>(body, 'groupId'), modelId: required<string>(body, 'modelId'),
    ...(regeneration ? {} : { content: required<string>(body, 'content') }),
    ...(body.maxOutputTokens === undefined ? {} : { maxOutputTokens: body.maxOutputTokens as number }),
  };
  return result;
}

/**
 * Browser chat routes.  The factory is intentionally independent of the
 * global `routes.ts`: root can mount it with `forwardMounted`, passing a
 * request-local gateway while GET catalogue/history calls only touch
 * session, D1 and chat storage.
 */
export function createChatRoutes(options: ChatRouteOptions = {}): Hono<ChatEnv> {
  const root = base(options.basePath);
  const app = new Hono<ChatEnv>();
  const session = requireSession(options.now ?? Date.now);
  app.use(`${root}/*`, session);
  app.use(`${root}/*`, csrf(options));
  app.onError((error, context) => noStore(apiError(error instanceof ApiError ? error : new ApiError('internal_error', { cause: error }), requestId(context))));
  app.notFound(context => noStore(apiError(new ApiError('not_found'), requestId(context))));

  app.get(`${root}/models`, async context => {
    const user = context.get('user');
    const data = await listAuthorizedChatModels(context.env.DB, user.id, (options.now ?? Date.now)());
    return noStore(apiSuccess(data, requestId(context)));
  });

  app.get(`${root}/conversations`, async context => {
    const user = context.get('user'); const page = queryCursor(context.req.raw);
    const data = await serviceFor(options, context.env).conversations(user.id, page.cursor, page.limit);
    return noStore(apiSuccess(data, requestId(context)));
  });

  app.post(`${root}/conversations`, async context => {
    const user = context.get('user'); const body = await jsonBody(context.req.raw);

    const data = await serviceFor(options, context.env).createConversation(user.id, {
      ...(body.title === undefined ? {} : { title: body.title as string }),
      ...(body.groupId === undefined ? {} : { groupId: body.groupId as string | null }),
      ...(body.modelId === undefined ? {} : { modelId: body.modelId as string | null }),
    });
    return noStore(apiSuccess(data, requestId(context), 201));
  });

  app.get(`${root}/conversations/:id`, async context => {
    const user = context.get('user'); const data = await serviceFor(options, context.env).conversation(user.id, context.req.param('id'));
    return noStore(apiSuccess(data, requestId(context)));
  });

  app.patch(`${root}/conversations/:id`, async context => {
    const user = context.get('user'); const body = await jsonBody(context.req.raw);
    const patch = {
      ...(body.title === undefined ? {} : { title: body.title as string }),
      ...(body.groupId === undefined ? {} : { groupId: body.groupId as string | null }),
      ...(body.modelId === undefined ? {} : { modelId: body.modelId as string | null }),
    };
    const data = await serviceFor(options, context.env).updateConversation(user.id, context.req.param('id'), required<number>(body, 'version'), patch);
    return noStore(apiSuccess(data, requestId(context)));
  });

  app.delete(`${root}/conversations/:id`, async context => {
    const user = context.get('user'); const body = await jsonBody(context.req.raw);
    const data = await serviceFor(options, context.env).deleteConversation(user.id, context.req.param('id'), required<number>(body, 'version'));
    return noStore(apiSuccess(data, requestId(context)));
  });

  app.post(`${root}/conversations/:id/messages`, async context => {
    const user = context.get('user'); const body = await jsonBody(context.req.raw);
    const parsed = input(body, false);
    const result = await serviceFor(options, context.env).send(user.id, context.req.param('id'), {
      ...parsed, signal: context.req.raw.signal, executionContext: context.executionCtx,
    });
    if (result.kind === 'replayed') return noStore(apiSuccess({ ...result.view, replayed: true }, requestId(context)));
    return result.response;
  });

  app.post(`${root}/conversations/:id/regenerate`, async context => {
    const user = context.get('user'); const body = await jsonBody(context.req.raw);
    const parsed = input(body, true);
    const result = await serviceFor(options, context.env).regenerate(user.id, context.req.param('id'), {
      ...parsed, signal: context.req.raw.signal, executionContext: context.executionCtx,
    });
    if (result.kind === 'replayed') return noStore(apiSuccess({ ...result.view, replayed: true }, requestId(context)));
    return result.response;
  });

  app.post(`${root}/conversations/:id/select`, async context => {
    const user = context.get('user'); const body = await jsonBody(context.req.raw);
    const data = await serviceFor(options, context.env).selectVersion(user.id, context.req.param('id'), required<string>(body, 'messageId'), required<number>(body, 'conversationVersion'));
    return noStore(apiSuccess(data, requestId(context)));
  });
  return app;
}

/** Name used by the root route assembly task. */
export const createWebChatRoutes = createChatRoutes;
