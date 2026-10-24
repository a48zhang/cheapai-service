import type { ReactNode } from 'react';

/** Shared two-column shell; mobile navigation is supplied by each page's Radix Sheet. */
export function AppShell({
  skipLink,
  sidebar,
  header,
  children,
  open,
  className = '',
}: {
  skipLink: ReactNode;
  sidebar: ReactNode;
  header: ReactNode;
  children: ReactNode;
  open: boolean;
  className?: string;
}) {
  return (
    <div className={`app-shell ${open ? 'app-shell--open' : ''} ${className}`}>
      {skipLink}
      {sidebar}
      <div className="app-shell-main">
        {header}
        {children}
      </div>
    </div>
  );
}
