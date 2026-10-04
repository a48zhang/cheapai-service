import { useId, useLayoutEffect, useRef } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode, RefObject } from 'react';
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
  readonly textareaRef?: RefObject<HTMLTextAreaElement | null>;
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
  textareaRef,
}: ComposerProps) {
  const compositionRef = useRef(false);
  const localRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = textareaRef ?? localRef;
  const helpId = useId();
  const canSend = !disabled && !busy && value.trim().length > 0;
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(Math.max(input.scrollHeight, 64), 200)}px`;
  }, [value, inputRef]);

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
      className="chat-composer"
      onSubmit={handleSubmit}
      style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
    >
      <div className="chat-composer-inner">
        <div className="chat-input-shell">
          <label className="sr-only" htmlFor={`${helpId}-message`}>
            消息内容
          </label>
          <textarea
            ref={inputRef}
            id={`${helpId}-message`}
            aria-describedby={`${helpId}-hint${disabledReason ? ` ${helpId}-disabled` : ''}`}
            autoComplete="off"
            className="chat-textarea"
            rows={1}
            maxLength={1_000_000}
            onChange={(event) => onChange(event.currentTarget.value)}
            onCompositionEnd={() => {
              compositionRef.current = false;
            }}
            onCompositionStart={() => {
              compositionRef.current = true;
            }}
            onKeyDown={handleKeyDown}
            placeholder="发送消息…"
            value={value}
          />
          <div className="chat-compose-tools">
            <div className="chat-compose-model">
              {modelPicker ?? <span className="chat-guest-hint">登录后发送</span>}
            </div>
            {busy ? (
              <Button
                className="chat-send"
                aria-label="停止生成"
                title="停止生成"
                onClick={onStop}
                size="icon"
                variant="outline"
              >
                <Square aria-hidden="true" size={14} />
              </Button>
            ) : (
              <Button
                className="chat-send"
                aria-label={sendLabel}
                title={`${sendLabel}（Enter）；Shift+Enter 换行`}
                disabled={!canSend}
                size="icon"
                type="submit"
              >
                <ArrowUp aria-hidden="true" size={16} />
              </Button>
            )}
          </div>
        </div>
        <div className="sr-only">
          <span id={`${helpId}-hint`}>Enter 发送 · Shift+Enter 换行</span>
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
