import { UserRound } from 'lucide-react';
import type { ChatMessage } from '@cheapai/api-client/chat';
import { MessageContent } from './MessageContent';
import { MessageActions } from './MessageActions';
import { BrandMark } from '../../../shared/ui/BrandMark';

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
      className={`mx-auto flex w-full max-w-4xl gap-3 px-3 py-4 sm:px-5 ${isUser ? 'flex-row-reverse' : ''}`}
      data-message-id={message.id}
      data-message-role={message.role}
    >
      <div
        aria-hidden="true"
        className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full ${isUser ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'bg-[var(--color-muted)] text-[var(--color-foreground)]'}`}
      >
        {isUser ? <UserRound size={16} /> : <BrandMark className="size-6" />}
      </div>
      <div className={`min-w-0 flex-1 ${isUser ? 'max-w-[86%] text-right' : ''}`}>
        <header
          className={`mb-1.5 flex items-center gap-2 text-xs text-[var(--color-muted-foreground)] ${isUser ? 'justify-end' : ''}`}
        >
          <span className="font-medium text-[var(--color-foreground)]">
            {isUser ? '你' : 'CheapAI'}
          </span>
          {!isUser && message.modelId ? (
            <span aria-label="使用模型" className="truncate">
              {message.modelId}
            </span>
          ) : null}
          {assistantStatus ? <span role="status">{assistantStatus}</span> : null}
        </header>
        <div
          className={`min-w-0 rounded-2xl px-4 py-2 ${isUser ? 'inline-block bg-[var(--color-accent-soft)] text-left' : 'bg-transparent px-0'}`}
        >
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
