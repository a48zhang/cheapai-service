import { useId } from 'react';
import { Button } from '../../shared/ui/Button';
import { Dialog } from '../../shared/ui/Dialog';

export interface KeySecretDialogProps {
  readonly secret: string | null;
  readonly keyName: string;
  readonly onClose: () => void;
}

/** Receives a created token only for this mounted dialog's short lifetime. */
export function KeySecretDialog({ secret, onClose }: KeySecretDialogProps) {
  const inputId = useId();
  const open = secret !== null;

  const copy = async () => {
    if (secret === null) return;
    try {
      await navigator.clipboard.writeText(secret);
    } catch {
      // Keep the one-time secret visible so the user can copy it manually.
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      title="Key 已创建"
      description="完整 Key 仅显示一次，请复制保存。"
      closeLabel="关闭密钥对话框"
      className="max-w-2xl"
      footer={
        <>
          <Button variant="secondary" onClick={() => void copy()}>
            复制
          </Button>
          <Button onClick={onClose}>完成</Button>
        </>
      }
    >
      {secret !== null && (
        <div className="space-y-3">
          <label htmlFor={inputId} className="block text-sm font-medium">
            API Key
          </label>
          <textarea
            id={inputId}
            aria-label="完整 API Key"
            value={secret}
            readOnly
            autoComplete="off"
            spellCheck={false}
            rows={3}
            className="block w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-muted)] p-3 font-mono text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
          />
        </div>
      )}
    </Dialog>
  );
}
