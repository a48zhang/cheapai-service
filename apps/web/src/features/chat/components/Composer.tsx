import { useId, useLayoutEffect, useRef } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode, RefObject } from 'react';
import type { ChatOperationKind, ChatPhase } from '../model/state';
import { getChatPresentation } from '../model/presentation';
import { ChatSubmitButton } from './ChatSubmitButton';

export interface ComposerProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSend: (content: string) => void;
  readonly onStop: () => void;
  readonly phase?: ChatPhase;
  readonly operationKind?: ChatOperationKind | null;
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
  phase = 'idle',
  operationKind = null,
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
  const presentation = getChatPresentation(phase, operationKind);
  const canSend = !disabled && presentation.submit.action === 'send' && value.trim().length > 0;
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(Math.max(input.scrollHeight, 64), 200)}px`;
  }, [value, inputRef]);

  const send = () => {
    if (!canSend) return;
    onSend(value);
    inputRef.current?.focus();
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
            placeholder={presentation.submit.action === 'send' ? '发送消息…' : '可继续编辑草稿…'}
            value={value}
          />
          <div className="chat-compose-tools">
            <div className="chat-compose-model">{modelPicker}</div>
            <ChatSubmitButton
              presentation={presentation.submit}
              canSend={canSend}
              sendLabel={sendLabel}
              onStop={onStop}
            />
          </div>
        </div>
        <p className="chat-composer-hint" id={`${helpId}-hint`}>
          {presentation.inputHint}
        </p>
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
