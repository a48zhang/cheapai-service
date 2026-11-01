import { ThemePicker } from '@cheapai/theme';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { ArrowUpRight, Menu } from 'lucide-react';
import { BrandLink } from '../../shared/ui/BrandLink';
import { Button } from '../../shared/ui/Button';
import { DropdownMenu } from '../../shared/ui/DropdownMenu';
import { useSession } from '../../features/session/useSession';
import { publicNavigation } from '../navigation';
import '../../shared/styles/public-site.css';

export function PublicLayout() {
  const { isAuthenticated } = useSession();
  const { pathname, hash } = useLocation();
  const active =
    pathname === '/models'
      ? '/models'
      : hash === '#agent-tools' || hash === '#developers'
        ? '/#agent-tools'
        : hash === '#questions'
          ? '/#questions'
          : '/#possibilities';
  const navigation = publicNavigation.map((item) => ({ ...item, active: item.to === active }));
  return (
    <div className="home-page">
      <Button
        variant="outline"
        className="home-skip"
        onClick={() => {
          document.getElementById('home-main')?.focus();
        }}
      >
        跳到主要内容
      </Button>
      <header className="home-header">
        <div className="home-header-inner">
          <BrandLink className="home-brand" />
          <nav aria-label="首页导航" className="home-desktop-nav">
            {navigation.map((item) => (
              <Button key={item.to} asChild variant="ghost" size="sm">
                <Link to={item.to} aria-current={item.active ? 'page' : undefined}>
                  {item.label}
                </Link>
              </Button>
            ))}
          </nav>
          <div className="home-header-actions">
            <ThemePicker />
            <Button asChild variant="ghost" size="sm" className="home-login">
              <Link to={isAuthenticated ? '/keys' : '/login?returnTo=%2Fchat'}>
                {isAuthenticated ? '控制台' : '登录'}
                <ArrowUpRight size={15} aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/chat">
                开始对话
                <ArrowUpRight size={15} aria-hidden="true" />
              </Link>
            </Button>
            <div className="home-menu-toggle">
              <DropdownMenu
                trigger={
                  <Button variant="ghost" size="icon" aria-label="打开导航">
                    <Menu size={20} aria-hidden="true" />
                  </Button>
                }
                label="首页导航"
                items={navigation.map((item) => ({ label: item.label, to: item.to }))}
              />
            </div>
          </div>
        </div>
      </header>

      <main id="home-main" tabIndex={-1}>
        <Outlet />
      </main>
      <footer className="home-footer">
        <BrandLink className="home-brand" />
        <p>对话 · API · 用量与费用</p>
        <nav aria-label="页脚导航">
          <Button asChild variant="ghost" size="sm">
            <Link to="/chat">对话</Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link to="/keys">API 接入</Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link to="/#agent-tools">Agent 接入指南</Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link to="/#questions">常见问题</Link>
          </Button>
        </nav>
        <span>© {new Date().getFullYear()} CheapAI</span>
      </footer>
    </div>
  );
}
