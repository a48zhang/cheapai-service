import { ArrowLeft, Menu, MessageSquare, PanelLeft, PanelLeftClose } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { useDesktopNavigation } from '../../shared/patterns/NavigationState';
import { AccountMenu } from '../../features/session/public';
import { useSession } from '../../features/session/useSession';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { AppShell } from '../../shared/patterns/AppShell';
import { BrandLink } from '../../shared/ui/BrandLink';
import { AppTopbar } from '../../shared/patterns/AppTopbar';
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
  const [desktopOpen, setDesktopOpen] = useDesktopNavigation();
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
          `flex min-h-9 items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${isActive ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-ink)]' : 'text-[var(--color-muted-foreground)] hover:bg-[var(--color-surface-subtle)] hover:text-[var(--color-foreground)]'}`
        }
      >
        <Icon aria-hidden="true" size={16} strokeWidth={1.8} className="shrink-0" />
        <span>{item.label}</span>
      </NavLink>
    );
  }

  const navigation = (
    <nav aria-label={isManagement ? '管理导航' : '个人导航'} className="space-y-4">
      {isManagement ? (
        <>
          <div className="space-y-1">
            <Link
              to="/keys"
              onClick={() => setMobileOpen(false)}
              className="flex min-h-9 items-center gap-3 rounded-md px-3 text-sm text-[var(--color-muted-foreground)] hover:bg-[var(--color-surface-subtle)] hover:text-[var(--color-foreground)]"
            >
              <ArrowLeft aria-hidden="true" size={16} strokeWidth={1.8} />
              个人控制台
            </Link>
            {renderItem({ path: '/chat', label: '对话', icon: MessageSquare })}
          </div>
          {adminNavigation.map((group) => (
            <div key={group.title}>
              <p className="mb-2 px-3 text-sm font-medium text-[var(--color-muted-foreground)]">
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
    <AppShell
      skipLink={
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:z-[70] focus:rounded-md focus:bg-[var(--color-surface)] focus:p-4"
        >
          跳到主要内容
        </a>
      }
      open={desktopOpen}
      sidebar={
        <aside
          id="desktop-console-sidebar"
          className={
            desktopOpen
              ? 'sticky top-0 hidden h-dvh min-w-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface-subtle)] md:flex'
              : 'hidden'
          }
        >
          <div className="flex h-14 shrink-0 items-center px-4">
            <BrandLink className="text-base font-semibold" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">{navigation}</div>
        </aside>
      }
      header={
        <AppTopbar
          sidebarToggle={
            <>
              <Button
                variant="ghost"
                size="icon"
                className="max-md:!hidden"
                aria-label={desktopOpen ? '收起导航' : '展开导航'}
                aria-expanded={desktopOpen}
                aria-controls="desktop-console-sidebar"
                onClick={() => setDesktopOpen(!desktopOpen)}
              >
                {desktopOpen ? (
                  <PanelLeftClose aria-hidden="true" size={16} />
                ) : (
                  <PanelLeft aria-hidden="true" size={16} />
                )}
              </Button>
              <Sheet
                open={mobileOpen}
                onOpenChange={setMobileOpen}
                title={title}
                side="left"
                trigger={
                  <Button variant="ghost" size="icon" className="md:!hidden" aria-label="打开导航">
                    <Menu aria-hidden="true" size={21} />
                  </Button>
                }
              >
                {navigation}
              </Sheet>
            </>
          }
          context={
            <span className="truncate text-sm font-medium text-[var(--color-muted-foreground)]">
              {title}
            </span>
          }
          account={<AccountMenu compact showTheme={false} showShortcut={false} />}
        />
      }
    >
      <div className="min-w-0 flex-1">
        <main
          id="main-content"
          className="mx-auto w-full max-w-[1440px] space-y-6 p-4 sm:p-6 lg:p-8"
          tabIndex={-1}
        >
          {error && <ApiErrorNotice error={error} />}
          {children ?? <Outlet />}
        </main>
      </div>
    </AppShell>
  );
}
