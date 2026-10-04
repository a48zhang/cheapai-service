import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { SessionProvider } from '../features/session/SessionProvider';
import { runtime as defaultRuntime } from './runtime';
import type { AppRuntime } from '../shared/api/runtime';

export function AppProviders({
  children,
  runtime = defaultRuntime,
}: {
  children: ReactNode;
  runtime?: AppRuntime;
}) {
  return (
    <QueryClientProvider client={runtime.queryClient}>
      <SessionProvider runtime={runtime}>{children}</SessionProvider>
    </QueryClientProvider>
  );
}
