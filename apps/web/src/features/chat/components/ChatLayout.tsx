import { useState, type ReactNode } from 'react';
import { PanelLeft, PanelLeftClose, SquarePen } from 'lucide-react';
import { useDesktopNavigation } from '../../../shared/patterns/NavigationState';
import { AccountMenu } from '../../session/public';
import { Button } from '../../../shared/ui/Button';
import { AppTopbar } from '../../../shared/patterns/AppTopbar';
import { Sheet } from '../../../shared/ui/Sheet';
import './chat.css';

export interface ChatLayoutProps {
  sidebar: (close: () => void, mobile: boolean) => ReactNode;
  children: ReactNode;
  controls?: ReactNode;
  onNew?: () => void;
}
export function ChatLayout({ sidebar, children, controls, onNew }: ChatLayoutProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [desktopOpen, setDesktopOpen] = useDesktopNavigation();
  return (
    <div className="chat-theme chat-workspace">
      <a
        href="#chat-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-[var(--color-surface)] focus:p-4"
      >
        跳到对话内容
      </a>
      <AppTopbar
        sidebarToggle={
          <>
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
            <Button
              variant="ghost"
              size="icon"
              className="max-md:!hidden"
              aria-label={desktopOpen ? '收起侧栏' : '展开侧栏'}
              aria-expanded={desktopOpen}
              aria-controls="desktop-chat-sidebar"
              onClick={() => setDesktopOpen(!desktopOpen)}
            >
              {desktopOpen ? <PanelLeftClose size={19} /> : <PanelLeft size={19} />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="md:!hidden"
              aria-label="打开聊天记录"
              onClick={() => setMobileOpen(true)}
            >
              <PanelLeft size={19} />
            </Button>
          </>
        }
        context={
          <>
            {!desktopOpen && onNew && (
              <Button variant="ghost" size="sm" onClick={onNew}>
                <SquarePen size={16} aria-hidden="true" />
                新对话
              </Button>
            )}
          </>
        }
        account={<AccountMenu compact showTheme={false} showShortcut={false} />}
      />
      <div className="flex min-h-0 flex-1">
        <div
          id="desktop-chat-sidebar"
          className={desktopOpen ? 'chat-desktop-sidebar hidden md:flex' : 'hidden'}
        >
          {sidebar(() => undefined, false)}
        </div>
        <Sheet
          open={mobileOpen}
          onOpenChange={setMobileOpen}
          side="left"
          title="聊天记录"
          closeButton={false}
          className="chat-theme"
        >
          <div className="h-full [&_aside]:static [&_aside]:h-full [&_aside]:w-full [&_aside]:translate-x-0 [&_aside]:shadow-none">
            {sidebar(() => setMobileOpen(false), true)}
          </div>
        </Sheet>
        <main id="chat-content" className="chat-main">
          {controls && (
            <div className="flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-[var(--color-border)] px-4 py-3 md:px-8">
              {controls}
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}
