import { PersonalNavigation } from '../../../shared/patterns/AppNavigation';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { BrandLink } from '../../../shared/ui/BrandLink';
import { Plus } from 'lucide-react';
import type { Conversation } from '@cheapai/api-client/chat';
import { Button } from '../../../shared/ui/Button';
import { ConversationRow } from './ConversationRow';
import type { HistoryView } from '../model/view-state';

export interface ConversationSidebarProps {
  readonly isAdmin?: boolean;
  readonly conversations: readonly Conversation[];
  readonly activeId: string | null;
  readonly view: HistoryView;
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
  isAdmin = false,
  conversations,
  activeId,
  view,
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
  const loading = view === 'preparing' || view === 'loading';
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
      className="chat-sidebar flex h-full w-full flex-col border-r border-[var(--color-border)] bg-[var(--color-surface-subtle)]"
    >
      {!mobileOpen && (
        <header className="flex h-14 shrink-0 items-center justify-between px-4">
          <BrandLink className="text-base font-semibold" />
        </header>
      )}

      <div className="px-2 py-3">
        <Button className="w-full justify-start" onClick={onNew} variant="outline">
          <Plus aria-hidden="true" size={17} />
          新对话
        </Button>
      </div>

      <div className="px-2 pb-4">
        <PersonalNavigation isAdmin={isAdmin} onNavigate={onClose} />
      </div>
      <h2 className="px-4 pb-2 text-xs font-medium text-[var(--color-ink-muted)]">最近对话</h2>
      {loading && conversations.length === 0 && !error ? (
        <p className="px-5 py-4 text-sm text-[var(--color-ink-muted)]" role="status">
          正在读取对话…
        </p>
      ) : null}

      {view === 'empty' ? (
        <p className="mx-4 border-t border-[var(--color-border)] px-1 py-5 text-sm text-[var(--color-ink-muted)]">
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
