import type { ChatMessage } from '@cheapai/api-client/chat';
import { MessageContent } from './MessageContent';
import { MessageActions } from './MessageActions';
import { Button } from '../../../shared/ui/Button';
import type { ChatPhase, ChatSubmission } from '../model/state';
import { LoaderCircle } from 'lucide-react';
import { getChatPresentation } from '../model/presentation';

/** Separate from ChatMessage: an accepted local command is not yet a saved message. */
export function SubmissionMessage({
  submission,
  phase,
  onRetry,
  retryDisabled,
}: {
  submission: ChatSubmission;
  phase: ChatPhase;
  onRetry?: (() => void) | undefined;
  retryDisabled?: boolean | undefined;
}) {
  return (
    <article
      aria-label="待确认的消息"
      className="chat-message mx-auto flex w-full max-w-4xl flex-row-reverse gap-3 px-3 py-4 sm:px-5"
      data-submission-id={submission.operationId}
    >
      <div className="min-w-0 max-w-[86%] flex-1 text-right">
        <div className="chat-user-bubble">
          <MessageContent content={submission.content} />
        </div>
        {(phase === 'failed' || phase === 'idle') && (
          <div className="mt-2 text-xs text-[var(--color-muted-foreground)]">
            <span>未发送</span>
            {onRetry && (
              <Button size="sm" variant="ghost" disabled={retryDisabled} onClick={onRetry}>
                重试发送
              </Button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

export interface MessageProps {
  readonly message: ChatMessage | null;
  readonly phase?: ChatPhase;
  readonly variants?: readonly ChatMessage[] | undefined;
  readonly streaming?: boolean | undefined;
  readonly streamText?: string | undefined;
  readonly busy?: boolean | undefined;
  readonly canSelectVersion?: boolean | undefined;
  readonly canRegenerate?: boolean | undefined;
  readonly onSelectVersion?: ((messageId: string) => void) | undefined;
  readonly onRegenerate?: ((message: ChatMessage) => void) | undefined;
}

const statusLabel: Partial<Record<ChatMessage['status'], string>> = {
  generating: '生成中',
  stopped: '已停止',
  failed: '生成失败',
};

/** A single user or assistant turn with its message-scoped actions. */
export function Message({
  message,
  phase,
  variants = [],
  streaming = false,
  streamText = '',
  busy = false,
  canSelectVersion = false,
  canRegenerate = false,
  onSelectVersion,
  onRegenerate,
}: MessageProps) {
  const isUser = message?.role === 'user';
  const content =
    streaming && message?.status === 'generating'
      ? streamText || message.content
      : message?.content || (streaming ? streamText : '');
  const activity = isUser
    ? null
    : getChatPresentation(phase ?? (streaming ? 'streaming' : 'idle'), null, content.length > 0)
        .response;
  const assistantStatus = isUser
    ? undefined
    : (activity?.label ?? (message ? statusLabel[message.status] : undefined));

  return (
    <article
      aria-label={isUser ? '你的消息' : 'CheapAI 的回答'}
      className={`chat-message mx-auto flex w-full max-w-4xl gap-3 px-3 py-4 sm:px-5 ${isUser ? 'flex-row-reverse' : ''}`}
      data-message-id={message?.id}
      data-message-role={message?.role ?? 'assistant'}
    >
      <div className={`min-w-0 flex-1 ${isUser ? 'max-w-[86%] text-right' : ''}`}>
        {!isUser && (
          <header className="chat-answer-meta">
            {message?.modelId ? (
              <span aria-label="使用模型" className="chat-answer-model" title={message.modelId}>
                {message.modelId}
              </span>
            ) : null}
            {assistantStatus ? (
              <span className="chat-answer-status" role="status">
                {activity?.animated && (
                  <LoaderCircle
                    aria-hidden="true"
                    className="animate-spin motion-reduce:animate-none"
                    size={16}
                  />
                )}
                {assistantStatus}
              </span>
            ) : null}
          </header>
        )}
        <div className={isUser ? 'chat-user-bubble' : 'chat-answer-body'}>
          {content && <MessageContent content={content} />}
        </div>
        {message && (
          <MessageActions
            actionsBusy={busy || streaming}
            canRegenerate={canRegenerate}
            canSelectVersion={canSelectVersion}
            message={message}
            copyContent={content}
            onRegenerate={onRegenerate}
            onSelectVersion={onSelectVersion}
            variants={variants}
          />
        )}
      </div>
    </article>
  );
}
