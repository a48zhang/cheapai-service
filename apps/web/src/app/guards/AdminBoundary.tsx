import { RouteButton } from '../../shared/ui/RouteButton';
import type { ReactNode } from 'react';
import { Outlet } from 'react-router-dom';
import { useSession } from '../../features/session/useSession';

export function AdminBoundary({ children }: { children?: ReactNode }) {
  const { isAdmin } = useSession();
  if (!isAdmin)
    return (
      <section className="p-8">
        <h1 className="text-2xl font-semibold">没有访问权限</h1>
        <p className="my-3 text-[var(--color-muted-foreground)]">此页面需要管理员权限。</p>
        <RouteButton variant="primary" to="/chat">
          返回聊天
        </RouteButton>
      </section>
    );
  return children ?? <Outlet />;
}
