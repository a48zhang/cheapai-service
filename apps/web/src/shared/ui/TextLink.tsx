import type { AnchorHTMLAttributes } from 'react';

/** Styled text navigation for external links and downloads; keeps native link semantics. */
export function TextLink({
  className = '',
  rel,
  target,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      {...props}
      target={target}
      rel={rel ?? (target === '_blank' ? 'noopener noreferrer' : undefined)}
      className={`rounded-sm text-[var(--color-primary)] underline-offset-4 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] ${className}`}
    />
  );
}
