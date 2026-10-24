import { ThemePicker } from '@cheapai/theme';
import type { ReactNode } from 'react';

/** Consistent navigation chrome for the console and conversation workspace. */
export function AppTopbar({
  sidebarToggle,
  context,
  account,
}: {
  sidebarToggle: ReactNode;
  context?: ReactNode;
  account: ReactNode;
}) {
  return (
    <header className="app-topbar sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 sm:px-4 md:gap-6">
      <div className="flex shrink-0 items-center gap-2">{sidebarToggle}</div>
      <div className="flex min-w-0 flex-1 items-center gap-3">{context}</div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <ThemePicker compact />
        {account}
      </div>
    </header>
  );
}
