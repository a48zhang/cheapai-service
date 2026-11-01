import { RouteButton } from './RouteButton';
import type { LinkProps } from 'react-router-dom';
import { brand } from '../brand';

export interface BrandLinkProps {
  to?: LinkProps['to'];
  className?: string;
  compact?: boolean;
}

export function BrandLink({ to = '/', className, compact = false }: BrandLinkProps) {
  return (
    <RouteButton
      to={to}
      variant="ghost"
      aria-label={compact ? brand.wordmark : undefined}
      className={`inline-flex items-center gap-2 px-0 ${className ?? ''}`}
    >
      <span>{brand.wordmark}</span>
    </RouteButton>
  );
}
