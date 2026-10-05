import { logError } from '../logging';
import { Hono } from 'hono';
import { encodeMessagesError } from '@sub2api/apicompat/errors';
import type { Env } from '../env';
import { dispatchGatewayRequest } from './dispatch';
import type { GatewayDispatchDependencies } from './dispatch';

export const MESSAGES_PATH = '/v1/messages';
export type MessagesRouteOptions = Pick<GatewayDispatchDependencies, 'fetch' | 'registry' | 'now' | 'messagesPolicy' | 'transport'>;
/** Platform authentication/version parsing and trusted beta policy stay in G14/G01. */
export function createMessagesRoute(options: MessagesRouteOptions = {}): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, context) => { logError('Gateway route failed', error, { path: context.req.path }); return Response.json(encodeMessagesError({ kind: 'upstream_error', code: 'unavailable', message: 'Unavailable' }), { status: 503, headers: { 'Cache-Control': 'no-store' } }); });
  app.notFound(() => Response.json(encodeMessagesError({ kind: 'invalid_request', code: 'not_found', message: 'Not found' }), { status: 404, headers: { 'Cache-Control': 'no-store' } }));
  app.post(MESSAGES_PATH, context => dispatchGatewayRequest({ DB: context.env.DB, CACHE: context.env.CACHE, GATE: context.env.GATE,
    ...options }, context.req.raw, 'messages', context.executionCtx));
  return app;
}
