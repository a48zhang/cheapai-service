import { useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { Dialog } from '../../shared/ui/Dialog';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { ThemePicker } from '@cheapai/theme';
import { ArrowUpRight, ChevronsUpDown } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { safeReturnPath } from '../../shared/lib/return-path';
import { DropdownMenu } from '../../shared/ui/DropdownMenu';
import { useSession } from './useSession';

/** Compact personal navigation shared by chat and personal pages. */
export function AccountMenu({
  compact = false,
  layout = 'inline',
  showTheme = true,
  showShortcut = true,
}: {
  compact?: boolean;
  layout?: 'inline' | 'sidebar';
  showTheme?: boolean;
  showShortcut?: boolean;
}) {
  const [logoutError, setLogoutError] = useState<unknown>(null);
  const isSidebar = layout === 'sidebar';
  const { user, isAdmin, session, pending } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const returnTo = safeReturnPath(location.pathname + location.search);

  const logout = async () => {
    setLogoutError(null);
    try {
      await session.logout();
      navigate('/login', { replace: true });
    } catch (error) {
      setLogoutError(error);
    }
  };

  return (
    <nav
      aria-label="账户与快捷入口"
      className={isSidebar ? 'w-full' : 'flex items-center gap-2 sm:gap-4'}
    >
      {!isSidebar && showTheme && <ThemePicker />}
      {!isSidebar && showShortcut && (
        <Link
          to="/keys"
          aria-label="API 接入"
          title="API 接入"
          className="inline-flex min-h-9 items-center gap-1 text-sm font-medium text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] sm:text-sm"
        >
          {compact ? 'API' : 'API 接入'} <ArrowUpRight aria-hidden="true" size={14} />
        </Link>
      )}
      {user ? (
        <DropdownMenu
          trigger={
            <button
              type="button"
              aria-label="账户菜单"
              title={user.email_normalized}
              className={
                isSidebar
                  ? 'flex min-h-12 w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-[14px] hover:bg-[var(--color-surface-subtle)]'
                  : 'flex min-h-10 items-center gap-2 rounded-lg px-2 text-sm outline-none hover:bg-[var(--color-muted)] focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]'
              }
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--color-accent-soft)] font-semibold text-[var(--color-accent)]">
                {user.email_normalized.slice(0, 1).toUpperCase()}
              </span>
              {!compact && (
                <span
                  className={
                    isSidebar ? 'min-w-0 flex-1 truncate' : 'hidden max-w-48 truncate lg:block'
                  }
                >
                  {user.email_normalized}
                </span>
              )}
              <ChevronsUpDown
                aria-hidden="true"
                size={16}
                className="shrink-0 text-[var(--color-muted-foreground)]"
              />
            </button>
          }
          side={isSidebar ? 'top' : 'bottom'}
          align={isSidebar ? 'start' : 'end'}
          items={[
            ...(!showShortcut ? [{ label: 'API 接入', to: '/keys' }] : []),
            { label: '费用', to: '/billing' },
            { label: '请求记录', to: '/requests' },
            ...(isAdmin ? [{ label: '管理控制台', to: '/admin/channels' }] : []),
            { type: 'separator' },
            {
              label: '退出登录',
              disabled: pending !== null,
              onSelect: () => {
                void logout();
              },
            },
          ]}
        />
      ) : (
        <Link
          to={`/login?returnTo=${encodeURIComponent(returnTo)}`}
          className="inline-flex min-h-9 shrink-0 items-center whitespace-nowrap rounded-md border border-[var(--color-border)] px-3 text-sm font-medium text-[var(--color-foreground)] hover:bg-[var(--color-surface-subtle)]"
        >
          登录
        </Link>
      )}
      <Dialog
        open={logoutError !== null}
        onOpenChange={(open) => {
          if (!open) setLogoutError(null);
        }}
        title="退出登录未完成"
        description="你仍处于登录状态，可以重试。"
        footer={
          <Button busy={pending !== null} onClick={() => void logout()}>
            重新退出
          </Button>
        }
      >
        <ApiErrorNotice error={logoutError} />
      </Dialog>
    </nav>
  );
}
