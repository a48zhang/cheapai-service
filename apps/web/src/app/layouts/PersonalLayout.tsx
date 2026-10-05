import { Outlet } from 'react-router-dom';
import { AccountMenu } from '../../features/session/public';
import { BrandLink } from '../../shared/ui/BrandLink';

export function PersonalLayout() {
  return (
    <div className="flex min-h-dvh flex-col bg-[var(--color-canvas)]">
      <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 md:px-6">
        <BrandLink className="text-lg font-semibold tracking-tight" />
        <AccountMenu />
      </header>
      <main id="main-content" className="mx-auto w-full max-w-[1440px] flex-1 p-4 sm:p-6 lg:p-8">
        <Outlet />
      </main>
    </div>
  );
}
