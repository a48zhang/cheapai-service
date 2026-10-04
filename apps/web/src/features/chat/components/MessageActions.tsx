import { useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Copy, RotateCcw } from 'lucide-react';
import type { ChatMessage } from '@cheapai/api-client/chat';
import { Button } from '../../../shared/ui/Button';

export interface MessageActionsProps {
  readonly message: ChatMessage;
  readonly variants?: readonly ChatMessage[] | undefined;
  readonly actionsBusy?: boolean | undefined;
  readonly canSelectVersion?: boolean | undefined;
  readonly canRegenerate?: boolean | undefined;
  readonly onSelectVersion?: ((messageId: string) => void) | undefined;
  readonly onRegenerate?: ((message: ChatMessage) => void) | undefined;
}

export function MessageActions({
  message,
  variants = [],
  actionsBusy = false,
  canSelectVersion = false,
  canRegenerate = false,
  onSelectVersion,
  onRegenerate,
}: MessageActionsProps) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const orderedVariants = [...variants].sort((left, right) => left.variant - right.variant);
  const currentIndex = orderedVariants.findIndex((item) => item.id === message.id);
  const hasVariants = message.role === 'assistant' && orderedVariants.length > 1;
  const showRegenerate = message.role === 'assistant' && canRegenerate;

  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard is unavailable');
      await navigator.clipboard.writeText(message.content);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  return (
    <div
      className={`chat-message-actions mt-2 flex min-h-8 flex-wrap items-center gap-1.5 text-xs text-[var(--color-muted-foreground)] ${message.role === 'user' ? 'justify-end' : ''}`}
    >
      <Button
        aria-label={copyState === 'copied' ? '已复制消息' : '复制消息'}
        title={copyState === 'copied' ? '已复制' : '复制消息'}
        disabled={message.content.length === 0}
        onClick={() => void copy()}
        size="icon"
        variant="ghost"
      >
        {copyState === 'copied' ? (
          <Check aria-hidden="true" size={14} />
        ) : (
          <Copy aria-hidden="true" size={14} />
        )}
      </Button>
      {hasVariants ? (
        <div className="flex items-center gap-1" aria-label="回答版本" role="group">
          <Button
            aria-label="上一个回答版本"
            disabled={actionsBusy || !canSelectVersion || currentIndex <= 0}
            onClick={() => {
              const previous = orderedVariants[currentIndex - 1];
              if (previous) onSelectVersion?.(previous.id);
            }}
            size="icon"
            variant="ghost"
          >
            <ChevronLeft aria-hidden="true" size={15} />
          </Button>
          <span aria-live="polite" className="min-w-10 text-center tabular-nums">
            {currentIndex < 0 ? '—' : currentIndex + 1} / {orderedVariants.length}
          </span>
          <Button
            aria-label="下一个回答版本"
            disabled={
              actionsBusy ||
              !canSelectVersion ||
              currentIndex < 0 ||
              currentIndex >= orderedVariants.length - 1
            }
            onClick={() => {
              const next = orderedVariants[currentIndex + 1];
              if (next) onSelectVersion?.(next.id);
            }}
            size="icon"
            variant="ghost"
          >
            <ChevronRight aria-hidden="true" size={15} />
          </Button>
        </div>
      ) : null}
      {showRegenerate ? (
        <Button
          aria-label="重新回答"
          title="重新回答"
          disabled={actionsBusy || !canRegenerate}
          onClick={() => onRegenerate?.(message)}
          size="icon"
          variant="ghost"
        >
          <RotateCcw aria-hidden="true" size={14} />
        </Button>
      ) : null}
      {copyState === 'failed' ? <span role="status">复制失败</span> : null}
    </div>
  );
}
