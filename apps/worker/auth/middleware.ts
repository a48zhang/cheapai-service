import type { Context, MiddlewareHandler } from 'hono';
import { ApiError, apiError, createRequestId } from '../http';
import { readCookieSession } from './sessions';
import type { StoredSession } from './session-repository';
import { findPublicUserById } from './users';
import type { PublicUser } from './users';
import { isDesktopConsoleRequest } from '@cheapai/contracts/desktop-console';
import { authenticateDesktopSession } from './desktop/authenticate';
import { TOKEN_PREFIXES } from './tokens';

export interface AuthVariables {
  requestId: string;
  user: PublicUser;
  session: Pick<StoredSession, 'id' | 'user_id' | 'expires_at'>;
  authentication: 'cookie' | 'desktop';
}

export interface AuthEnv {
  Bindings: { DB: D1Database };
  Variables: AuthVariables;
}

/** Valid only after requireSession has successfully run; no credentials in context. */
export type AuthenticatedContext = Context<AuthEnv>;

/** Management API session authentication only. No role authorization or CSRF policy.
 * Reads authoritative D1 state on every request; never uses cached identity claims.
 */
export function requireSession(now: () => number = Date.now): MiddlewareHandler<AuthEnv> {
  return async (context, next) => {
    // Reuse an ID established by trusted request middleware, not a client header.
    const requestId = context.get('requestId') ?? createRequestId();
    context.set('requestId', requestId);
    try {
      // Unrelated headers remain untrusted browser claims; only an explicit desktop
      // bearer selects native authentication, and it never falls back to a Cookie.
      const authorization = context.req.header('Authorization');
      if (authorization?.toLowerCase().startsWith(`bearer ${TOKEN_PREFIXES.desktopSession}`)) {
        const url = new URL(context.req.url);
        if (!isDesktopConsoleRequest(context.req.method, url.pathname + url.search))
          return apiError(new ApiError('unauthorized'), requestId);
        const { session, user } = await authenticateDesktopSession(
          context.env.DB,
          context.req.raw,
          now(),
        );
        context.set('session', session);
        context.set('user', user);
        context.set('authentication', 'desktop');
      } else {
        const session = await readCookieSession(
          context.env.DB,
          context.req.header('Cookie') ?? null,
          now(),
        );
        if (session === null) return apiError(new ApiError('unauthorized'), requestId);
        const user = await findPublicUserById(context.env.DB, session.user_id, {
          userId: session.user_id,
        });
        if (user === null || user.status !== 'active' || user.group_status !== 'active') {
          return apiError(new ApiError('unauthorized'), requestId);
        }
        context.set('session', session);
        context.set('user', user);
        context.set('authentication', 'cookie');
      }
    } catch (error) {
      // Backend/crypto failures must not be presented as bad credentials.
      return apiError(
        error instanceof ApiError ? error : new ApiError('service_unavailable', { cause: error }),
        requestId,
      );
    }
    // Downstream business errors belong to the route/error handler, not auth.
    await next();
  };
}
