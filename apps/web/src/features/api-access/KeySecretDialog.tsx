import { useEffect, useId, useState } from 'react';
import { Button } from '../../shared/ui/Button';
import { Dialog } from '../../shared/ui/Dialog';

export interface KeySecretDialogProps {
  readonly secret: string | null;
  readonly keyName: string;
  readonly onClose: () => void;
}

/** Receives a created token only for this mounted dialog's short lifetime. */
export function KeySecretDialog({ secret, keyName, onClose }: KeySecretDialogProps) {
  const inputId = useId();
  const [copyMessage, setCopyMessage] = useState('');
  const open = secret !== null;

  useEffect(() => {
    setCopyMessage('');
  }, [secret]);

  const copy = async () => {
    if (secret === null) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopyMessage('密钥已复制到剪贴板。');
    } catch {
      setCopyMessage('无法自动复制，请选中密钥并手动复制。');
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      title="Key 已创建"
      description={`“${keyName}”的完整密钥只显示这一次。关闭后无法再次取回。`}
      closeLabel="关闭密钥对话框"
      className="max-w-2xl"
      footer={
        <>
          <Button variant="secondary" onClick={() => void copy()}>
            复制密钥
          </Button>
          <Button onClick={onClose}>已保存，关闭密钥</Button>
        </>
      }
    >
      {secret !== null && (
        <div className="space-y-3">
          <label htmlFor={inputId} className="block text-sm font-medium">
            完整密钥（仅显示一次）
          </label>
          <textarea
            id={inputId}
            aria-label="完整密钥（仅显示一次）"
            value={secret}
            readOnly
            autoComplete="off"
            spellCheck={false}
            rows={3}
            className="block w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-muted)] p-3 font-mono text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
          />
          <p
            role="status"
            aria-live="polite"
            className="min-h-5 text-sm text-[var(--color-muted-foreground)]"
          >
            {copyMessage}
          </p>
        </div>
      )}
    </Dialog>
  );
}
