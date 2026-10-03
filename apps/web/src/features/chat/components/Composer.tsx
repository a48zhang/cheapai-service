import { useId, useRef } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';

export interface ComposerProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSend: (content: string, maxOutputTokens?: number) => void;
  readonly onStop: () => void;
  readonly busy?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly disabledReason?: string | undefined;
  readonly error?: string | null | undefined;
  readonly maxOutputTokens: string;
  readonly maxOutputTokensCeiling?: number | undefined;
  readonly onMaxOutputTokensChange: (value: string) => void;
}

function parsedOutputLimit(value: string): number | undefined {
  if (value.length === 0) return undefined;
  if (!/^[1-9][0-9]*$/u.test(value)) return Number.NaN;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
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
  maxOutputTokens,
  maxOutputTokensCeiling,
  onMaxOutputTokensChange,
}: ComposerProps) {
  const compositionRef = useRef(false);
  const helpId = useId();
  const outputLimitId = useId();
  const outputLimitErrorId = useId();
  const outputLimit = parsedOutputLimit(maxOutputTokens);
  const outputLimitInvalid = Number.isNaN(outputLimit)
    || (outputLimit !== undefined && maxOutputTokensCeiling !== undefined && outputLimit > maxOutputTokensCeiling);
  const canSend = !disabled && !busy && value.trim().length > 0 && !outputLimitInvalid;

  const send = () => {
    if (!canSend) return;
    onSend(value, outputLimit);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    send();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (compositionRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    event.preventDefault();
    send();
  };

  const outputLimitError = maxOutputTokens.length === 0
    ? undefined
    : Number.isNaN(outputLimit)
      ? '请输入正整数。'
      : outputLimit !== undefined && maxOutputTokensCeiling !== undefined && outputLimit > maxOutputTokensCeiling
        ? `不能超过当前模型上限 ${maxOutputTokensCeiling.toLocaleString()}。`
        : undefined;

  return (
    <form
      aria-label="发送消息"
      className="sticky bottom-0 z-20 border-t border-[var(--color-line)] bg-[var(--color-surface)]/95 px-3 pt-3 backdrop-blur sm:px-5"
      onSubmit={handleSubmit}
      style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
    >
      <div className="mx-auto grid max-w-4xl gap-2">
        <label className="sr-only" htmlFor={`${helpId}-message`}>消息内容</label>
        <textarea
          id={`${helpId}-message`}
          aria-describedby={`${helpId}-hint${disabledReason ? ` ${helpId}-disabled` : ''}${outputLimitError ? ` ${outputLimitErrorId}` : ''}`}
          aria-invalid={Boolean(outputLimitError) || undefined}
          autoComplete="off"
          className="min-h-24 w-full resize-y rounded-xl border border-[var(--color-line)] bg-white px-4 py-3 text-sm leading-6 text-[var(--color-foreground)] outline-none placeholder:text-[var(--color-muted-foreground)] focus-visible:border-[var(--color-ring)] focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] disabled:cursor-not-allowed disabled:opacity-60"
          maxLength={1_000_000}
          onChange={event => onChange(event.currentTarget.value)}
          onCompositionEnd={() => { compositionRef.current = false; }}
          onCompositionStart={() => { compositionRef.current = true; }}
          onKeyDown={handleKeyDown}
          placeholder={disabledReason ?? '向 cheapai 发送消息…'}
          value={value}
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <label className="flex items-center gap-2 text-xs text-[var(--color-muted-foreground)]" htmlFor={outputLimitId}>
              输出上限
              <input
                id={outputLimitId}
                aria-describedby={outputLimitError ? outputLimitErrorId : undefined}
                aria-invalid={Boolean(outputLimitError) || undefined}
                className="h-8 w-28 rounded-md border border-[var(--color-line)] bg-white px-2 text-xs text-[var(--color-foreground)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] disabled:cursor-not-allowed disabled:opacity-60"
                disabled={disabled}
                inputMode="numeric"
                max={maxOutputTokensCeiling}
                min={1}
                onChange={event => onMaxOutputTokensChange(event.currentTarget.value)}
                placeholder={maxOutputTokensCeiling ? `≤ ${maxOutputTokensCeiling}` : '自动'}
                type="number"
                value={maxOutputTokens}
              />
            </label>
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
            <Button aria-label="发送消息" disabled={!canSend} size="sm" type="submit">
              <ArrowUp aria-hidden="true" size={16} />
              发送
            </Button>
          )}
        </div>
        {disabledReason ? (
          <p id={`${helpId}-disabled`} className="text-xs text-[var(--color-muted-foreground)]" role="status">
            {disabledReason}
          </p>
        ) : null}
        {outputLimitError ? (
          <p id={outputLimitErrorId} className="text-xs text-[var(--color-destructive)]" role="alert">
            {outputLimitError}
          </p>
        ) : null}
        {error ? (
          <p className="text-sm text-[var(--color-destructive)]" role="alert">{error}</p>
        ) : null}
      </div>
    </form>
  );
}
