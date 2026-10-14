import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from './Button';

export function CopyButton({
  value,
  label = '复制',
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [result, setResult] = useState<{ value: string; copied: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const current = result?.value === value ? result : null;
  const copy = async () => {
    setBusy(true);
    try {
      await navigator.clipboard.writeText(value);
      setResult({ value, copied: true });
    } catch {
      setResult({ value, copied: false });
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className={`inline-flex flex-wrap items-center gap-2 ${className ?? ''}`}>
      <Button variant="outline" size="sm" busy={busy} onClick={() => void copy()}>
        {current?.copied ? (
          <Check size={16} aria-hidden="true" />
        ) : (
          <Copy size={16} aria-hidden="true" />
        )}
        {current?.copied ? '已复制' : label}
      </Button>
      <span
        role="status"
        className={current?.copied ? 'sr-only' : 'text-sm text-[var(--color-danger)]'}
      >
        {current ? (current.copied ? '已复制到剪贴板' : '复制失败，请选中文本手动复制') : ''}
      </span>
    </span>
  );
}
