import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { CSSProperties, ReactElement, ReactNode } from 'react';

export type SheetSide = 'right' | 'left' | 'bottom';

export interface SheetProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactElement;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  side?: SheetSide;
  className?: string;
  overlayClassName?: string;
  closeLabel?: string;
  closeButton?: boolean;
}

const sideClasses: Record<SheetSide, string> = {
  right:
    'inset-y-0 right-0 h-full w-[min(34rem,92vw)] border-l max-md:inset-0 max-md:h-[100dvh] max-md:w-full max-md:max-w-none max-md:rounded-none max-md:border-0',
  left: 'inset-y-0 left-0 h-full w-[min(34rem,92vw)] border-r max-md:inset-0 max-md:h-[100dvh] max-md:w-full max-md:max-w-none max-md:rounded-none max-md:border-0',
  bottom:
    'inset-x-0 bottom-0 max-h-[88dvh] w-full border-t max-md:inset-0 max-md:h-[100dvh] max-md:max-h-none max-md:rounded-none max-md:border-0',
};

const sheetMotion: Record<SheetSide, string> = {
  right: 'data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right',
  left: 'data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left',
  bottom: 'data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom',
};

/** Accessible edge panel that becomes a full-screen workspace on narrow screens. */
export function Sheet({
  open,
  defaultOpen,
  onOpenChange,
  trigger,
  title,
  description,
  children,
  footer,
  side = 'right',
  className,
  overlayClassName,
  closeLabel = '关闭侧栏',
  closeButton = true,
}: SheetProps) {
  const contentStyle: CSSProperties = {
    backgroundColor: 'var(--color-surface)',
    borderColor: 'var(--color-border)',
  };

  return (
    <DialogPrimitive.Root
      {...(open === undefined ? {} : { open })}
      {...(defaultOpen === undefined ? {} : { defaultOpen })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
    >
      {trigger && <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={`fixed inset-0 z-50 bg-slate-950/45 ${overlayClassName ?? ''}`}
        />
        <DialogPrimitive.Content
          className={`fixed z-50 flex flex-col overflow-hidden shadow-[var(--shadow-lg)] outline-none ${sheetMotion[side]} ${sideClasses[side]} ${className ?? ''}`}
          style={contentStyle}
        >
          <div
            className="flex items-start justify-between gap-4 border-b px-6 py-5"
            style={{ borderColor: 'var(--color-border)' }}
          >
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
          {children != null && (
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
          )}
          {footer && (
            <div
              className="flex flex-wrap justify-end gap-2 border-t px-6 py-4"
              style={{ borderColor: 'var(--color-border)' }}
            >
              {footer}
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
