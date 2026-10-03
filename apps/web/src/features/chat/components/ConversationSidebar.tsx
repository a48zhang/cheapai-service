import type { ReactNode } from 'react';
import { MoreHorizontal, PanelLeftClose, Plus } from 'lucide-react';
import type { Conversation } from '@cheapai/api-client/chat';
import { Button } from '../../../shared/ui/Button';
import { DropdownMenu } from '../../../shared/ui/DropdownMenu';

export interface ConversationSidebarProps {
  readonly conversations: readonly Conversation[];
  readonly activeId: string | null;
  readonly loading?: boolean;
  readonly loadingMore?: boolean;
  readonly hasMore?: boolean;
  readonly mobileOpen?: boolean;
  readonly error?: ReactNode;
  readonly onNew: () => void;
  readonly onSelect: (conversation: Conversation) => void;
  readonly onRename: (conversation: Conversation) => void;
  readonly onDelete: (conversation: Conversation) => void;
  readonly onLoadMore: () => void;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}

function dateLabel(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function isoLabel(timestamp: number): string | undefined {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/** Conversation navigation and actions; all writes are supplied by its owner. */
export function ConversationSidebar({
  conversations,
  activeId,
  loading = false,
  loadingMore = false,
  hasMore = false,
  mobileOpen = false,
  error,
  onNew,
  onSelect,
  onRename,
  onDelete,
  onLoadMore,
  onRetry,
  onClose,
}: ConversationSidebarProps) {
  return (
    <aside
      aria-label="聊天记录"
      data-mobile-open={mobileOpen ? 'true' : undefined}
      className={`fixed inset-y-14 left-0 z-40 flex w-[min(86vw,18rem)] -translate-x-full flex-col border-r border-[var(--color-line)] bg-[var(--color-surface-subtle)] shadow-[var(--shadow-md)] transition-transform md:static md:z-auto md:w-60 md:translate-x-0 md:shadow-none ${mobileOpen ? 'translate-x-0' : ''}`}
    >
      <header className="flex h-14 shrink-0 items-center justify-between px-5">
        <h2 className="text-sm font-semibold text-[var(--color-ink)]">对话</h2>
        <Button
          aria-label="关闭聊天记录"
          className="md:hidden"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <PanelLeftClose aria-hidden="true" size={18} />
        </Button>
      </header>

      <div className="px-3 pb-4">
        <Button className="w-full justify-start" onClick={onNew} variant="outline">
          <Plus aria-hidden="true" size={17} />
          新对话
        </Button>
      </div>

      {loading && conversations.length === 0 && !error ? (
        <p className="px-5 py-4 text-sm text-[var(--color-ink-muted)]" role="status">正在读取对话…</p>
      ) : null}

      {!loading && conversations.length === 0 && !error ? (
        <p className="mx-4 border-t border-[var(--color-line)] px-1 py-5 text-sm text-[var(--color-ink-muted)]">
          还没有对话
        </p>
      ) : null}

      {conversations.length > 0 ? (
        <nav aria-label="历史对话" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <ul className="space-y-1">
            {conversations.map((conversation) => {
              const title = conversation.title || '新对话';
              const selected = conversation.id === activeId;
              return (
                <li
                  key={conversation.id}
                  className={`group flex min-w-0 items-center rounded-md ${selected ? 'bg-white shadow-sm ring-1 ring-[var(--color-line)]' : 'hover:bg-white/70'}`}
                >
                  <button
                    type="button"
                    aria-current={selected ? 'page' : undefined}
                    onClick={() => onSelect(conversation)}
                    className={`flex min-h-12 min-w-0 flex-1 flex-col justify-center gap-1 px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] ${selected ? 'text-[var(--color-accent)]' : 'text-[var(--color-ink)]'}`}
                  >
                    <span className="w-full truncate text-[13px] font-medium" title={title}>{title}</span>
                    <time className="text-[11px] text-[var(--color-ink-muted)]" dateTime={isoLabel(conversation.updatedAt)}>
                      {dateLabel(conversation.updatedAt)}
                    </time>
                  </button>
                  <DropdownMenu
                    align="end"
                    trigger={(
                      <Button
                        aria-label={`对话操作：${title}`}
                        className="mr-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                        size="icon"
                        variant="ghost"
                      >
                        <MoreHorizontal aria-hidden="true" size={17} />
                      </Button>
                    )}
                    items={[
                      { label: '重命名', onSelect: () => onRename(conversation) },
                      { type: 'separator' },
                      { label: '删除', destructive: true, onSelect: () => onDelete(conversation) },
                    ]}
                  />
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}

      {error ? (
        <div className="m-3 rounded-md border border-[var(--color-danger-soft)] bg-[var(--color-surface)] p-3 text-sm text-[var(--color-danger)]" role="alert">
          <div>{error}</div>
          <Button className="mt-2" onClick={onRetry} size="sm" variant="outline">重试</Button>
        </div>
      ) : null}

      {hasMore && !error ? (
        <Button
          className="mx-3 mb-3 justify-center"
          disabled={loading || loadingMore}
          onClick={onLoadMore}
          size="sm"
          variant="ghost"
        >
          {loadingMore ? '正在读取…' : '加载更多'}
        </Button>
      ) : null}
    </aside>
  );
}
