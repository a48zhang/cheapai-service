import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from './Button';

export interface DisclosureProps {
  title: ReactNode;
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  expandWhen?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  triggerClassName?: string;
}

/** Shared disclosure with a styled trigger; contents stay mounted to preserve form values. */
export function Disclosure({
  title,
  children,
  open,
  defaultOpen = false,
  expandWhen = false,
  onOpenChange,
  className,
  triggerClassName,
}: DisclosureProps) {
  const [expanded, setExpanded] = useState(defaultOpen || expandWhen);
  const contentId = useId();
  const isOpen = open ?? expanded;
  useEffect(() => {
    if (expandWhen) setExpanded(true);
  }, [expandWhen]);
  return (
    <div className={className}>
      <Button
        variant="ghost"
        className={`h-auto min-h-9 w-full justify-between whitespace-normal px-0 text-left hover:bg-transparent ${triggerClassName ?? ''}`}
        aria-expanded={isOpen}
        aria-controls={contentId}
        onClick={() => {
          setExpanded(!isOpen);
          onOpenChange?.(!isOpen);
        }}
      >
        <span>{title}</span>
        <ChevronDown
          size={16}
          aria-hidden="true"
          className={`shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
      </Button>
      <div id={contentId} hidden={!isOpen}>
        {children}
      </div>
    </div>
  );
}
