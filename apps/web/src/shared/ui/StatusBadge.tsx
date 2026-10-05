import type { HTMLAttributes, ReactNode } from 'react';

export type StatusBadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface StatusBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  readonly tone?: StatusBadgeTone;
  readonly children: ReactNode;
}

const toneClassName: Record<StatusBadgeTone, string> = {
  neutral:
    'bg-[var(--color-surface-subtle)] text-[var(--color-ink-secondary)] ring-[var(--color-line)]',
  info: 'bg-[var(--color-info-soft)] text-[var(--color-info)] ring-[var(--color-info-line)]',
  success:
    'bg-[var(--color-success-soft)] text-[var(--color-success)] ring-[var(--color-success-line)]',
  warning:
    'bg-[var(--color-warning-soft)] text-[var(--color-warning)] ring-[var(--color-warning-line)]',
  danger:
    'bg-[var(--color-danger-soft)] text-[var(--color-danger)] ring-[var(--color-danger-line)]',
};

/** A compact, text-bearing status marker; color supplements its label. */
export function StatusBadge({
  tone = 'neutral',
  className,
  children,
  ...spanProps
}: StatusBadgeProps) {
  return (
    <span
      {...spanProps}
      className={[
        'inline-flex max-w-full items-center rounded-full px-2.5 py-1 text-xs font-medium leading-4 ring-1 ring-inset',
        toneClassName[tone],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      data-tone={tone}
    >
      {children}
    </span>
  );
}
