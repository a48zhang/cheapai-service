import { useId, useRef } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';

export interface ComposerProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSend: (content: string) => void;
  readonly onStop: () => void;
  readonly busy?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly disabledReason?: string | undefined;
  readonly error?: string | null | undefined;
  readonly modelPicker?: ReactNode | undefined;
  readonly sendLabel?: string | undefined;
}

/** Controlled message input; network operations and draft ownership stay with the caller. */
export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  busy = false,
  disabled = false,
  disabledReason,
  error,
  modelPicker,
  sendLabel = '发送',
}: ComposerProps) {
  const compositionRef = useRef(false);
  const helpId = useId();
  const canSend = !disabled && !busy && value.trim().length > 0;

  const send = () => {
    if (!canSend) return;
    onSend(value);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    send();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (
      compositionRef.current ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229
    )
      return;
    event.preventDefault();
    send();
  };

  return (
    <form
      aria-label="发送消息"
      className="sticky bottom-0 z-20 border-t border-[var(--color-line)] bg-[var(--color-surface)]/95 px-3 pt-3 backdrop-blur sm:px-5"
      onSubmit={handleSubmit}
      style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
    >
      <div className="mx-auto grid max-w-4xl gap-2">
        {modelPicker}
        <label className="sr-only" htmlFor={`${helpId}-message`}>
          消息内容
        </label>
        <textarea
          id={`${helpId}-message`}
          aria-describedby={`${helpId}-hint${disabledReason ? ` ${helpId}-disabled` : ''}`}
          autoComplete="off"
          className="min-h-24 w-full resize-y rounded-xl border border-[var(--color-line)] bg-white px-4 py-3 text-sm leading-6 text-[var(--color-foreground)] outline-none placeholder:text-[var(--color-muted-foreground)] focus-visible:border-[var(--color-ring)] focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] disabled:cursor-not-allowed disabled:opacity-60"
          maxLength={1_000_000}
          onChange={(event) => onChange(event.currentTarget.value)}
          onCompositionEnd={() => {
            compositionRef.current = false;
          }}
          onCompositionStart={() => {
            compositionRef.current = true;
          }}
          onKeyDown={handleKeyDown}
          placeholder={disabledReason ?? '向 CheapAI 发送消息…'}
          value={value}
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span id={`${helpId}-hint`} className="text-xs text-[var(--color-muted-foreground)]">
              Enter 发送 · Shift+Enter 换行
            </span>
          </div>
          {busy ? (
            <Button aria-label="停止生成" onClick={onStop} size="sm" variant="outline">
              <Square aria-hidden="true" size={14} />
              停止
            </Button>
          ) : (
            <Button aria-label={sendLabel} disabled={!canSend} size="sm" type="submit">
              <ArrowUp aria-hidden="true" size={16} />
              {sendLabel}
            </Button>
          )}
        </div>
        {disabledReason ? (
          <p
            id={`${helpId}-disabled`}
            className="text-xs text-[var(--color-muted-foreground)]"
            role="status"
          >
            {disabledReason}
          </p>
        ) : null}
        {error ? (
          <p className="text-sm text-[var(--color-destructive)]" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
