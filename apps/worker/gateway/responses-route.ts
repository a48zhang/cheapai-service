import { Hono } from 'hono';
import { encodeResponsesError } from '@sub2api/apicompat/errors';
import type { Env } from '../env';
import { readChannelKeyring } from '../channel-keyring';
import { dispatchGatewayRequest } from './dispatch';
import type { GatewayDispatchDependencies } from './dispatch';

export const RESPONSES_PATH = '/v1/responses';
export type ResponsesRouteOptions = Pick<GatewayDispatchDependencies, 'fetch' | 'registry' | 'now' | 'messagesPolicy' | 'transport'>;
/** No GET/DELETE history API. G13 ownership and execution stay in the dispatcher. */
export function createResponsesRoute(options: ResponsesRouteOptions = {}): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(() => Response.json(encodeResponsesError({ kind: 'upstream_error', code: 'unavailable', message: 'Unavailable' }), { status: 503, headers: { 'Cache-Control': 'no-store' } }));
  app.notFound(() => Response.json(encodeResponsesError({ kind: 'invalid_request', code: 'not_found', message: 'Not found' }), { status: 404, headers: { 'Cache-Control': 'no-store' } }));
  app.post(RESPONSES_PATH, context => dispatchGatewayRequest({ DB: context.env.DB, CACHE: context.env.CACHE, GATE: context.env.GATE,
    keyring: () => readChannelKeyring(context.env).keyring, ...options }, context.req.raw, 'responses', context.executionCtx));
  return app;
}
