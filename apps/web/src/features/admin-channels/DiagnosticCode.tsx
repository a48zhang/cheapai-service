import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '../../shared/ui/Button';

export interface DiagnosticCodeProps {
  readonly label: string;
  readonly value: string | null;
  readonly emptyMessage?: string | undefined;
  readonly className?: string | undefined;
}

/** Shows diagnostic text as plain text and lets administrators copy the same value. */
export function DiagnosticCode({
  label,
  value,
  emptyMessage = '暂无内容',
  className,
}: DiagnosticCodeProps) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    setCopyState('idle');
  }, [value]);

  const copy = async () => {
    try {
      if (value === null || !navigator.clipboard?.writeText) {
        throw new Error('Clipboard is unavailable');
      }
      await navigator.clipboard.writeText(value);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  return (
    <section
      aria-label={label}
      className={`min-w-0 overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-subtle)] ${className ?? ''}`}
    >
      <div className="flex min-h-10 min-w-0 items-center justify-between gap-3 border-b border-[var(--color-line)] px-3">
        <h3 className="truncate text-xs font-medium text-[var(--color-ink-secondary)]">{label}</h3>
        <div className="flex shrink-0 items-center gap-2">
          {copyState !== 'idle' && (
            <span
              aria-live="polite"
              className="text-xs text-[var(--color-ink-muted)]"
              role="status"
            >
              {copyState === 'copied' ? '已复制' : '复制失败'}
            </span>
          )}
          <Button
            aria-label={copyState === 'copied' ? `已复制${label}` : `复制${label}`}
            disabled={value === null || value.length === 0}
            onClick={() => void copy()}
            size="sm"
            variant="ghost"
          >
            {copyState === 'copied' ? (
              <Check aria-hidden="true" size={14} />
            ) : (
              <Copy aria-hidden="true" size={14} />
            )}
            复制
          </Button>
        </div>
      </div>
      {value === null || value.length === 0 ? (
        <p className="px-3 py-5 text-xs text-[var(--color-ink-muted)]">{emptyMessage}</p>
      ) : (
        <pre
          aria-label={`${label}文本`}
          className="m-0 max-h-96 max-w-full overflow-auto p-3 font-mono text-xs leading-5 text-[var(--color-ink)]"
          tabIndex={0}
        >
          <code className="whitespace-pre">{value}</code>
        </pre>
      )}
    </section>
  );
}
