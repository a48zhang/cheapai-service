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
      <div className="min-w-0 flex-1 basis-64">
        {eyebrow && (
          <p className="mb-2 text-sm font-medium text-[var(--color-ink-muted)]">{eyebrow}</p>
        )}
        <h1 className="m-0 break-words text-2xl font-semibold leading-9 text-[var(--color-ink)] sm:text-[28px]">
          {heading}
        </h1>
        {description && (
          <div className="mt-2 max-w-3xl break-words text-[15px] leading-7 text-[var(--color-ink-secondary)]">
            {description}
          </div>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
