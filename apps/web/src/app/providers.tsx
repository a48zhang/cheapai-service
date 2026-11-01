import { NavigationProvider } from '../shared/patterns/NavigationState';
import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { SessionProvider } from '../features/session/SessionProvider';
import { useSession } from '../features/session/useSession';
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
      <SessionProvider runtime={runtime}>
        <AccountNavigation>{children}</AccountNavigation>
      </SessionProvider>
    </QueryClientProvider>
  );
}

function AccountNavigation({ children }: { children: ReactNode }) {
  const { user } = useSession();
  return <NavigationProvider scope={user?.id ?? 'anonymous'}>{children}</NavigationProvider>;
}
