import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import type { ReactElement, ReactNode } from 'react'

export interface DropdownMenuAction {
  label: ReactNode
  onSelect: () => void
  disabled?: boolean
  destructive?: boolean
  shortcut?: ReactNode
}

export interface DropdownMenuSeparator {
  type: 'separator'
}

export type DropdownMenuItem = DropdownMenuAction | DropdownMenuSeparator

export interface DropdownMenuProps {
  /** A focusable button or other element used to open the menu. */
  trigger: ReactElement
  items: readonly DropdownMenuItem[]
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'right' | 'bottom' | 'left'
  className?: string
}

function isSeparator(item: DropdownMenuItem): item is DropdownMenuSeparator {
  return 'type' in item && item.type === 'separator'
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
          className={`z-[60] min-w-48 overflow-hidden rounded-lg border p-1 shadow-[var(--shadow-md)] outline-none ${className ?? ''}`}
          style={{ backgroundColor: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
        >
          {items.map((item, index) => {
            if (isSeparator(item)) {
              return (
                <DropdownMenuPrimitive.Separator
                  key={`separator-${index}`}
                  className="my-1 h-px"
                  style={{ backgroundColor: 'var(--color-border)' }}
                />
              )
            }

            return (
              <DropdownMenuPrimitive.Item
                key={`action-${index}`}
                onSelect={item.onSelect}
                disabled={item.disabled ?? false}
                className={`flex min-h-9 cursor-default select-none items-center justify-between gap-5 rounded px-3 py-2 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-[var(--color-muted)] ${item.destructive ? 'text-[var(--color-destructive)] data-[highlighted]:bg-[var(--color-destructive-soft)]' : 'text-[var(--color-foreground)]'}`}
              >
                <span>{item.label}</span>
                {item.shortcut && (
                  <span aria-hidden="true" className="text-xs text-[var(--color-muted-foreground)]">
                    {item.shortcut}
                  </span>
                )}
              </DropdownMenuPrimitive.Item>
            )
          })}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  )
}
