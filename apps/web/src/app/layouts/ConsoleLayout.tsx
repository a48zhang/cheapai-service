import { useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useSession } from '../../features/session/useSession';
import { adminNavigation, personalNavigation } from '../navigation';
import { Button } from '../../shared/ui/Button';
import { Sheet } from '../../shared/ui/Sheet';
import { DropdownMenu } from '../../shared/ui/DropdownMenu';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';

export function ConsoleLayout({ children, mode = 'personal' }: { children?: ReactNode; mode?: 'personal' | 'admin' }) {
  const { user, isAdmin, session, pending, error } = useSession();
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();
  const groups = mode === 'admin' ? adminNavigation : personalNavigation;
  const navigation = <nav aria-label={mode === 'admin' ? '管理导航' : '个人导航'} className="flex-1 space-y-6 px-3 py-5">
    {groups.map(group => <div key={group.title}><p className="mb-2 px-3 text-[11px] font-medium uppercase tracking-wider text-[var(--muted)]">{group.title}</p>
      <div className="space-y-1">{group.items.map(item => <NavLink key={item.path} to={item.path} end={item.path === '/'}
        onClick={() => setMobileOpen(false)} className={({ isActive }) => `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${isActive ? 'bg-indigo-50 font-medium text-indigo-600' : 'text-[var(--muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]'}`}>
        <span aria-hidden="true" className="w-4 text-center">{item.icon}</span>{item.label}
      </NavLink>)}</div>
    </div>)}
  </nav>;
  const brand = <Link to="/" className="flex items-center gap-2 px-6 py-5 text-xl font-semibold tracking-tight"><svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><path fill="#4F46E5" d="M13 1 25 7v12l-12 6-12-6V7z" /><path fill="#fff" d="m8 9 6-3 5 3-6 3v8l-5-3z" /></svg>cheapai</Link>;
  return <div className="flex min-h-dvh bg-[var(--canvas)]">
    <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-white focus:p-4">跳到主要内容</a>
    <aside className="sticky top-0 hidden h-dvh w-[232px] shrink-0 flex-col border-r border-[var(--border)] bg-white md:flex">{brand}{navigation}
      <div className="border-t border-[var(--border)] p-4"><Link to={mode === 'admin' ? '/dashboard' : '/'} className="text-xs text-[var(--muted)]">{mode === 'admin' ? '← 个人控制台' : '← 聊天工作台'}</Link></div>
    </aside>
    <Sheet open={mobileOpen} onOpenChange={setMobileOpen} title="cheapai" side="left">{navigation}</Sheet>
    <div className="min-w-0 flex-1">
      <header className="flex h-14 items-center justify-between gap-3 border-b border-[var(--border)] bg-white px-5 md:px-8">
        <div className="flex items-center gap-3"><Button variant="ghost" size="icon" className="md:hidden" aria-label="打开导航" onClick={() => setMobileOpen(true)}>☰</Button>
          <DropdownMenu trigger={<button type="button" className="text-sm font-medium">{mode === 'admin' ? '管理控制台' : '个人控制台'} <span className="ml-2 text-[var(--muted)]">⌄</span></button>}
            items={[{ label: '聊天工作台', onSelect: () => navigate('/') }, { label: '个人控制台', onSelect: () => navigate('/dashboard') }, ...(isAdmin ? [{ label: '管理控制台', onSelect: () => navigate('/admin/channels') }] : [])]} />
        </div>
        <DropdownMenu trigger={<button type="button" aria-label="账户菜单" className="flex items-center gap-2 text-sm"><span className="grid h-7 w-7 place-items-center rounded-full bg-indigo-100 text-indigo-600">{user?.email_normalized.slice(0, 1).toUpperCase()}</span><span className="hidden sm:block">{user?.email_normalized}</span></button>}
          items={[{ label: '退出登录', disabled: pending !== null, onSelect: () => { void session.logout().then(() => navigate('/login', { replace: true })).catch(() => undefined); } }]} />
      </header>
      <main id="main-content" className="mx-auto max-w-[1440px] space-y-5 p-5 md:p-8">{error && <ApiErrorNotice error={error} />}{children ?? <Outlet />}</main>
    </div>
  </div>;
}
