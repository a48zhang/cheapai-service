import { useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import { useConversationLocation } from './NavigationState';
import { adminEntry, personalNavigation, type NavigationItem } from '../navigation';
import { RouteButton } from '../ui/RouteButton';
import { useProductEnvironment } from '../platform';

export function NavigationButton({
  item,
  onNavigate,
}: {
  item: NavigationItem;
  onNavigate?: (() => void) | undefined;
}) {
  const { pathname } = useLocation();
  const { kind } = useProductEnvironment();
  const [conversation] = useConversationLocation();
  const path = item.path === '/console/models' && kind === 'desktop' ? '/models' : item.path;
  const active = pathname === path || pathname.startsWith(`${path}/`);
  const destination = path === '/chat' && kind === 'web' ? conversation : path;
  const Icon = item.icon;
  return (
    <RouteButton
      to={destination}
      onClick={onNavigate}
      variant="ghost"
      aria-current={active ? 'page' : undefined}
      className={`w-full justify-start gap-3 px-3 text-left ${active ? 'bg-[var(--color-accent-soft)] font-medium text-[var(--color-foreground)]' : 'font-normal text-muted-foreground hover:text-[var(--color-foreground)]'}`}
    >
      <Icon aria-hidden="true" size={16} strokeWidth={1.8} />
      <span>{item.label}</span>
    </RouteButton>
  );
}

export function PersonalNavigation({
  isAdmin = false,
  onNavigate,
}: {
  isAdmin?: boolean;
  onNavigate?: (() => void) | undefined;
}) {
  const { kind } = useProductEnvironment();
  const { pathname, search, hash } = useLocation();
  const [, rememberConversation] = useConversationLocation();
  useEffect(() => {
    if (pathname === '/chat' || pathname.startsWith('/chat/'))
      rememberConversation(pathname + search + hash);
  }, [pathname, search, hash, rememberConversation]);
  return (
    <nav aria-label="个人导航" className="space-y-1">
      {personalNavigation.map((item) => (
        <NavigationButton key={item.path} item={item} onNavigate={onNavigate} />
      ))}
      {isAdmin && kind !== 'desktop' && (
        <div className="mt-3 border-t border-[var(--color-border)] pt-3">
          <NavigationButton item={adminEntry} onNavigate={onNavigate} />
        </div>
      )}
    </nav>
  );
}
