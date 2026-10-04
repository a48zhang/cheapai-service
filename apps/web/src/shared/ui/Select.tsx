import * as SelectPrimitive from '@radix-ui/react-select';
import type { ReactNode } from 'react';

export interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface SelectProps {
  items: readonly SelectOption[];
  value?: string | undefined;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  placeholder?: string;
  emptyMessage?: ReactNode;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  id?: string;
  className?: string;
  contentClassName?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
}

/** Single-choice select with a native combobox trigger and Radix keyboard semantics. */
export function Select({
  items,
  value,
  defaultValue,
  onValueChange,
  open,
  defaultOpen,
  onOpenChange,
  placeholder = '请选择',
  emptyMessage = '暂无可选项',
  disabled = false,
  required,
  name,
  id,
  className,
  contentClassName,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
}: SelectProps) {
  return (
    <SelectPrimitive.Root
      {...(value === undefined ? {} : { value })}
      {...(defaultValue === undefined ? {} : { defaultValue })}
      {...(onValueChange === undefined ? {} : { onValueChange })}
      {...(open === undefined ? {} : { open })}
      {...(defaultOpen === undefined ? {} : { defaultOpen })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
      disabled={disabled}
      {...(required === undefined ? {} : { required })}
      {...(name === undefined ? {} : { name })}
    >
      <SelectPrimitive.Trigger
        id={id}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid}
        className={`flex min-h-10 w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm outline-none transition-colors focus-visible:border-[var(--color-ring)] focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-surface)] disabled:cursor-not-allowed disabled:opacity-60 ${className ?? ''}`}
        style={{
          borderColor:
            ariaInvalid === true || ariaInvalid === 'true'
              ? 'var(--color-destructive)'
              : 'var(--color-border)',
          backgroundColor: disabled ? 'var(--color-muted)' : 'var(--color-surface)',
          color: 'var(--color-foreground)',
        }}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon
          aria-hidden="true"
          className="shrink-0 text-[var(--color-muted-foreground)]"
        >
          <svg viewBox="0 0 20 20" width="16" height="16" fill="none">
            <path
              d="m5.5 7.5 4.5 4.5 4.5-4.5"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className={`z-[60] max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border shadow-[var(--shadow-md)] outline-none ${contentClassName ?? ''}`}
          style={{ backgroundColor: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
        >
          <SelectPrimitive.Viewport className="max-h-72 overflow-y-auto p-1">
            {items.length > 0 ? (
              items.map((item) => (
                <SelectPrimitive.Item
                  key={item.value}
                  value={item.value}
                  disabled={item.disabled ?? false}
                  className="relative flex min-h-9 cursor-default select-none items-center rounded px-3 py-1.5 pr-9 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-[var(--color-accent-soft)] data-[highlighted]:text-[var(--color-foreground)]"
                >
                  <SelectPrimitive.ItemText>{item.label}</SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator className="absolute right-3 inline-flex items-center text-[var(--color-primary)]">
                    <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none">
                      <path
                        d="m3 8 3.2 3.2L13 4.5"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))
            ) : (
              <div role="status" className="px-3 py-2 text-sm text-[var(--color-muted-foreground)]">
                {emptyMessage}
              </div>
            )}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
