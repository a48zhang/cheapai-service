import { useState } from 'react';
import type { ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';

export interface CodeBlockProps {
  readonly children: ReactNode;
  readonly className?: string | undefined;
  readonly inline?: boolean | undefined;
}

function codeText(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(codeText).join('');
  return '';
}

/** Renders inline code or a fenced block whose copy action preserves the source text. */
export function CodeBlock({ children, className, inline }: CodeBlockProps) {
  const text = codeText(children);
  const block = inline ?? Boolean(className?.startsWith('language-') || text.includes('\n'));
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  if (!block) {
    return <code className="rounded bg-[var(--color-muted)] px-1 py-0.5 font-mono text-[0.92em]">{children}</code>;
  }

  const language = className?.match(/language-([\w-]+)/u)?.[1];
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard is unavailable');
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  return (
    <div className="my-4 overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-subtle)]">
      <div className="flex min-h-9 items-center justify-between gap-3 border-b border-[var(--color-line)] px-3">
        <span className="truncate text-[11px] text-[var(--color-muted-foreground)]">{language ?? '代码'}</span>
        <button
          type="button"
          aria-label={copyState === 'copied' ? '已复制代码' : '复制代码'}
          className="inline-flex min-h-8 items-center gap-1.5 rounded px-2 text-xs text-[var(--color-muted-foreground)] outline-none hover:bg-[var(--color-muted)] focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
          onClick={() => void copy()}
        >
          {copyState === 'copied' ? <Check aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}
          {copyState === 'copied' ? '已复制' : copyState === 'failed' ? '无法复制' : '复制'}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 text-xs leading-6 text-[var(--color-foreground)]">
        <code className="font-mono">{children}</code>
      </pre>
    </div>
  );
}
