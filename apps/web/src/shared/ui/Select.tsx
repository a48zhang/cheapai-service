import * as SelectPrimitive from '@radix-ui/react-select';
import { useId, useState } from 'react';
import type { ReactNode, Ref } from 'react';

export interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface SelectProps {
  ref?: Ref<HTMLButtonElement>;
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
  name?: string | undefined;
  id?: string;
  className?: string;
  contentClassName?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  onBlur?: () => void;
}

/** Styled single-choice control with Radix keyboard semantics and form values. */
export function Select({
  ref,
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
  onBlur,
}: SelectProps) {
  const emptyOption = useId();
  const [internalValue, setInternalValue] = useState(defaultValue ?? '');
  const selectedValue = value ?? internalValue;
  const hasEmptyOption = items.some((item) => item.value === '');
  return (
    <>
      {hasEmptyOption && name && (
        <input type="hidden" name={name} value={selectedValue} disabled={disabled} />
      )}
      <SelectPrimitive.Root
        value={hasEmptyOption && selectedValue === '' ? emptyOption : selectedValue}
        onValueChange={(next) => {
          const nextValue = next === emptyOption ? '' : next;
          if (value === undefined) setInternalValue(nextValue);
          onValueChange?.(nextValue);
        }}
        {...(open === undefined ? {} : { open })}
        {...(defaultOpen === undefined ? {} : { defaultOpen })}
        {...(onOpenChange === undefined ? {} : { onOpenChange })}
        disabled={disabled}
        {...(required === undefined ? {} : { required })}
        {...(name === undefined || hasEmptyOption ? {} : { name })}
      >
        <SelectPrimitive.Trigger
          ref={ref}
          id={id}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-describedby={ariaDescribedBy}
          aria-invalid={ariaInvalid}
          onBlur={onBlur}
          className={`flex min-h-9 min-w-0 w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm leading-6 outline-none transition-colors focus-visible:border-[var(--color-ring)] focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-surface)] disabled:cursor-not-allowed disabled:opacity-60 ${className ?? ''}`}
          style={{
            borderColor:
              ariaInvalid === true || ariaInvalid === 'true'
                ? 'var(--color-destructive)'
                : 'var(--color-border)',
            backgroundColor: disabled ? 'var(--color-muted)' : 'var(--color-surface)',
            color: 'var(--color-foreground)',
          }}
        >
          <span className="min-w-0 flex-1 truncate">
            <SelectPrimitive.Value placeholder={placeholder} />
          </span>
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
            className={`z-[60] max-h-72 min-w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border shadow-[var(--shadow-md)] outline-none ${contentClassName ?? ''}`}
            style={{ backgroundColor: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
          >
            <SelectPrimitive.Viewport className="max-h-72 overflow-y-auto p-1">
              {items.length > 0 ? (
                items.map((item) => (
                  <SelectPrimitive.Item
                    key={item.value}
                    value={item.value === '' ? emptyOption : item.value}
                    disabled={item.disabled ?? false}
                    className="relative flex min-h-10 cursor-default select-none items-center rounded px-3 py-1.5 pr-9 text-sm leading-6 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-[var(--color-accent-soft)] data-[highlighted]:text-[var(--color-foreground)]"
                  >
                    <SelectPrimitive.ItemText className="min-w-0 break-words">
                      {item.label}
                    </SelectPrimitive.ItemText>
                    <SelectPrimitive.ItemIndicator className="absolute right-3 inline-flex items-center text-[var(--color-primary)]">
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 16 16"
                        width="14"
                        height="14"
                        fill="none"
                      >
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
                <div
                  role="status"
                  className="px-3 py-2 text-sm text-[var(--color-muted-foreground)]"
                >
                  {emptyMessage}
                </div>
              )}
            </SelectPrimitive.Viewport>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    </>
  );
}
