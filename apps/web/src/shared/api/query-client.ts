import { QueryClient } from '@tanstack/react-query';
import { ApiClientError } from '@cheapai/api-client/errors';

export function createQueryClient() {
  return new QueryClient({ defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (count, error) => count < 1 && error instanceof ApiClientError && (error.kind === 'network' || (error.status !== null && error.status >= 500)),
    },
    mutations: { retry: false },
  } });
}
