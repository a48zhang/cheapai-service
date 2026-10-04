import { createContext, useContext, useEffect } from 'react';
import type { ReactNode } from 'react';
import type { AppRuntime } from '../../shared/api/runtime';

const SessionContext = createContext<AppRuntime | null>(null);

export function SessionProvider({
  children,
  runtime,
}: {
  children: ReactNode;
  runtime: AppRuntime;
}) {
  useEffect(() => {
    if (runtime.session.getSnapshot().status === 'unknown')
      void runtime.session.restore().catch(() => undefined);
  }, [runtime]);
  return <SessionContext.Provider value={runtime}>{children}</SessionContext.Provider>;
}

export function useSessionRuntime() {
  const runtime = useContext(SessionContext);
  if (!runtime) throw new Error('useSessionRuntime must be used within SessionProvider.');
  return runtime;
}
