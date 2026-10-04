import { ApiError } from '../http';
import type { RuntimeConfig } from '../config';
import { loginWithCredential } from './login-core';
import type { LoginCoreDependencies } from './login-core';
import { createCookieSession } from './sessions';
import { revokeSession, SessionCreationError } from './session-repository';
import type { CookieSession } from './sessions';
import type { PublicUser } from './users';

export { LoginRateError } from './login-core';
export type { LoginInput } from './login-core';

export interface LoginDependencies extends LoginCoreDependencies {
  sessionConfig?: Pick<RuntimeConfig, 'sessionTtlMs'>;
}

/** Public result retained for the existing web login route. The raw session
 * token remains confined to the Set-Cookie value.
 */
export interface LoginResult { user: PublicUser; setCookie: string }

/** Anonymous web login service. The shared core handles credentials, admission
 * and identity revalidation; this adapter preserves the existing Cookie path.
 */
export async function login(
  dependencies: LoginDependencies,
  input: unknown,
  trustedIp: string,
): Promise<LoginResult> {
  const result = await loginWithCredential<LoginCookieCredential>(dependencies, input, trustedIp, {
    async issue(userId, now) {
      try {
        return await createCookieSession(dependencies.database, userId, now, dependencies.sessionConfig);
      } catch (error) {
        // Match the existing web behavior for a race with account deactivation.
        if (error instanceof SessionCreationError) throw new ApiError('unauthorized');
        throw error;
      }
    },
    async revoke(userId, credential, now) {
      await revokeSession(dependencies.database, credential.session.id, userId, now);
    },
  });
  return { user: result.user, setCookie: result.credential.setCookie };
}

type LoginCookieCredential = CookieSession;
