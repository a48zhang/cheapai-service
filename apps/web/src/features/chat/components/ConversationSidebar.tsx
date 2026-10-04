import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { PanelLeftClose, Plus } from 'lucide-react';
import type { Conversation } from '@cheapai/api-client/chat';
import { Button } from '../../../shared/ui/Button';
import { ConversationRow } from './ConversationRow';

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
  readonly onRename: (conversation: Conversation, title: string) => void | Promise<unknown>;
  readonly onDelete: (conversation: Conversation) => void;
  readonly onLoadMore: () => void;
  readonly onRetry: () => void;
  readonly onClose: () => void;
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
  const historyRootRef = useRef<HTMLElement | null>(null);
  const historyEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = historyRootRef.current;
    const target = historyEndRef.current;
    if (
      !root ||
      !target ||
      !hasMore ||
      error ||
      loading ||
      loadingMore ||
      typeof IntersectionObserver === 'undefined'
    )
      return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
      },
      { root, rootMargin: '80px 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [error, hasMore, loading, loadingMore, onLoadMore]);

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
        <p className="px-5 py-4 text-sm text-[var(--color-ink-muted)]" role="status">
          正在读取对话…
        </p>
      ) : null}

      {!loading && conversations.length === 0 && !error ? (
        <p className="mx-4 border-t border-[var(--color-line)] px-1 py-5 text-sm text-[var(--color-ink-muted)]">
          还没有对话
        </p>
      ) : null}

      {conversations.length > 0 ? (
        <nav
          aria-label="历史对话"
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
          ref={historyRootRef}
        >
          <ul className="space-y-1">
            {conversations.map((conversation) => {
              return (
                <ConversationRow
                  key={conversation.id}
                  conversation={conversation}
                  onDelete={onDelete}
                  onRename={onRename}
                  onSelect={onSelect}
                  selected={conversation.id === activeId}
                />
              );
            })}
          </ul>
          {hasMore && !error ? (
            <div aria-hidden="true" className="h-2" ref={historyEndRef} />
          ) : null}
          {loadingMore ? (
            <p
              className="px-3 py-2 text-center text-xs text-[var(--color-ink-muted)]"
              role="status"
            >
              正在读取…
            </p>
          ) : null}
        </nav>
      ) : null}

      {error ? (
        <div
          className="m-3 rounded-md border border-[var(--color-danger-soft)] bg-[var(--color-surface)] p-3 text-sm text-[var(--color-danger)]"
          role="alert"
        >
          <div>{error}</div>
          <Button className="mt-2" onClick={onRetry} size="sm" variant="outline">
            重试
          </Button>
        </div>
      ) : null}
    </aside>
  );
}
