import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PanelLeft, ArrowUpRight, ChevronDown } from 'lucide-react';
import { useSession } from '../../session/public';
import { Button } from '../../../shared/ui/Button';
import { BrandLink } from '../../../shared/ui/BrandLink';
import { DropdownMenu } from '../../../shared/ui/DropdownMenu';
import { Sheet } from '../../../shared/ui/Sheet';

export interface ChatLayoutProps {
  sidebar: (close: () => void, mobile: boolean) => ReactNode;
  children: ReactNode;
  controls?: ReactNode;
}
export function ChatLayout({ sidebar, children, controls }: ChatLayoutProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user, isAdmin, session, pending } = useSession();
  const navigate = useNavigate();
  return (
    <div className="flex h-dvh min-h-[28rem] flex-col bg-[var(--color-canvas)]">
      <a
        href="#chat-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-white focus:p-4"
      >
        跳到对话内容
      </a>
      <header className="z-10 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] bg-white px-4 md:px-6">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="打开聊天记录"
            onClick={() => setMobileOpen(true)}
          >
            <PanelLeft size={19} />
          </Button>
          <BrandLink className="text-xl font-semibold tracking-tight" />
          <span className="hidden h-4 border-l border-[var(--color-border)] sm:block" />
          <DropdownMenu
            trigger={
              <button
                type="button"
                className="hidden items-center gap-2 text-sm text-[var(--color-muted-foreground)] sm:flex"
              >
                聊天工作台
                <ChevronDown size={13} />
              </button>
            }
            items={[
              { label: '聊天工作台', onSelect: () => navigate('/') },
              { label: '个人控制台', onSelect: () => navigate('/dashboard') },
              ...(isAdmin
                ? [{ label: '管理控制台', onSelect: () => navigate('/admin/channels') }]
                : []),
            ]}
          />
        </div>
        <div className="flex items-center gap-3">
          <Link
            to="/keys"
            className="hidden items-center gap-1 text-xs text-[var(--color-muted-foreground)] sm:flex"
          >
            API 接入 <ArrowUpRight size={13} />
          </Link>
          {user ? (
            <DropdownMenu
              trigger={
                <button
                  type="button"
                  aria-label="账户菜单"
                  className="flex items-center gap-2 text-xs"
                >
                  <span className="grid size-7 place-items-center rounded-full bg-indigo-100 font-semibold text-indigo-700">
                    {user.email_normalized.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="hidden lg:block">{user.email_normalized}</span>
                </button>
              }
              items={[
                { label: '账户概览', onSelect: () => navigate('/dashboard') },
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
          ) : (
            <Button asChild size="sm">
              <Link to="/login">登录</Link>
            </Button>
          )}
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="hidden h-full shrink-0 md:flex">{sidebar(() => undefined, false)}</div>
        <Sheet
          open={mobileOpen}
          onOpenChange={setMobileOpen}
          side="left"
          title="聊天记录"
          closeButton={false}
        >
          <div className="h-full [&_aside]:static [&_aside]:h-full [&_aside]:w-full [&_aside]:translate-x-0 [&_aside]:shadow-none">
            {sidebar(() => setMobileOpen(false), true)}
          </div>
        </Sheet>
        <main id="chat-content" className="flex min-w-0 flex-1 flex-col bg-white">
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
