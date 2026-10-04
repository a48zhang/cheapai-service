import { useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useSession } from '../../features/session/useSession';
import { adminNavigation } from '../navigation';
import { Button } from '../../shared/ui/Button';
import { BrandLink } from '../../shared/ui/BrandLink';
import { Sheet } from '../../shared/ui/Sheet';
import { DropdownMenu } from '../../shared/ui/DropdownMenu';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';

export function ConsoleLayout({ children }: { children?: ReactNode }) {
  const { user, session, pending, error } = useSession();
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();
  const navigation = (
    <nav aria-label="管理导航" className="flex-1 space-y-6 px-3 py-5">
      {adminNavigation.map((group) => (
        <div key={group.title}>
          <p className="mb-2 px-3 text-[11px] font-medium uppercase tracking-wider text-[var(--color-muted-foreground)]">
            {group.title}
          </p>
          <div className="space-y-1">
            {group.items.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === '/'}
                onClick={() => setMobileOpen(false)}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${isActive ? 'bg-indigo-50 font-medium text-indigo-600' : 'text-[var(--color-muted-foreground)] hover:bg-[var(--color-surface-subtle)] hover:text-[var(--color-foreground)]'}`
                }
              >
                <span aria-hidden="true" className="w-4 text-center">
                  {item.icon}
                </span>
                {item.label}
              </NavLink>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
  return (
    <div className="flex min-h-dvh bg-[var(--color-canvas)]">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-white focus:p-4"
      >
        跳到主要内容
      </a>
      <aside className="sticky top-0 hidden h-dvh w-[var(--sidebar-width)] shrink-0 flex-col border-r border-[var(--color-border)] bg-white md:flex">
        <BrandLink className="px-6 py-5 text-xl font-semibold tracking-tight" />
        {navigation}
        <div className="border-t border-[var(--color-border)] p-4">
          <Link to="/chat" className="text-xs text-[var(--color-muted-foreground)]">
            ← 返回聊天
          </Link>
        </div>
      </aside>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen} title="管理导航" side="left">
        {navigation}
      </Sheet>
      <div className="min-w-0 flex-1">
        <header className="flex h-14 items-center justify-between gap-3 border-b border-[var(--color-border)] bg-white px-5 md:px-8">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label="打开导航"
              onClick={() => setMobileOpen(true)}
            >
              ☰
            </Button>
            <span className="text-sm font-medium">管理控制台</span>
          </div>
          <DropdownMenu
            trigger={
              <button
                type="button"
                aria-label="账户菜单"
                className="flex items-center gap-2 text-sm"
              >
                <span className="grid h-7 w-7 place-items-center rounded-full bg-indigo-100 text-indigo-600">
                  {user?.email_normalized.slice(0, 1).toUpperCase()}
                </span>
                <span className="hidden sm:block">{user?.email_normalized}</span>
              </button>
            }
            items={[
              {
                label: '退出登录',
                disabled: pending !== null,
                onSelect: () => {
                  void session
                    .logout()
                    .then(() => navigate('/login', { replace: true }))
                    .catch(() => undefined);
                },
              },
            ]}
          />
        </header>
        <main id="main-content" className="mx-auto max-w-[1440px] space-y-5 p-5 md:p-8">
          {error && <ApiErrorNotice error={error} />}
          {children ?? <Outlet />}
        </main>
      </div>
    </div>
  );
}
