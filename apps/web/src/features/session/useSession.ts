import { useSyncExternalStore } from 'react';
import { useSessionRuntime } from './SessionProvider';

export function useSession() {
  const runtime = useSessionRuntime();
  const state = useSyncExternalStore(
    runtime.session.subscribe,
    runtime.session.getSnapshot,
    runtime.session.getSnapshot,
  );
  return {
    ...state,
    state,
    controller: runtime.session,
    ...runtime,
    isAuthenticated: state.status === 'authenticated',
    isAdmin: state.status === 'authenticated' && state.user?.role === 'admin',
  };
}
