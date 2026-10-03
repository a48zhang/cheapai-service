import type { ReactNode } from 'react';
import { Button } from '../ui/Button';

export function FilterBar({ children, onReset }: { children: ReactNode; onReset?: () => void }) {
  return <div role="group" aria-label="筛选条件" className="flex flex-wrap items-end gap-3 py-4">
    {children}
    {onReset && <Button variant="ghost" onClick={onReset}>重置筛选</Button>}
  </div>;
}
