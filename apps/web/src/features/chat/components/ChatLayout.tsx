import { useNavigationSheet } from '../../../shared/patterns/useNavigationSheet';
import { SkipToContent } from '../../../shared/ui/SkipToContent';
import { type ReactNode } from 'react';
import { Menu, PanelLeft, PanelLeftClose, SquarePen } from 'lucide-react';
import { useDesktopNavigation } from '../../../shared/patterns/NavigationState';
import { AccountMenu } from '../../session/public';
import { Button } from '../../../shared/ui/Button';
import { AppShell } from '../../../shared/patterns/AppShell';
import { AppTopbar } from '../../../shared/patterns/AppTopbar';
import { NavigationSheet } from '../../../shared/patterns/NavigationSheet';
import './chat.css';

export interface ChatLayoutProps {
  sidebar: (close: () => void, mobile: boolean) => ReactNode;
  children: ReactNode;
  controls?: ReactNode;
  onNew?: () => void;
  title?: string;
}
export function ChatLayout({
  sidebar,
  children,
  controls,
  onNew,
  title = '新对话',
}: ChatLayoutProps) {
  const [mobileOpen, setMobileOpen] = useNavigationSheet();
  const [desktopOpen, setDesktopOpen] = useDesktopNavigation();
  return (
    <AppShell
      skipLink={<SkipToContent target="chat-content" />}
      open={desktopOpen}
      className="chat-workspace"
      sidebar={
        <div
          id="desktop-chat-sidebar"
          className={desktopOpen ? 'chat-desktop-sidebar hidden md:flex' : 'hidden'}
        >
          {sidebar(() => undefined, false)}
        </div>
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
                aria-controls="desktop-chat-sidebar"
                onClick={() => setDesktopOpen(!desktopOpen)}
              >
                {desktopOpen ? <PanelLeftClose size={16} /> : <PanelLeft size={16} />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="md:!hidden"
                aria-label="打开导航"
                onClick={() => setMobileOpen(true)}
              >
                <Menu aria-hidden="true" size={21} />
              </Button>
              {onNew && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="md:!hidden"
                  aria-label="新对话"
                  onClick={onNew}
                >
                  <SquarePen size={19} />
                </Button>
              )}
            </>
          }
          context={
            <>
              <span className="truncate text-sm font-medium">{title}</span>
              {!desktopOpen && onNew && (
                <Button variant="ghost" size="sm" className="max-md:!hidden" onClick={onNew}>
                  <SquarePen size={16} aria-hidden="true" />
                  新对话
                </Button>
              )}
            </>
          }
          account={<AccountMenu compact showTheme={false} showShortcut={false} />}
        />
      }
    >
      <NavigationSheet open={mobileOpen} onOpenChange={setMobileOpen} title="个人导航">
        <div className="h-full [&_aside]:static [&_aside]:h-full [&_aside]:w-full [&_aside]:translate-x-0 [&_aside]:shadow-none">
          {sidebar(() => setMobileOpen(false), true)}
        </div>
      </NavigationSheet>
      <main id="chat-content" className="chat-main" tabIndex={-1}>
        {controls && (
          <div className="flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-[var(--color-border)] px-4 py-3 md:px-8">
            {controls}
          </div>
        )}
        {children}
      </main>
    </AppShell>
  );
}
