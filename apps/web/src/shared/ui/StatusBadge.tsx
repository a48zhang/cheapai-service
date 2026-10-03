import type { HTMLAttributes, ReactNode } from 'react';

export type StatusBadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface StatusBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  readonly tone?: StatusBadgeTone;
  readonly children: ReactNode;
}

const toneClassName: Record<StatusBadgeTone, string> = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-200',
  info: 'bg-blue-50 text-blue-800 ring-blue-200',
  success: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  warning: 'bg-amber-50 text-amber-900 ring-amber-200',
  danger: 'bg-rose-50 text-rose-800 ring-rose-200',
};

/** A compact, text-bearing status marker; color supplements its label. */
export function StatusBadge({ tone = 'neutral', className, children, ...spanProps }: StatusBadgeProps) {
  return (
    <span
      {...spanProps}
      className={['inline-flex max-w-full items-center rounded-full px-2.5 py-1 text-xs font-medium leading-4 ring-1 ring-inset', toneClassName[tone], className].filter(Boolean).join(' ')}
      data-tone={tone}
    >
      {children}
    </span>
  );
}
