import { Link } from 'react-router-dom';
import type { LinkProps } from 'react-router-dom';
import { brand } from '../brand';

export interface BrandLinkProps {
  to?: LinkProps['to'];
  className?: string;
  compact?: boolean;
}

export function BrandLink({ to = '/', className, compact = false }: BrandLinkProps) {
  return (
    <Link
      to={to}
      aria-label={compact ? brand.wordmark : undefined}
      className={`inline-flex items-center gap-2 ${className ?? ''}`}
    >
      <span>{brand.wordmark}</span>
    </Link>
  );
}
