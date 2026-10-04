import type { HTMLAttributes, ReactNode } from 'react';

export interface PageHeaderProps extends HTMLAttributes<HTMLElement> {
  readonly eyebrow?: ReactNode;
  readonly heading: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
}

/** Page-level title block with optional context and actions. */
export function PageHeader({
  eyebrow,
  heading,
  description,
  actions,
  className,
  ...headerProps
}: PageHeaderProps) {
  return (
    <header
      {...headerProps}
      className={['mb-6 flex flex-wrap items-start justify-between gap-4', className]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="min-w-0">
        {eyebrow && (
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
            {eyebrow}
          </p>
        )}
        <h1 className="m-0 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
          {heading}
        </h1>
        {description && (
          <div className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">{description}</div>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
