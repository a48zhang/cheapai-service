import { Link, Outlet } from 'react-router-dom';
import type { ReactNode } from 'react';

export function AuthLayout({ children }: { children?: ReactNode }) {
  return <div className="flex min-h-dvh flex-col bg-[var(--canvas)]">
    <header className="p-6"><Link to="/" className="inline-flex items-center gap-2 text-xl font-semibold"><span aria-hidden="true" className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--primary)] text-white">c</span>cheapai</Link></header>
    <main className="flex flex-1 items-center justify-center px-5 pb-20">
      <section className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-white p-8 shadow-sm">{children ?? <Outlet />}</section>
    </main>
  </div>;
}
