import { ApiError } from '../../http';
import type { DesktopLoginResponse } from '@sub2api/desktop-contracts';
import { loginWithCredential } from '../login-core';
import type { LoginCoreDependencies } from '../login-core';
import { createDesktopSession, DesktopSessionCreationError, revokeDesktopSession } from './session-repository';
import type { IssuedDesktopSession } from './session-repository';

export { LoginRateError } from '../login-core';

export type DesktopLoginDependencies = LoginCoreDependencies;

/** Private login response for Runtime/host delivery. The stored session row,
 * token digest and Key binding never enter this result.
 */
export type DesktopLoginResult = DesktopLoginResponse;

/** Desktop login shares password verification, login limits and identity
 * revalidation with web login while issuing only a desktop bearer session.
 */
export async function loginDesktop(
  dependencies: DesktopLoginDependencies,
  input: unknown,
  trustedIp: string,
): Promise<DesktopLoginResponse> {
  const result = await loginWithCredential<IssuedDesktopSession>(dependencies, input, trustedIp, {
    async issue(userId, now) {
      try {
        return await createDesktopSession(dependencies.database, userId, now);
      } catch (error) {
        // The conditional insert rejects a concurrent user/group deactivation.
        // It creates no row in that case, which remains a uniform login failure.
        if (error instanceof DesktopSessionCreationError) throw new ApiError('unauthorized');
        throw error;
      }
    },
    async revoke(userId, credential, now) {
      await revokeDesktopSession(dependencies.database, credential.session.id, userId, now);
    },
  });

  return {
    token: result.credential.token,
    expiresAt: result.credential.session.expires_at,
    user: result.user,
  };
}
