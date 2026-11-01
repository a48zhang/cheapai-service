import { RouteButton } from './RouteButton';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import type { ReactElement, ReactNode } from 'react';

export interface DropdownMenuAction {
  label: ReactNode;
  onSelect?: () => void;
  to?: string;
  disabled?: boolean;
  destructive?: boolean;
  shortcut?: ReactNode;
}

export interface DropdownMenuSeparator {
  type: 'separator';
}

export type DropdownMenuItem = DropdownMenuAction | DropdownMenuSeparator;

export interface DropdownMenuProps {
  /** A focusable button or other element used to open the menu. */
  trigger: ReactElement;
  items: readonly DropdownMenuItem[];
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  className?: string;
  label?: ReactNode;
}

function isSeparator(item: DropdownMenuItem): item is DropdownMenuSeparator {
  return 'type' in item && item.type === 'separator';
}

/** Compact action menu with Radix roving focus, Escape handling, and focus return. */
export function DropdownMenu({
  trigger,
  items,
  open,
  defaultOpen,
  onOpenChange,
  align = 'end',
  side = 'bottom',
  className,
  label,
}: DropdownMenuProps) {
  return (
    <DropdownMenuPrimitive.Root
      {...(open === undefined ? {} : { open })}
      {...(defaultOpen === undefined ? {} : { defaultOpen })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
    >
      <DropdownMenuPrimitive.Trigger asChild>{trigger}</DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align={align}
          side={side}
          sideOffset={6}
          className={`z-[60] min-w-48 overflow-hidden rounded-md border p-1 shadow-[var(--shadow-md)] outline-none ${className ?? ''}`}
          style={{ backgroundColor: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
        >
          {label && (
            <DropdownMenuPrimitive.Label className="max-w-72 break-all border-b border-[var(--color-border)] px-2 py-2 text-sm text-[var(--color-muted-foreground)]">
              {label}
            </DropdownMenuPrimitive.Label>
          )}
          {items.map((item, index) => {
            if (isSeparator(item)) {
              return (
                <DropdownMenuPrimitive.Separator
                  key={`separator-${index}`}
                  className="my-1 h-px"
                  style={{ backgroundColor: 'var(--color-border)' }}
                />
              );
            }

            return (
              <DropdownMenuPrimitive.Item
                key={`action-${index}`}
                asChild={!!item.to}
                {...(item.onSelect ? { onSelect: item.onSelect } : {})}
                disabled={item.disabled ?? false}
                className={`flex min-h-8 cursor-pointer select-none items-center justify-between gap-5 rounded px-2 py-1.5 text-sm leading-6 outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-[var(--color-muted)] ${item.destructive ? 'text-[var(--color-destructive)] data-[highlighted]:bg-[var(--color-destructive-soft)]' : 'text-[var(--color-foreground)]'}`}
              >
                {item.to ? (
                  <RouteButton
                    to={item.to}
                    variant="ghost"
                    className="w-full justify-start font-normal"
                  >
                    {item.label}
                  </RouteButton>
                ) : (
                  <>
                    <span>{item.label}</span>
                    {item.shortcut && (
                      <span
                        aria-hidden="true"
                        className="text-[13px] text-[var(--color-muted-foreground)]"
                      >
                        {item.shortcut}
                      </span>
                    )}
                  </>
                )}
              </DropdownMenuPrimitive.Item>
            );
          })}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
