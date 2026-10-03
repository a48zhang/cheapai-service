import type { ReactNode } from 'react';
import { Sheet } from '../ui/Sheet';

export interface DetailPanelProps {
  open?: boolean;
  onClose?: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  fullPage?: boolean;
}

export function DetailPanel({ open = true, onClose, title, description, children, fullPage }: DetailPanelProps) {
  if (fullPage) return <section className="mx-auto max-w-5xl space-y-6">
    <header><h1 className="text-2xl font-semibold">{title}</h1>{description && <p className="mt-2 text-[var(--muted)]">{description}</p>}</header>
    {children}
  </section>;
  return <Sheet open={open} onOpenChange={value => { if (!value) onClose?.(); }} title={title} description={description}>
    {children}
  </Sheet>;
}
