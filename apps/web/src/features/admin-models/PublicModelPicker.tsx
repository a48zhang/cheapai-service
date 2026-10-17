import { useEffect, useId, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@cheapai/api-client/types';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { Button } from '../../shared/ui/Button';
import { Dialog } from '../../shared/ui/Dialog';
import { Input } from '../../shared/ui/Input';
import { ModelIdentity } from '../../shared/ui/ModelIdentity';
import { adminModelsQueryKeys, modelListQueryOptions } from './api';
import { ModelForm } from './ModelForm';

export interface PublicModelPickerProps {
  readonly client: ApiClient;
  readonly actorId: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly required?: boolean;
  readonly 'aria-describedby'?: string;
  readonly 'aria-invalid'?: boolean | 'true' | 'false';
}

/** Selects catalog entries and creates them without leaving the channel draft. */
export function PublicModelPicker({
  client,
  actorId,
  value,
  onValueChange,
  disabled,
  id,
  required,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
}: PublicModelPickerProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const listId = `${controlId}-options`;
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(0);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState('');
  const [createdIds, setCreatedIds] = useState<string[]>([]);
  const models = useInfiniteQuery(modelListQueryOptions({ client, actorId }));
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = models;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, listId, search]);
  const ids = [
    ...new Set([
      ...createdIds,
      ...(value ? [value] : []),
      ...(models.data?.pages.flatMap((page) => page.items.map((model) => model.publicModelId)) ??
        []),
    ]),
  ];
  const options = ids.filter((modelId) =>
    modelId.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const choose = (modelId: string) => {
    onValueChange(modelId);
    setOpen(false);
    setSearch('');
    setNotice('');
  };
  const create = () => {
    setOpen(false);
    setCreating(true);
  };

  return (
    <div
      className="grid min-w-0 gap-2"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <div className="relative">
        <Input
          id={controlId}
          role="combobox"
          aria-label="对外模型"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          aria-required={required}
          value={open ? search : value}
          disabled={disabled}
          autoComplete="off"
          placeholder={models.isPending ? '正在读取模型…' : '搜索并选择对外模型'}
          onFocus={() => {
            setSearch('');
            setActive(0);
            setOpen(true);
          }}
          onClick={() => setOpen(true)}
          onChange={(event) => {
            setSearch(event.currentTarget.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && open) {
              setOpen(false);
              event.stopPropagation();
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setOpen(true);
              setActive((index) =>
                options.length
                  ? (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
                  : 0,
              );
            }
            if (event.key === 'Enter' && open) {
              event.preventDefault();
              if (options[active]) choose(options[active]);
            }
          }}
        />
        {open && !disabled && (
          <div className="absolute z-40 mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg">
            <div
              id={listId}
              role="listbox"
              aria-label="对外模型候选"
              className="max-h-64 overflow-y-auto p-1"
            >
              {options.map((modelId, index) => (
                <button
                  key={modelId}
                  id={`${listId}-${index}`}
                  type="button"
                  tabIndex={-1}
                  role="option"
                  aria-selected={modelId === value}
                  className={`block w-full rounded px-3 py-2 text-left text-sm ${index === active ? 'bg-[var(--color-accent-soft)]' : ''}`}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(modelId)}
                >
                  <ModelIdentity modelId={modelId} />
                </button>
              ))}
              {options.length === 0 && (
                <p className="px-3 py-2 console-muted">
                  {models.isPending ? '正在读取模型…' : '未找到匹配模型，可点击下方新增对外模型。'}
                </p>
              )}
            </div>
            <Button
              variant="ghost"
              className="w-full justify-start border-t border-[var(--color-border)]"
              onMouseDown={(event) => event.preventDefault()}
              onClick={create}
            >
              新增对外模型
            </Button>
          </div>
        )}
      </div>
      {!open && (
        <div className="flex justify-end">
          <Button size="sm" variant="outline" disabled={disabled} onClick={create}>
            新增对外模型
          </Button>
        </div>
      )}
      {models.isError && (
        <ApiErrorNotice
          error={models.error}
          onRetry={() => {
            void models.refetch();
          }}
        />
      )}
      {hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          busy={isFetchingNextPage}
          onClick={() => {
            void fetchNextPage();
          }}
        >
          加载更多模型
        </Button>
      )}
      {notice && (
        <p role="status" className="console-muted">
          {notice}
        </p>
      )}
      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title="新增对外模型"
        description="保存模型目录条目后会自动选中，渠道映射仍需单独保存。"
      >
        <div onSubmit={(event) => event.stopPropagation()}>
          <ModelForm
            client={client}
            initialPublicModelId={search}
            onCancel={() => setCreating(false)}
            onSaved={(model) => {
              setCreatedIds((current) => [...current, model.publicModelId]);
              choose(model.publicModelId);
              setCreating(false);
              setNotice('对外模型已创建并选中，请继续保存渠道映射。');
              queryClient.setQueryData(
                adminModelsQueryKeys.detail(actorId, model.publicModelId),
                model,
              );
              void queryClient.invalidateQueries({ queryKey: adminModelsQueryKeys.lists(actorId) });
            }}
          />
        </div>
      </Dialog>
    </div>
  );
}
