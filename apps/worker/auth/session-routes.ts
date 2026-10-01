import { Hono } from 'hono';
import type { Context } from 'hono';
import { ApiError, apiError, apiSuccess, createRequestId } from '../http';
import { requireSession } from './middleware';
import type { AuthEnv } from './middleware';
import { validateCsrfRequest } from './csrf';
import { revokeCookieSession } from './sessions';

export interface SessionRoutesOptions {
  now?: () => number;
  /** Resolve from trusted server configuration, never incoming Origin/Host. */
  trustedOrigin?: (context: Context<AuthEnv>) => string | Promise<string>;
}

/** Full management paths; mount at '/'. No bindings are read at module load. */
export function createSessionRoutes(options: SessionRoutesOptions = {}): Hono<AuthEnv> {
  const routes = new Hono<AuthEnv>();
  routes.use('/api/v1/auth/*', async (context, next) => {
    await next();
    context.header('Cache-Control', 'no-store');
  });
  routes.get('/api/v1/auth/me', requireSession(options.now ?? Date.now), context =>
    apiSuccess(context.get('user'), context.get('requestId')),
  );
  routes.post('/api/v1/auth/logout', async context => {
    const requestId = context.get('requestId') ?? createRequestId();
    context.set('requestId', requestId);
    try {
      // A missing trusted configuration fails closed. Never derive trust from
      // the request Origin, Host or forwarded headers. GET /me does not use it.
      if (!options.trustedOrigin) throw new ApiError('service_unavailable');
      validateCsrfRequest(context.req.raw, await options.trustedOrigin(context));
      // Deliberately no requireSession: absent/malformed credentials may clear
      // their cookie, and A03 can revoke expired or disabled-user sessions too.
      const clearCookie = await revokeCookieSession(context.env.DB, context.req.header('Cookie') ?? null, (options.now ?? Date.now)());
      const response = apiSuccess({ loggedOut: true }, requestId);
      response.headers.append('Set-Cookie', clearCookie);
      return response;
    } catch (error) {
      return apiError(error instanceof ApiError ? error : new ApiError('service_unavailable'), requestId);
    }
  });
  return routes;
}
