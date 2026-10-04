import * as TabsPrimitive from '@radix-ui/react-tabs';
import type { ReactNode } from 'react';

export interface TabItem {
  value: string;
  label: ReactNode;
  content: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  items: readonly TabItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  orientation?: 'horizontal' | 'vertical';
  activationMode?: 'automatic' | 'manual';
  loop?: boolean;
  ariaLabel?: string;
  className?: string;
  listClassName?: string;
  contentClassName?: string;
}

/** Tabs with an explicit item model and Radix roving-focus/keyboard behavior. */
export function Tabs({
  items,
  value,
  defaultValue,
  onValueChange,
  orientation = 'horizontal',
  activationMode = 'automatic',
  loop = true,
  ariaLabel,
  className,
  listClassName,
  contentClassName,
}: TabsProps) {
  return (
    <TabsPrimitive.Root
      {...(value === undefined ? {} : { value })}
      {...(defaultValue === undefined ? {} : { defaultValue })}
      {...(onValueChange === undefined ? {} : { onValueChange })}
      orientation={orientation}
      activationMode={activationMode}
      {...(className === undefined ? {} : { className })}
    >
      <TabsPrimitive.List
        aria-label={ariaLabel}
        loop={loop}
        className={`flex gap-1 border-b ${orientation === 'vertical' ? 'h-full flex-col border-b-0 border-r pr-3' : 'overflow-x-auto'} ${listClassName ?? ''}`}
        style={{ borderColor: 'var(--color-border)' }}
      >
        {items.map((item) => (
          <TabsPrimitive.Trigger
            key={item.value}
            value={item.value}
            disabled={item.disabled ?? false}
            className={`inline-flex min-h-10 shrink-0 items-center justify-center px-3 py-2 text-sm font-medium text-[var(--color-muted-foreground)] outline-none transition-colors hover:text-[var(--color-foreground)] focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] data-[state=active]:text-[var(--color-primary)] disabled:pointer-events-none disabled:opacity-50 ${orientation === 'vertical' ? 'w-full justify-start border-r-2 border-transparent data-[state=active]:border-[var(--color-primary)]' : 'border-b-2 border-transparent data-[state=active]:border-[var(--color-primary)]'}`}
          >
            {item.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {items.map((item) => (
        <TabsPrimitive.Content
          key={item.value}
          value={item.value}
          className={`outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] ${contentClassName ?? ''}`}
        >
          {item.content}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}
