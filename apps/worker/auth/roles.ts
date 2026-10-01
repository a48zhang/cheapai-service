import type { MiddlewareHandler } from 'hono';
import { ApiError, apiError, createRequestId } from '../http';
import type { AuthEnv } from './middleware';
import type { PublicUser } from './users';

export type AdminUser = PublicUser & { role: 'admin' };

/** Type narrowing only: callers must obtain the user from authenticated context. */
export function isAdmin(user: PublicUser): user is AdminUser {
  return user.role === 'admin';
}

/** Mount after requireSession. No URL, header, body or cookie role claims are used. */
export const requireAdmin: MiddlewareHandler<AuthEnv> = async (context, next) => {
  const requestId = context.get('requestId') ?? createRequestId();
  context.set('requestId', requestId);
  const user = context.get('user');
  const session = context.get('session');
  // Fail closed if accidentally mounted without the authentication middleware.
  if (!user || !session || session.user_id !== user.id || user.status !== 'active' || user.group_status !== 'active') {
    return apiError(new ApiError('unauthorized'), requestId);
  }
  if (!isAdmin(user)) return apiError(new ApiError('forbidden'), requestId);
  await next();
};
