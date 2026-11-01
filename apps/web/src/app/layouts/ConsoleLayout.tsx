import { useNavigationSheet } from '../../shared/patterns/useNavigationSheet';
import { RouteButton } from '../../shared/ui/RouteButton';
import { PersonalNavigation, NavigationButton } from '../../shared/patterns/AppNavigation';
import { useProductEnvironment } from '../../shared/platform';
import { SkipToContent } from '../../shared/ui/SkipToContent';
import { ArrowLeft, Menu, MessageSquare, PanelLeft, PanelLeftClose } from 'lucide-react';
import { type ReactNode, Suspense } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useDesktopNavigation } from '../../shared/patterns/NavigationState';
import { AccountMenu } from '../../features/session/public';
import { useSession } from '../../features/session/useSession';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { AsyncState } from '../../shared/patterns/AsyncState';
import { AppShell } from '../../shared/patterns/AppShell';
import { BrandLink } from '../../shared/ui/BrandLink';
import { AppTopbar } from '../../shared/patterns/AppTopbar';
import { Button } from '../../shared/ui/Button';
import { NavigationSheet } from '../../shared/patterns/NavigationSheet';
import { adminNavigation, personalNavigation, type NavigationItem } from '../../shared/navigation';

export function ConsoleLayout({
  children,
  mode = 'admin',
}: {
  children?: ReactNode;
  mode?: 'personal' | 'admin';
}) {
  const { kind } = useProductEnvironment();
  const { isAdmin, error } = useSession();
  const [mobileOpen, setMobileOpen] = useNavigationSheet();
  const [desktopOpen, setDesktopOpen] = useDesktopNavigation();
  const isManagement = mode === 'admin';
  const title = isManagement ? '管理控制台' : '个人控制台';
  const { pathname } = useLocation();
  const currentItem = (
    isManagement ? adminNavigation.flatMap((group) => group.items) : personalNavigation
  ).find(
    (item) =>
      pathname === item.path ||
      pathname.startsWith(`${item.path}/`) ||
      (kind === 'desktop' && pathname === '/models' && item.path === '/console/models'),
  );

  function renderItem(item: NavigationItem) {
    return <NavigationButton key={item.path} item={item} onNavigate={() => setMobileOpen(false)} />;
  }

  const navigation = (
    <div
      role={isManagement ? 'navigation' : undefined}
      aria-label={isManagement ? '管理导航' : undefined}
      className="space-y-4"
    >
      {isManagement ? (
        <>
          <div className="space-y-1">
            <RouteButton
              to="/keys"
              onClick={() => setMobileOpen(false)}
              className="flex min-h-9 items-center gap-3 rounded-md px-3 text-sm text-[var(--color-muted-foreground)] hover:bg-[var(--color-surface-subtle)] hover:text-[var(--color-foreground)]"
            >
              <ArrowLeft aria-hidden="true" size={16} strokeWidth={1.8} />
              个人控制台
            </RouteButton>
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
        <PersonalNavigation isAdmin={isAdmin} onNavigate={() => setMobileOpen(false)} />
      )}
    </div>
  );

  return (
    <AppShell
      skipLink={<SkipToContent target="main-content" />}
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
            <BrandLink
              to={kind === 'desktop' ? '/models' : '/'}
              className="text-base font-semibold"
            />
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
              <NavigationSheet
                open={mobileOpen}
                onOpenChange={setMobileOpen}
                title={isManagement ? '管理导航' : '个人导航'}
                trigger={
                  <Button variant="ghost" size="icon" className="md:!hidden" aria-label="打开导航">
                    <Menu aria-hidden="true" size={21} />
                  </Button>
                }
              >
                <div className="px-2 py-3">{navigation}</div>
              </NavigationSheet>
            </>
          }
          context={
            <nav aria-label="当前位置" className="flex min-w-0 items-center gap-2 text-sm">
              <span className="hidden shrink-0 text-[var(--color-muted-foreground)] sm:inline">
                {title}
              </span>
              {currentItem && (
                <>
                  <span
                    aria-hidden="true"
                    className="hidden text-[var(--color-muted-foreground)] sm:inline"
                  >
                    /
                  </span>
                  <span aria-current="page" className="truncate font-medium">
                    {currentItem.label}
                    {pathname.endsWith('/actions/create')
                      ? ' · 新建'
                      : pathname.startsWith(`${currentItem.path}/`)
                        ? '详情'
                        : ''}
                  </span>
                </>
              )}
            </nav>
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
          <Suspense
            fallback={
              <AsyncState
                status="loading"
                loadingLabel="正在加载页面…"
                className="flex min-h-60 items-center justify-center"
              />
            }
          >
            {children ?? <Outlet />}
          </Suspense>
        </main>
      </div>
    </AppShell>
  );
}
