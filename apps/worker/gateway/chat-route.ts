import { logError } from '../logging';
import { Hono } from 'hono';
import { encodeChatError } from '@sub2api/apicompat/errors';
import type { Env } from '../env';
import { readChannelKeyring } from '../channel-keyring';
import { dispatchGatewayRequest } from './dispatch';
import type { GatewayDispatchDependencies } from './dispatch';

export const CHAT_COMPLETIONS_PATH = '/v1/chat/completions';
export type ChatRouteOptions = Pick<GatewayDispatchDependencies, 'fetch' | 'registry' | 'now' | 'messagesPolicy' | 'transport'>;
/** Fixed protocol/path. Dispatcher owns authentication, accounting and completion. */
export function createChatRoute(options: ChatRouteOptions = {}): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, context) => { logError('Gateway route failed', error, { path: context.req.path }); return Response.json(encodeChatError({ kind: 'upstream_error', code: 'unavailable', message: 'Unavailable' }), { status: 503, headers: { 'Cache-Control': 'no-store' } }); });
  app.notFound(() => Response.json(encodeChatError({ kind: 'invalid_request', code: 'not_found', message: 'Not found' }), { status: 404, headers: { 'Cache-Control': 'no-store' } }));
  app.post(CHAT_COMPLETIONS_PATH, context => dispatchGatewayRequest({ DB: context.env.DB, CACHE: context.env.CACHE, GATE: context.env.GATE,
    keyring: () => readChannelKeyring(context.env).keyring, ...options }, context.req.raw, 'chat', context.executionCtx));
  return app;
}
