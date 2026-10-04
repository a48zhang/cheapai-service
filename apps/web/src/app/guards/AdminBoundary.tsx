import type { ReactNode } from 'react';
import { Link, Outlet } from 'react-router-dom';
import { useSession } from '../../features/session/useSession';

export function AdminBoundary({ children }: { children?: ReactNode }) {
  const { isAdmin } = useSession();
  if (!isAdmin)
    return (
      <section className="p-8">
        <h1 className="text-2xl font-semibold">没有访问权限</h1>
        <p className="my-3 text-[var(--color-muted-foreground)]">此页面需要管理员权限。</p>
        <Link to="/">返回聊天</Link>
      </section>
    );
  return children ?? <Outlet />;
}
