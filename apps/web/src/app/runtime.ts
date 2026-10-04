import { createAuthApi } from '@cheapai/api-client/auth';
import { readCsrfCookie } from '@cheapai/api-client/csrf';
import { createApiClient } from '@cheapai/api-client/client';
import type { SessionIdentity } from '@cheapai/api-client/types';
import { createSessionController } from '../features/session/controller';
import { createQueryClient } from '../shared/api/query-client';
import type { AppRuntime } from '../shared/api/runtime';

export function createRuntime(options: { fetch?: typeof fetch } = {}): AppRuntime {
  const identityOptions = {
    ...options,
    captureIdentity: () => session?.requestIdentity() ?? null,
    onUnauthorized: (identity: SessionIdentity) => {
      session?.expire(identity);
    },
  };
  const auth = createAuthApi(identityOptions);
  const session = createSessionController(auth);
  const client = createApiClient({
    ...identityOptions,
    getCsrfToken: async () => readCsrfCookie() ?? (await auth.bootstrap()).csrfToken,
  });
  const queryClient = createQueryClient();
  let previousUser = session.getSnapshot().user?.id ?? null;
  let previousEpoch = session.getSnapshot().epoch;
  const unsubscribe = session.subscribe(() => {
    const current = session.getSnapshot();
    const currentUser = current.user?.id ?? null;
    if (
      currentUser !== previousUser ||
      (current.epoch !== previousEpoch && current.pending !== 'restore')
    ) {
      void queryClient.cancelQueries();
      queryClient.clear();
    }
    previousUser = currentUser;
    previousEpoch = current.epoch;
  });
  return {
    session,
    auth,
    client,
    queryClient,
    dispose: () => {
      unsubscribe();
      queryClient.clear();
    },
  };
}

export const runtime = createRuntime();
