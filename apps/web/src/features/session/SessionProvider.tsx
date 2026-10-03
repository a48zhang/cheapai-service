import { createContext, useContext, useEffect } from 'react';
import type { ReactNode } from 'react';
import { runtime as defaultRuntime } from '../../shared/api/runtime';
import type { AppRuntime } from '../../shared/api/runtime';

const SessionContext = createContext<AppRuntime>(defaultRuntime);
export function SessionProvider({ children, runtime = defaultRuntime }: { children: ReactNode; runtime?: AppRuntime }) {
  useEffect(() => {
    if (runtime.session.getSnapshot().status === 'unknown') void runtime.session.restore().catch(() => undefined);
  }, [runtime]);
  return <SessionContext.Provider value={runtime}>{children}</SessionContext.Provider>;
}
export const useSessionRuntime = () => useContext(SessionContext);
