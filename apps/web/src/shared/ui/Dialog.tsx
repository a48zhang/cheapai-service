import * as DialogPrimitive from '@radix-ui/react-dialog'
import type { ReactElement, ReactNode } from 'react'

export interface DialogProps {
  open?: boolean | undefined
  defaultOpen?: boolean | undefined
  onOpenChange?: ((open: boolean) => void) | undefined
  /** Optional button or link rendered as the dialog trigger. */
  trigger?: ReactElement | undefined
  title: ReactNode
  description?: ReactNode | undefined
  children?: ReactNode | undefined
  footer?: ReactNode | undefined
  className?: string | undefined
  overlayClassName?: string | undefined
  closeLabel?: string | undefined
  closeButton?: boolean | undefined
}

/** Accessible centered dialog with Radix focus trapping, Escape handling, and focus return. */
export function Dialog({
  open,
  defaultOpen,
  onOpenChange,
  trigger,
  title,
  description,
  children,
  footer,
  className,
  overlayClassName,
  closeLabel = '关闭弹窗',
  closeButton = true,
}: DialogProps) {
  return (
    <DialogPrimitive.Root
      {...(open === undefined ? {} : { open })}
      {...(defaultOpen === undefined ? {} : { defaultOpen })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
    >
      {trigger && (
        <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>
      )}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={`fixed inset-0 z-50 bg-slate-950/45 ${overlayClassName ?? ''}`}
        />
        <DialogPrimitive.Content
          className={`fixed left-1/2 top-1/2 z-50 flex max-h-[min(90dvh,52rem)] w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border p-0 shadow-[var(--shadow-lg)] outline-none ${className ?? ''}`}
          style={{ backgroundColor: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
        >
          <div className="flex items-start justify-between gap-4 border-b px-6 py-5" style={{ borderColor: 'var(--color-border)' }}>
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-lg font-semibold leading-tight text-[var(--color-foreground)]">
                {title}
              </DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="mt-1.5 text-sm text-[var(--color-muted-foreground)]">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            {closeButton && (
              <DialogPrimitive.Close
                type="button"
                aria-label={closeLabel}
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-md text-lg text-[var(--color-muted-foreground)] outline-none transition-colors hover:bg-[var(--color-muted)] hover:text-[var(--color-foreground)] focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
              >
                <span aria-hidden="true">×</span>
              </DialogPrimitive.Close>
            )}
          </div>
          {children != null && <div className="min-h-0 overflow-y-auto px-6 py-5">{children}</div>}
          {footer && (
            <div className="flex flex-wrap justify-end gap-2 border-t px-6 py-4" style={{ borderColor: 'var(--color-border)' }}>
              {footer}
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
