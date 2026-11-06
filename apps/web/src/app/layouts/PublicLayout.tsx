import { RouteButton } from '../../shared/ui/RouteButton';
import { Suspense, useEffect } from 'react';
import { AsyncState } from '../../shared/patterns/AsyncState';
import { SkipToContent } from '../../shared/ui/SkipToContent';
import { ThemePicker } from '@cheapai/theme';
import { Outlet, useLocation } from 'react-router-dom';
import { ArrowUpRight, Menu } from 'lucide-react';
import { BrandLink } from '../../shared/ui/BrandLink';
import { Button } from '../../shared/ui/Button';
import { DropdownMenu } from '../../shared/ui/DropdownMenu';
import { useSession } from '../../features/session/useSession';
import { publicNavigation } from '../../shared/navigation';
import '../../shared/styles/public-site.css';

export function PublicLayout() {
  const { isAuthenticated } = useSession();
  const { pathname, search, hash } = useLocation();
  useEffect(() => {
    if (!hash) window.scrollTo(0, 0);
  }, [pathname, hash]);
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
      <SkipToContent target="home-main" className="home-skip" />
      <header className="home-header">
        <div className="home-header-inner">
          <BrandLink className="home-brand" />
          <nav aria-label="首页导航" className="home-desktop-nav">
            {navigation.map((item) => (
              <RouteButton
                key={item.to}
                variant="ghost"
                size="sm"
                to={item.to}
                aria-current={item.active ? 'page' : undefined}
              >
                {item.label}
              </RouteButton>
            ))}
          </nav>
          <div className="home-header-actions">
            <ThemePicker />
            <RouteButton
              variant="ghost"
              size="sm"
              className="home-login"
              to={
                isAuthenticated
                  ? '/keys'
                  : `/login?returnTo=${encodeURIComponent(pathname + search + hash)}`
              }
            >
              {isAuthenticated ? 'API 接入' : '登录'}
              <ArrowUpRight size={15} aria-hidden="true" />
            </RouteButton>
            <RouteButton variant="outline" to="/chat">
              开始对话
              <ArrowUpRight size={15} aria-hidden="true" />
            </RouteButton>
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
        <Suspense
          fallback={<AsyncState status="loading" loadingLabel="正在加载页面…" className="p-8" />}
        >
          <Outlet />
        </Suspense>
      </main>
      <footer className="home-footer">
        <BrandLink className="home-brand" />
        <p>对话 · API · 用量与费用</p>
        <nav aria-label="页脚导航">
          <RouteButton variant="ghost" size="sm" to="/chat">
            对话
          </RouteButton>
          <RouteButton variant="ghost" size="sm" to="/keys">
            API 接入
          </RouteButton>
          <RouteButton variant="ghost" size="sm" to="/#agent-tools">
            Agent 接入指南
          </RouteButton>
          <RouteButton variant="ghost" size="sm" to="/#questions">
            常见问题
          </RouteButton>
        </nav>
        <span>© {new Date().getFullYear()} CheapAI</span>
      </footer>
    </div>
  );
}
