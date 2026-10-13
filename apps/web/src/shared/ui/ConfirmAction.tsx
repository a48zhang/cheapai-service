import { useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { ApiErrorNotice } from '../patterns/ApiErrorNotice';

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
  onConfirm: () => void | Promise<void>;
  className?: string;
}

/** Keep the operation visible until it succeeds, with failures available for retry. */
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const pending = busy || submitting;
  const isControlled = open !== undefined;
  const currentOpen = isControlled ? open : internalOpen;
  const updateOpen = (nextOpen: boolean) => {
    if (!isControlled) setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };

  const handleConfirm = async () => {
    if (pending) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
      updateOpen(false);
    } catch (failure) {
      setError(failure);
    } finally {
      setSubmitting(false);
    }
  };
  const handleOpenChange = (nextOpen: boolean) => {
    if (pending && !nextOpen) return;
    setError(null);
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
      closeButton={!pending}
      footer={
        <>
          <Button variant="outline" onClick={() => updateOpen(false)} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button variant={variant} onClick={() => void handleConfirm()} busy={pending}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {error != null ? <ApiErrorNotice error={error} /> : null}
    </Dialog>
  );
}
