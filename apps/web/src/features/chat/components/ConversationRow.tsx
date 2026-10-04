import { useId, useState } from 'react';
import { Check, MoreHorizontal, X } from 'lucide-react';
import type { Conversation } from '@cheapai/api-client/chat';
import { Button } from '../../../shared/ui/Button';
import { DropdownMenu } from '../../../shared/ui/DropdownMenu';
import { Input } from '../../../shared/ui/Input';

export interface ConversationRowProps {
  readonly conversation: Conversation;
  readonly selected: boolean;
  readonly onSelect: (conversation: Conversation) => void;
  readonly onRename: (conversation: Conversation, title: string) => void | Promise<unknown>;
  readonly onDelete: (conversation: Conversation) => void;
}

/** One history entry with inline rename and the existing delete action. */
export function ConversationRow({
  conversation,
  selected,
  onSelect,
  onRename,
  onDelete,
}: ConversationRowProps) {
  const title = conversation.title || '新对话';
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  const beginRename = () => {
    setValue(title);
    setError(null);
    setEditing(true);
  };

  const cancelRename = () => {
    if (saving) return;
    setEditing(false);
    setValue(title);
    setError(null);
  };

  const saveRename = async () => {
    if (saving) return;
    const nextTitle = value.trim();
    if (!nextTitle) {
      setError('请输入对话名称。');
      return;
    }
    if (nextTitle === title) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onRename(conversation, nextTitle);
      setEditing(false);
    } catch {
      setError('重命名失败，请重试。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <li
      className={`group flex min-w-0 items-center rounded-md ${selected ? 'bg-white shadow-sm ring-1 ring-[var(--color-line)]' : 'hover:bg-white/70'}`}
    >
      {editing ? (
        <div className="grid min-w-0 flex-1 gap-1.5 px-2 py-2">
          <Input
            aria-describedby={error ? errorId : undefined}
            aria-invalid={Boolean(error) || undefined}
            aria-label={`重命名对话：${title}`}
            autoFocus
            disabled={saving}
            maxLength={512}
            onChange={(event) => {
              setValue(event.currentTarget.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                event.preventDefault();
                void saveRename();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelRename();
              }
            }}
            value={value}
          />
          <div className="flex justify-end gap-1">
            <Button
              aria-label="保存对话名称"
              disabled={saving || !value.trim()}
              onClick={() => void saveRename()}
              size="icon"
              variant="ghost"
            >
              <Check aria-hidden="true" size={16} />
            </Button>
            <Button
              aria-label="取消重命名"
              disabled={saving}
              onClick={cancelRename}
              size="icon"
              variant="ghost"
            >
              <X aria-hidden="true" size={16} />
            </Button>
          </div>
          {error ? (
            <p className="text-xs text-[var(--color-destructive)]" id={errorId} role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : (
        <>
          <button
            type="button"
            aria-current={selected ? 'page' : undefined}
            onClick={() => onSelect(conversation)}
            className={`flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-1 px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] ${selected ? 'text-[var(--color-accent)]' : 'text-[var(--color-ink)]'}`}
          >
            <span
              className="w-full truncate text-[13px] font-medium"
              title={`${title} · ${new Date(conversation.updatedAt).toLocaleString()}`}
            >
              {title}
            </span>
          </button>
          <DropdownMenu
            align="end"
            trigger={
              <Button
                aria-label={`对话操作：${title}`}
                className="mr-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                size="icon"
                variant="ghost"
              >
                <MoreHorizontal aria-hidden="true" size={17} />
              </Button>
            }
            items={[
              { label: '重命名', onSelect: beginRename },
              { type: 'separator' },
              { label: '删除', destructive: true, onSelect: () => onDelete(conversation) },
            ]}
          />
        </>
      )}
    </li>
  );
}
