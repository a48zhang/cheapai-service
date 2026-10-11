import { ThemePicker } from '@cheapai/theme';
import { ArrowLeft, Menu, MessageSquare } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { AccountMenu } from '../../features/session/public';
import { useSession } from '../../features/session/useSession';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { BrandLink } from '../../shared/ui/BrandLink';
import { Button } from '../../shared/ui/Button';
import { Sheet } from '../../shared/ui/Sheet';
import {
  adminEntry,
  adminNavigation,
  personalNavigation,
  type NavigationItem,
} from '../navigation';

export function ConsoleLayout({
  children,
  mode = 'admin',
}: {
  children?: ReactNode;
  mode?: 'personal' | 'admin';
}) {
  const { isAdmin, error } = useSession();
  const [mobileOpen, setMobileOpen] = useState(false);
  const isManagement = mode === 'admin';
  const title = isManagement ? '管理控制台' : '个人控制台';

  function renderItem(item: NavigationItem) {
    const Icon = item.icon;
    return (
      <NavLink
        key={item.path}
        to={item.path}
        onClick={() => setMobileOpen(false)}
        className={({ isActive }) =>
          `flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] transition-colors ${isActive ? 'bg-[var(--color-accent-soft)] font-semibold text-[var(--color-accent)]' : 'text-[var(--color-muted-foreground)] hover:bg-[var(--color-surface-subtle)] hover:text-[var(--color-foreground)]'}`
        }
      >
        <Icon aria-hidden="true" size={19} strokeWidth={1.8} className="shrink-0" />
        <span>{item.label}</span>
      </NavLink>
    );
  }

  const navigation = (
    <nav aria-label={isManagement ? '管理导航' : '个人导航'} className="space-y-6">
      {isManagement ? (
        <>
          <div className="space-y-1">
            <Link
              to="/keys"
              onClick={() => setMobileOpen(false)}
              className="flex min-h-11 items-center gap-3 rounded-lg px-3 text-[15px] text-[var(--color-muted-foreground)] hover:bg-[var(--color-surface-subtle)] hover:text-[var(--color-foreground)]"
            >
              <ArrowLeft aria-hidden="true" size={19} strokeWidth={1.8} />
              个人控制台
            </Link>
            {renderItem({ path: '/chat', label: '对话', icon: MessageSquare })}
          </div>
          {adminNavigation.map((group) => (
            <div key={group.title}>
              <p className="mb-2 px-3 text-[13px] font-medium text-[var(--color-muted-foreground)]">
                {group.title}
              </p>
              <div className="space-y-1">{group.items.map(renderItem)}</div>
            </div>
          ))}
        </>
      ) : (
        <>
          <div className="space-y-1">{personalNavigation.map(renderItem)}</div>
          {isAdmin && (
            <div className="border-t border-[var(--color-border)] pt-4">
              {renderItem(adminEntry)}
            </div>
          )}
        </>
      )}
    </nav>
  );

  return (
    <div className="flex min-h-dvh bg-[var(--color-canvas)]">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:z-[70] focus:rounded-md focus:bg-[var(--color-surface)] focus:p-4"
      >
        跳到主要内容
      </a>
      <aside className="sticky top-0 hidden h-dvh w-[236px] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] md:flex">
        <div className="flex h-16 shrink-0 items-center border-b border-[var(--color-border)] px-6">
          <BrandLink className="text-xl font-semibold" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-5">{navigation}</div>
        <div className="shrink-0 border-t border-[var(--color-border)] p-3">
          <AccountMenu layout="sidebar" />
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="flex h-16 items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <Sheet
              open={mobileOpen}
              onOpenChange={setMobileOpen}
              title={title}
              side="left"
              trigger={
                <Button variant="ghost" size="icon" className="md:hidden" aria-label="打开导航">
                  <Menu aria-hidden="true" size={21} />
                </Button>
              }
            >
              {navigation}
            </Sheet>
            <span className="text-[15px] font-medium text-[var(--color-muted-foreground)]">
              {title}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <ThemePicker />
            <div className="md:hidden">
              <AccountMenu compact showTheme={false} />
            </div>
          </div>
        </header>
        <main
          id="main-content"
          className="mx-auto w-full max-w-[1440px] space-y-6 p-4 sm:p-6 lg:p-8"
          tabIndex={-1}
        >
          {error && <ApiErrorNotice error={error} />}
          {children ?? <Outlet />}
        </main>
      </div>
    </div>
  );
}
