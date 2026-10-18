import type { ChatMessage } from '@cheapai/api-client/chat';
import { MessageContent } from './MessageContent';
import { MessageActions } from './MessageActions';
import { Button } from '../../../shared/ui/Button';
import { CopyButton } from '../../../shared/ui/CopyButton';
import type { ChatPhase, ChatSubmission } from '../model/state';

/** Separate from ChatMessage: an accepted local command is not yet a saved message. */
export function SubmissionMessage({
  submission,
  phase,
  onRestore,
}: {
  submission: ChatSubmission;
  phase: ChatPhase;
  onRestore?: ((content: string) => void) | undefined;
}) {
  const label =
    phase === 'failed'
      ? '发送未完成'
      : phase === 'interrupted'
        ? '结果待确认'
        : phase === 'idle'
          ? '未发送'
          : phase === 'stopping'
            ? '正在停止…'
            : phase === 'finalizing'
              ? '正在确认结果…'
              : '发送中…';
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
        <div className="mt-2 flex min-h-8 items-center justify-end gap-2 text-xs text-[var(--color-muted-foreground)]">
          <span role="status">{label}</span>
          <CopyButton value={submission.content} label="复制问题" />
          {onRestore && (phase === 'failed' || phase === 'idle') && (
            <Button size="sm" variant="ghost" onClick={() => onRestore(submission.content)}>
              编辑问题
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}

export interface MessageProps {
  readonly message: ChatMessage;
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
  variants = [],
  streaming = false,
  streamText = '',
  busy = false,
  canSelectVersion = false,
  canRegenerate = false,
  onSelectVersion,
  onRegenerate,
}: MessageProps) {
  const isUser = message.role === 'user';
  const content = streaming ? streamText || '正在生成…' : message.content;
  const assistantStatus = isUser ? undefined : streaming ? '生成中' : statusLabel[message.status];

  return (
    <article
      aria-label={isUser ? '你的消息' : 'CheapAI 的回答'}
      className={`chat-message mx-auto flex w-full max-w-4xl gap-3 px-3 py-4 sm:px-5 ${isUser ? 'flex-row-reverse' : ''}`}
      data-message-id={message.id}
      data-message-role={message.role}
    >
      <div className={`min-w-0 flex-1 ${isUser ? 'max-w-[86%] text-right' : ''}`}>
        {!isUser && (
          <header className="chat-answer-meta">
            {message.modelId ? (
              <span aria-label="使用模型" className="chat-answer-model" title={message.modelId}>
                {message.modelId}
              </span>
            ) : null}
            {assistantStatus ? <span role="status">{assistantStatus}</span> : null}
          </header>
        )}
        <div className={isUser ? 'chat-user-bubble' : 'chat-answer-body'}>
          <MessageContent content={content} />
        </div>
        <MessageActions
          actionsBusy={busy || streaming}
          canRegenerate={canRegenerate}
          canSelectVersion={canSelectVersion}
          message={message}
          onRegenerate={onRegenerate}
          onSelectVersion={onSelectVersion}
          variants={variants}
        />
      </div>
    </article>
  );
}
