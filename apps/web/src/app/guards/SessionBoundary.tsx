import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '../../features/session/useSession';

export function SessionBoundary({ children }: { children?: ReactNode }) {
  const session = useSession();
  const location = useLocation();
  const returnTo = encodeURIComponent(location.pathname + location.search);
  if (session.status === 'unknown') return <p role="status" className="p-8">正在确认身份…</p>;
  if (session.status === 'unavailable') return <Navigate replace to={`/session-unavailable?returnTo=${returnTo}`} />;
  if (!session.isAuthenticated) return <Navigate replace to={`/login?returnTo=${returnTo}`} />;
  return children ?? <Outlet />;
}
