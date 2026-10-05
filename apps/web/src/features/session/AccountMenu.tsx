import { ThemePicker } from '@cheapai/theme';
import { ArrowUpRight } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { safeReturnPath } from '../../shared/lib/return-path';
import { DropdownMenu } from '../../shared/ui/DropdownMenu';
import { useSession } from './useSession';

/** Compact personal navigation shared by chat and personal pages. */
export function AccountMenu({ compact = false }: { compact?: boolean }) {
  const { user, isAdmin, session, pending } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const returnTo = safeReturnPath(location.pathname + location.search);

  return (
    <nav aria-label="个人导航" className="flex items-center gap-2 sm:gap-4">
      <ThemePicker />
      <Link
        to="/keys"
        aria-label="API 接入"
        title="API 接入"
        className="inline-flex min-h-9 items-center gap-1 text-xs font-medium text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] sm:text-sm"
      >
        {compact ? 'API' : 'API 接入'} <ArrowUpRight aria-hidden="true" size={14} />
      </Link>
      {user ? (
        <DropdownMenu
          trigger={
            <button
              type="button"
              aria-label="账户菜单"
              title={user.email_normalized}
              className="flex min-h-9 items-center gap-2 text-xs"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--color-accent-soft)] font-semibold text-[var(--color-accent)]">
                {user.email_normalized.slice(0, 1).toUpperCase()}
              </span>
              {!compact && (
                <span className="hidden max-w-48 truncate lg:block">{user.email_normalized}</span>
              )}
            </button>
          }
          items={[
            { label: '费用', onSelect: () => navigate('/billing') },
            { label: '使用记录', onSelect: () => navigate('/requests') },
            ...(isAdmin
              ? [{ label: '管理控制台', onSelect: () => navigate('/admin/channels') }]
              : []),
            { type: 'separator' },
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
        <Link
          to={`/login?returnTo=${encodeURIComponent(returnTo)}`}
          className="inline-flex min-h-9 items-center rounded-md px-2 text-xs font-medium text-[var(--color-primary)] hover:bg-[var(--color-surface-subtle)] sm:px-3 sm:text-sm"
        >
          登录
        </Link>
      )}
    </nav>
  );
}
