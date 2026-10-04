import { useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';

export interface ConfirmActionProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactElement;
  title: ReactNode;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'primary';
  busy?: boolean;
  onConfirm: () => void;
  className?: string;
}

/** Confirmation dialog whose actual operation and error handling remain with its caller. */
export function ConfirmAction({
  open,
  defaultOpen = false,
  onOpenChange,
  trigger,
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  variant = 'danger',
  busy = false,
  onConfirm,
  className,
}: ConfirmActionProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = open !== undefined;
  const currentOpen = isControlled ? open : internalOpen;
  const updateOpen = (nextOpen: boolean) => {
    if (!isControlled) setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };

  const handleConfirm = () => {
    onConfirm();
    updateOpen(false);
  };
  const handleOpenChange = (nextOpen: boolean) => {
    if (busy && !nextOpen) return;
    updateOpen(nextOpen);
  };

  return (
    <Dialog
      open={currentOpen}
      onOpenChange={handleOpenChange}
      trigger={trigger}
      title={title}
      description={description}
      className={className}
      closeButton={!busy}
      footer={
        <>
          <Button variant="outline" onClick={() => updateOpen(false)} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={variant} onClick={handleConfirm} busy={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
