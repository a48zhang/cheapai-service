import { ThemePicker } from '@cheapai/theme';
import type { ReactNode } from 'react';
import { BrandLink } from '../ui/BrandLink';

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
    <header className="app-topbar sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 sm:px-4 md:gap-6">
      <div className="flex shrink-0 items-center gap-2 md:w-[220px] md:gap-3">
        {sidebarToggle}
        <BrandLink className="text-lg font-semibold tracking-tight sm:text-xl" />
      </div>
      <div className="hidden min-w-0 flex-1 items-center gap-3 md:flex">{context}</div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <ThemePicker />
        {account}
      </div>
    </header>
  );
}
