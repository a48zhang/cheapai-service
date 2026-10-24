import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { BrandLink } from '../../../shared/ui/BrandLink';
import { PanelLeftClose, Plus, MessageSquare, KeyRound, ReceiptText, Activity } from 'lucide-react';
import type { Conversation } from '@cheapai/api-client/chat';
import { Button } from '../../../shared/ui/Button';
import { ConversationRow } from './ConversationRow';
import type { HistoryView } from '../model/view-state';

export interface ConversationSidebarProps {
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
      className="chat-sidebar flex h-full w-full flex-col border-r border-[var(--color-line)] bg-[var(--color-surface-subtle)]"
    >
      <header className="flex h-14 shrink-0 items-center justify-between px-5">
        <BrandLink className="text-base font-semibold" />
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

      <nav aria-label="个人导航" className="space-y-1 px-2 pb-6">
        {[
          { to: '/chat', label: '对话', icon: MessageSquare },
          { to: '/keys', label: 'API 接入', icon: KeyRound },
          { to: '/billing', label: '费用', icon: ReceiptText },
          { to: '/requests', label: '请求记录', icon: Activity },
        ].map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            onClick={onClose}
            className={({ isActive }) =>
              `flex h-9 items-center gap-2 rounded-md px-2 text-sm hover:bg-[var(--color-surface-hover)] ${isActive ? 'bg-[var(--color-surface-hover)] font-medium' : ''}`
            }
          >
            <Icon size={16} aria-hidden="true" />
            {label}
          </NavLink>
        ))}
      </nav>
      <h2 className="px-4 pb-2 text-xs font-medium text-[var(--color-ink-muted)]">最近对话</h2>
      {loading && conversations.length === 0 && !error ? (
        <p className="px-5 py-4 text-sm text-[var(--color-ink-muted)]" role="status">
          正在读取对话…
        </p>
      ) : null}

      {view === 'empty' ? (
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
