import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ChannelView } from '@cheapai/api-client/channels';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import type { ChannelOptionsSnapshot } from './channel-options';

export interface ChannelPickerProps {
  /** Selected channel IDs remain controlled by the containing form. */
  readonly value: readonly string[];
  readonly onValueChange: (ids: readonly string[]) => void;
  /** Undefined means the complete candidate query has not succeeded yet. */
  readonly candidates: ChannelOptionsSnapshot | undefined;
  readonly loading?: boolean;
  /** Query errors are shown independently from the form's own read/save state. */
  readonly error?: ReactNode | Error | null;
  readonly onRetry?: () => void;
  readonly onOpenChange?: (open: boolean) => void;
  /** Set to 1 for a mapping's single channel; omit for a group's channel set. */
  readonly maxSelected?: number;
  readonly label?: ReactNode;
  readonly disabled?: boolean;
}

function channelLabel(channel: ChannelView | undefined, id: string) {
  if (!channel) return `未知渠道（${id}）`;
  return channel.status === 'disabled' ? `${channel.name}（已停用）` : channel.name;
}

function sameIds(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** A staged multi-select; closing the dialog discards changes until the user applies them. */
export function ChannelPicker({
  value,
  onValueChange,
  candidates,
  loading = false,
  error,
  onRetry,
  onOpenChange,
  maxSelected,
  label = '关联渠道',
  disabled = false,
}: ChannelPickerProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<readonly string[]>([]);
  const [search, setSearch] = useState('');
  const options = candidates?.items ?? [];
  const optionById = new Map<string, ChannelView>();
  for (const channel of options) optionById.set(channel.id, channel);
  const currentIds = new Set(value);
  const draftIds = new Set(draft);
  const missingIds = [...new Set([...value, ...draft])].filter((id) => !optionById.has(id));
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const errorMessage = error instanceof Error ? error.message : error;
  const visibleOptions = options.filter((channel) =>
    `${channel.name} ${channel.id}`.toLocaleLowerCase().includes(normalizedSearch),
  );
  const visibleMissingIds = missingIds.filter((id) =>
    `未知渠道 ${id}`.toLocaleLowerCase().includes(normalizedSearch),
  );
  const complete = candidates?.complete === true && !loading && errorMessage == null;
  const hasChanges = !sameIds(draft, value);
  const selectionLimitReached = maxSelected !== undefined && draft.length >= maxSelected;
  const summary =
    value.length > 0
      ? value.map((id) => channelLabel(optionById.get(id), id)).join('、')
      : '未选择渠道';

  const openPicker = () => {
    setDraft([...value]);
    setSearch('');
    setOpen(true);
    onOpenChange?.(true);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) openPicker();
    else {
      setDraft([...value]);
      setOpen(false);
      onOpenChange?.(false);
    }
  };

  const toggle = (id: string) => {
    const selected = draftIds.has(id);
    if (selected) {
      setDraft(draft.filter((current) => current !== id));
      return;
    }
    if (selectionLimitReached) return;
    setDraft([...draft, id]);
  };

  const apply = () => {
    if (!complete || !hasChanges || disabled) return;
    onValueChange([...draft]);
    handleOpenChange(false);
  };

  return (
    <div className="grid gap-1.5">
      <span className="text-sm font-medium text-[var(--color-foreground)]">{label}</span>
      <Dialog
        open={open}
        onOpenChange={handleOpenChange}
        trigger={
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            aria-label={`${typeof label === 'string' ? label : '渠道'}：${summary}`}
            className="min-h-10 w-full justify-between text-left font-normal"
          >
            <span className="min-w-0 truncate">{summary}</span>
            <span aria-hidden="true" className="shrink-0 text-[var(--color-muted-foreground)]">
              ⌄
            </span>
          </Button>
        }
        title="选择渠道"
        description={maxSelected === 1 ? '为此映射选择一个渠道。' : '选择要关联到此组的渠道。'}
        closeLabel="关闭渠道选择"
        className="max-w-2xl"
        footer={
          <>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              取消
            </Button>
            <Button type="button" disabled={!complete || !hasChanges || disabled} onClick={apply}>
              应用选择
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <label className="grid gap-1.5 text-sm font-medium text-[var(--color-foreground)]">
            搜索渠道
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              placeholder="按名称或 ID 搜索"
              className="min-h-10 rounded-md border bg-white px-3 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
              style={{ borderColor: 'var(--color-border)', color: 'var(--color-foreground)' }}
            />
          </label>

          {loading && (
            <p role="status" className="text-sm text-[var(--color-muted-foreground)]">
              正在加载完整渠道列表…
            </p>
          )}
          {errorMessage != null && (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[var(--color-destructive)] bg-[var(--color-destructive-soft)] p-3 text-sm"
            >
              <span>渠道候选加载失败：{errorMessage}</span>
              {onRetry && (
                <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                  重试候选加载
                </Button>
              )}
            </div>
          )}
          {!loading && errorMessage == null && !candidates && (
            <p role="status" className="text-sm text-[var(--color-muted-foreground)]">
              渠道候选尚未就绪。
            </p>
          )}

          <div
            className="max-h-72 space-y-1 overflow-y-auto rounded-md border p-2"
            style={{ borderColor: 'var(--color-border)' }}
          >
            {visibleOptions.map((channel) => {
              const checked = draftIds.has(channel.id);
              const wasSelected = currentIds.has(channel.id);
              const unavailable =
                !complete || disabled || (channel.status === 'disabled' && !wasSelected);
              const atLimit = !checked && selectionLimitReached;
              return (
                <label
                  key={channel.id}
                  className={`flex min-h-10 items-center gap-3 rounded px-3 py-2 text-sm ${unavailable || atLimit ? 'cursor-not-allowed opacity-55' : 'cursor-pointer hover:bg-[var(--color-muted)]'}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={unavailable || atLimit}
                    onChange={() => toggle(channel.id)}
                    className="size-4 accent-[var(--color-primary)]"
                  />
                  <span className="min-w-0 flex-1 truncate text-[var(--color-foreground)]">
                    {channel.name}
                  </span>
                  <span className="shrink-0 text-xs text-[var(--color-muted-foreground)]">
                    {channel.id}
                  </span>
                  {channel.status === 'disabled' && (
                    <span className="shrink-0 rounded bg-[var(--color-muted)] px-2 py-0.5 text-xs text-[var(--color-muted-foreground)]">
                      已停用
                    </span>
                  )}
                </label>
              );
            })}
            {visibleMissingIds.map((id) => {
              const checked = draftIds.has(id);
              return (
                <label
                  key={`missing:${id}`}
                  className="flex min-h-10 cursor-pointer items-center gap-3 rounded border border-dashed px-3 py-2 text-sm"
                  style={{ borderColor: 'var(--color-border)' }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!complete || disabled || (!checked && selectionLimitReached)}
                    onChange={() => toggle(id)}
                    className="size-4 accent-[var(--color-primary)]"
                  />
                  <span className="min-w-0 flex-1 truncate text-[var(--color-muted-foreground)]">
                    未知渠道（保留当前 ID）
                  </span>
                  <span className="shrink-0 text-xs text-[var(--color-muted-foreground)]">
                    {id}
                  </span>
                </label>
              );
            })}
            {visibleOptions.length === 0 && visibleMissingIds.length === 0 && complete && (
              <p
                role="status"
                className="px-3 py-6 text-center text-sm text-[var(--color-muted-foreground)]"
              >
                {normalizedSearch ? '没有匹配的渠道。' : '没有可用渠道。'}
              </p>
            )}
          </div>
          {maxSelected !== undefined && (
            <p className="text-xs text-[var(--color-muted-foreground)]">
              最多选择 {maxSelected} 个渠道。
            </p>
          )}
          {!complete && !loading && errorMessage == null && (
            <p className="text-xs text-[var(--color-muted-foreground)]">
              完成完整候选加载后才能应用新的选择；当前值会保留。
            </p>
          )}
        </div>
      </Dialog>
    </div>
  );
}
