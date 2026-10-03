import { createApiClient } from '@cheapai/api-client/client';
import { readCsrfCookie } from '@cheapai/api-client/csrf';
import { createAuthApi } from '@cheapai/api-client/auth';
import { createSessionController } from '../../features/session/controller';
import { createQueryClient } from './query-client';

export function createRuntime(options: { fetch?: typeof fetch } = {}) {
  const identityOptions = {
    ...options,
    captureIdentity: () => session?.requestIdentity() ?? null,
    onUnauthorized: (identity: Parameters<ReturnType<typeof createSessionController>['expire']>[0]) => { session?.expire(identity); },
  };
  const auth = createAuthApi(identityOptions);
  const session = createSessionController(auth);
  const client = createApiClient({ ...identityOptions, getCsrfToken: async () => readCsrfCookie() ?? (await auth.bootstrap()).csrfToken });
  const queryClient = createQueryClient();
  let previousUser = session.getSnapshot().user?.id ?? null;
  let previousEpoch = session.getSnapshot().epoch;
  const unsubscribe = session.subscribe(() => {
    const current = session.getSnapshot();
    const currentUser = current.user?.id ?? null;
    if (currentUser !== previousUser || (current.epoch !== previousEpoch && current.pending !== 'restore')) {
      void queryClient.cancelQueries();
      queryClient.clear();
    }
    previousUser = currentUser;
    previousEpoch = current.epoch;
  });
  return { session, auth, client, queryClient, dispose: () => { unsubscribe(); queryClient.clear(); } };
}
export type AppRuntime = ReturnType<typeof createRuntime>;
export const runtime = createRuntime();
