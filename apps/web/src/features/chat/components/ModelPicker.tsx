import { useState } from 'react';
import { Check, ChevronDown, RefreshCw, Search } from 'lucide-react';
import { Button } from '../../../shared/ui/Button';
import * as Popover from '@radix-ui/react-popover';
import { formatUsdPerMillionTokens } from '../../../shared/lib/model-price';
import type { useModelSelection } from '../hooks/useModelSelection';

export interface ModelPickerProps {
  readonly selection: ReturnType<typeof useModelSelection>;
  readonly disabled?: boolean;
}

/** Search authorized group/model pairs and expose prices on demand. */
export function ModelPicker({ selection, disabled = false }: ModelPickerProps) {
  const { options, selectedOption, loading, refreshing, error, retry, selectOption } = selection;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const query = search.trim().toLocaleLowerCase();
  const filtered = options.filter((option) =>
    `${option.modelId} ${option.group.name}`.toLocaleLowerCase().includes(query),
  );
  const duplicate =
    selectedOption &&
    options.some(
      (option) => option.key !== selectedOption.key && option.modelId === selectedOption.modelId,
    );
  const name = selectedOption
    ? `${selectedOption.modelId}${duplicate ? ` · ${selectedOption.group.name}` : ''}`
    : selection.selection?.modelId
      ? `${selection.selection.modelId}（不可用）`
      : '选择模型';
  const single = options.length === 1 && selectedOption?.key === options[0]?.key;

  const message = error
    ? '模型读取失败，请重试。'
    : loading
      ? '正在加载模型…'
      : options.length === 0
        ? '暂无可用模型，请联系管理员开通模型权限。'
        : !selectedOption
          ? '原模型已不可用，请切换模型。'
          : null;

  return (
    <section aria-label="模型选择" className="chat-model-control">
      {single ? (
        <div role="group" aria-label="当前模型" className="chat-model-current" title={name}>
          <span>{name}</span>
        </div>
      ) : options.length > 0 ? (
        <Popover.Root
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) setSearch('');
          }}
        >
          <Popover.Trigger asChild>
            <button
              type="button"
              className="chat-model-trigger"
              disabled={disabled || loading}
              aria-label="切换模型"
              title={name}
            >
              <span>{name}</span>
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              aria-label="选择模型"
              className="chat-theme chat-model-popover"
              side="top"
              align="start"
              sideOffset={8}
              collisionPadding={12}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
                const items = Array.from(
                  event.currentTarget.querySelectorAll<HTMLElement>('input, button:not(:disabled)'),
                );
                const index = items.indexOf(document.activeElement as HTMLElement);
                const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
                event.preventDefault();
                items[(next + items.length) % items.length]?.focus();
              }}
            >
              <div className="chat-model-search">
                <Search size={17} aria-hidden="true" />
                <input
                  autoFocus
                  aria-label="搜索模型"
                  placeholder="搜索模型或访问组…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              <div className="chat-model-options" aria-label="可用模型">
                {filtered.map((option) => {
                  const inputPrice = formatUsdPerMillionTokens(
                    option.model.sellPrices?.input,
                    option.group.billingMultiplier,
                  );
                  const outputPrice = formatUsdPerMillionTokens(
                    option.model.sellPrices?.output,
                    option.group.billingMultiplier,
                  );
                  const compactPrice = (price: string) =>
                    price === '价格暂不可用' ? '—' : price.replace(' / 百万 Token', '/m');
                  const showGroup = options.some(
                    (other) => other.key !== option.key && other.modelId === option.modelId,
                  );
                  return (
                    <button
                      type="button"
                      key={option.key}
                      className="chat-model-option"
                      aria-pressed={selectedOption?.key === option.key}
                      title={`${option.modelId} · ${option.group.name}\n输入 ${inputPrice} · 输出 ${outputPrice}`}
                      disabled={disabled || loading}
                      onClick={() => {
                        selectOption(option.key);
                        setOpen(false);
                        setSearch('');
                      }}
                    >
                      <span className="chat-model-icon-slot" aria-hidden="true" />
                      <span className="chat-model-name">
                        <span>{option.modelId}</span>
                        <span className={showGroup ? 'chat-model-group' : 'sr-only'}>
                          {option.group.name}
                        </span>
                      </span>
                      <span
                        className="chat-model-price-tag"
                        aria-label={`输入 ${inputPrice}，输出 ${outputPrice}`}
                      >
                        读 {compactPrice(inputPrice)} · 写 {compactPrice(outputPrice)}
                      </span>
                      <span className="chat-model-check" aria-hidden="true">
                        {selectedOption?.key === option.key && <Check size={14} />}
                      </span>
                    </button>
                  );
                })}
                {filtered.length === 0 && (
                  <p className="chat-model-no-results" role="status">
                    没有匹配的模型，试试其他关键词。
                  </p>
                )}
              </div>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      ) : null}
      {message && (
        <div className="chat-model-status" role={error ? 'alert' : 'status'}>
          <span>{message}</span>
          {!loading && (error || options.length === 0) && (
            <Button
              aria-label="刷新模型"
              variant="ghost"
              size="sm"
              disabled={refreshing || disabled}
              onClick={() => void retry()}
            >
              <RefreshCw size={13} aria-hidden="true" />
              {refreshing ? '刷新中' : '刷新'}
            </Button>
          )}
        </div>
      )}
      {!error && refreshing && (
        <span className="chat-model-rate" role="status">
          正在更新模型…
        </span>
      )}
      {selectedOption && (
        <p className="sr-only" aria-live="polite">
          已选择 {selectedOption.group.name} 中的 {selectedOption.modelId}
        </p>
      )}
    </section>
  );
}
