import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { SessionProvider } from '../features/session/SessionProvider';
import { ToastProvider } from '../shared/ui/Toast';
import { runtime as defaultRuntime } from '../shared/api/runtime';
import type { AppRuntime } from '../shared/api/runtime';

export function AppProviders({ children, runtime = defaultRuntime }: { children: ReactNode; runtime?: AppRuntime }) {
  return <QueryClientProvider client={runtime.queryClient}>
    <ToastProvider><SessionProvider runtime={runtime}>{children}</SessionProvider></ToastProvider>
  </QueryClientProvider>;
}
