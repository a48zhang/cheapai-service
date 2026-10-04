import { Outlet } from 'react-router-dom';
import type { ReactNode } from 'react';
import { BrandLink } from '../../shared/ui/BrandLink';

export function AuthLayout({ children }: { children?: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-[var(--color-canvas)]">
      <header className="p-6">
        <BrandLink className="text-xl font-semibold" />
      </header>
      <main className="flex flex-1 items-center justify-center px-5 pb-20">
        <section className="w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-white p-8 shadow-sm">
          {children ?? <Outlet />}
        </section>
      </main>
    </div>
  );
}
