import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { ChatMessage } from '@cheapai/api-client/chat';
import type { ConversationDetail } from '@cheapai/api-client/chat';
import { Button } from '../../../shared/ui/Button';
import { createMessageRows } from '../model/message-rows';
import { canRegenerateLastAssistant, canSelectAssistantVariant } from '../model/variants';
import { Message } from './Message';
import { useScrollAnchor } from '../hooks/useScrollAnchor';

export interface MessageListProps {
  readonly messages: readonly ChatMessage[];
  readonly detail?: ConversationDetail | null | undefined;
  readonly streamMessageId?: string | null | undefined;
  readonly streamText?: string | undefined;
  readonly busy?: boolean | undefined;
  readonly onRegenerate?: ((message: ChatMessage) => void) | undefined;
  readonly onSelectVersion?: ((messageId: string) => void) | undefined;
  readonly regenerateDisabledReason?: string | undefined;
  readonly className?: string | undefined;
  readonly loading?: boolean | undefined;
  readonly emptyMessage?: ReactNode | undefined;
}

function canOperateOnAssistant(message: ChatMessage): boolean {
  return message.status !== 'generating';
}

/** Message timeline that renders one selected answer per turn and preserves reading position. */
export function MessageList({
  messages,
  detail,
  streamMessageId = null,
  streamText = '',
  busy = false,
  onRegenerate,
  onSelectVersion,
  regenerateDisabledReason,
  className,
  loading = false,
  emptyMessage = '在下方输入消息开始对话。',
}: MessageListProps) {
  const timeline = useMemo(
    () => createMessageRows(messages, streamMessageId),
    [messages, streamMessageId],
  );
  const rows = timeline.rows;
  const messageIds = useMemo(() => rows.map((row) => row.message.id), [rows]);
  const latestTurnIndex = timeline.latestAssistantTurnIndex;
  const regenerateAvailability = detail === undefined ? null : canRegenerateLastAssistant(detail);
  const latestVisibleMessage = rows.at(-1)?.message;
  const contentVersion = `${streamMessageId ?? ''}:${streamText.length}:${latestVisibleMessage?.updatedAt ?? 0}:${messages.length}`;
  const anchor = useScrollAnchor({
    messageIds,
    contentVersion,
    announcementText: streamText || latestVisibleMessage?.content || '',
  });

  return (
    <section
      aria-label="聊天消息"
      className={`relative flex min-h-0 flex-1 flex-col ${className ?? ''}`}
    >
      <div
        ref={anchor.containerRef}
        aria-label="对话消息"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        aria-live="off"
        onScroll={anchor.onScroll}
        role="log"
      >
        {loading && rows.length === 0 ? (
          <p
            className="mx-auto max-w-4xl px-5 py-10 text-center text-sm text-[var(--color-muted-foreground)]"
            role="status"
          >
            正在读取对话…
          </p>
        ) : null}
        {!loading && rows.length === 0 ? (
          <div className="mx-auto max-w-4xl px-4 py-4 text-center text-sm text-[var(--color-muted-foreground)]">
            {emptyMessage}
          </div>
        ) : null}
        {rows.map((row) => {
          if (row.kind === 'user') return <Message key={row.message.id} message={row.message} />;
          const isLatestTurn = row.message.turnIndex === latestTurnIndex;
          const isCurrentSelection = row.selectedId === row.message.id;
          const streaming = row.message.id === streamMessageId;
          const selectableVariants = row.variants.filter((variant) => {
            if (variant.id === row.message.id) return true;
            if (detail === undefined) return canOperateOnAssistant(variant);
            return canSelectAssistantVariant(detail, variant.id).allowed;
          });
          const canRegenerate =
            isLatestTurn &&
            isCurrentSelection &&
            canOperateOnAssistant(row.message) &&
            (regenerateAvailability === null
              ? true
              : regenerateAvailability.allowed &&
                regenerateAvailability.assistant.id === row.message.id) &&
            !busy &&
            onRegenerate !== undefined &&
            regenerateDisabledReason === undefined;
          const canSelectVersion =
            isLatestTurn &&
            isCurrentSelection &&
            canOperateOnAssistant(row.message) &&
            selectableVariants.some((variant) => variant.id !== row.message.id) &&
            !busy &&
            onSelectVersion !== undefined;
          return (
            <Message
              key={row.message.id}
              busy={busy}
              canRegenerate={canRegenerate}
              canSelectVersion={canSelectVersion}
              message={row.message}
              onRegenerate={onRegenerate}
              onSelectVersion={onSelectVersion}
              streamText={streamText}
              streaming={streaming}
              variants={selectableVariants}
            />
          );
        })}
      </div>
      {anchor.showJumpToLatest ? (
        <Button
          className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full shadow-[var(--shadow-md)]"
          onClick={anchor.jumpToLatest}
          size="sm"
          variant="secondary"
        >
          回到最新消息
        </Button>
      ) : null}
      <p aria-atomic="true" aria-live="polite" className="sr-only" role="status">
        {anchor.announcement || (busy && streamMessageId === null ? '正在处理消息。' : '')}
      </p>
    </section>
  );
}
