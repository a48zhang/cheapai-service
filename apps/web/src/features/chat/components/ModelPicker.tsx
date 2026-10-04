import { Button } from '../../../shared/ui/Button';
import { Select } from '../../../shared/ui/Select';
import type { SelectOption } from '../../../shared/ui/Select';
import { formatUsdPerMillionTokens } from '../../../shared/lib/model-price';
import type { ChatModelOption } from '../model/model-options';
import { modelOptionKey } from '../model/model-options';
import type { useModelSelection } from '../hooks/useModelSelection';

export interface ModelPickerProps {
  readonly selection: ReturnType<typeof useModelSelection>;
  readonly disabled?: boolean;
}

function displayName(option: ChatModelOption, duplicate: boolean): string {
  return duplicate ? `${option.modelId} · ${option.group.name}` : option.modelId;
}

function priceDescription(option: ChatModelOption): string {
  return `输入 ${formatUsdPerMillionTokens(option.model.sellPrices?.input, option.group.billingMultiplier)} · 输出 ${formatUsdPerMillionTokens(option.model.sellPrices?.output, option.group.billingMultiplier)}`;
}

/** One selector keeps each authorized group/model pair distinct. */
export function ModelPicker({ selection, disabled = false }: ModelPickerProps) {
  const {
    groups,
    options,
    selection: current,
    selectedOption,
    available,
    unavailableReason,
    loading,
    refreshing,
    error,
    errorMessage,
    retry,
    selectOption,
  } = selection;
  const counts = new Map<string, number>();
  for (const option of options) counts.set(option.modelId, (counts.get(option.modelId) ?? 0) + 1);

  const items: SelectOption[] = options.map((option) => ({
    value: option.key,
    label: (
      <span className="grid min-w-0 gap-0.5">
        <span className="truncate">
          {displayName(option, (counts.get(option.modelId) ?? 0) > 1)}
        </span>
        <span className="truncate text-xs text-[var(--color-muted-foreground)]">
          {priceDescription(option)}
        </span>
      </span>
    ),
  }));

  const currentKey =
    current !== null && current.groupId !== null && current.modelId !== null
      ? modelOptionKey(current.groupId, current.modelId)
      : undefined;
  if (currentKey && !items.some((item) => item.value === currentKey)) {
    const previousGroup = groups.find((group) => group.id === current?.groupId);
    const previousLabel =
      previousGroup === undefined
        ? `${current?.modelId ?? ''}（不可用）`
        : `${current?.modelId ?? ''} · ${previousGroup.name}（不可用）`;
    items.push({ value: currentKey, label: previousLabel, disabled: true });
  }

  const soleAvailableOption =
    options.length === 1 && selectedOption?.key === options[0]?.key ? options[0] : undefined;
  const staticLabel = soleAvailableOption
    ? displayName(soleAvailableOption, false)
    : selectedOption
      ? displayName(selectedOption, (counts.get(selectedOption.modelId) ?? 0) > 1)
      : current?.modelId
        ? `${current.modelId}（不可用）`
        : null;

  return (
    <section aria-label="模型选择" className="grid w-full min-w-0 gap-2">
      <div className="grid min-w-0 gap-1.5">
        <span className="text-sm font-medium text-[var(--color-foreground)]">模型</span>
        {soleAvailableOption ? (
          <div
            aria-label="当前模型"
            className="grid min-h-10 min-w-0 gap-0.5 rounded-md border border-[var(--color-border)] bg-[var(--color-muted)] px-3 py-2 text-sm"
            role="group"
          >
            <span className="truncate">{staticLabel}</span>
          </div>
        ) : options.length > 0 ? (
          <Select
            aria-label="模型"
            className="min-w-0"
            disabled={disabled || loading}
            items={items}
            onValueChange={selectOption}
            placeholder={loading ? '正在加载模型…' : '选择模型'}
            {...(currentKey === undefined ? {} : { value: currentKey })}
          />
        ) : (
          <p
            aria-label="当前模型"
            className="min-h-10 rounded-md border border-[var(--color-border)] bg-[var(--color-muted)] px-3 py-2 text-sm text-[var(--color-muted-foreground)]"
            role="status"
          >
            {loading ? '正在加载模型…' : (staticLabel ?? '暂无可用模型')}
          </p>
        )}
      </div>
      {soleAvailableOption ? (
        <details className="text-xs text-[var(--color-muted-foreground)]">
          <summary className="w-fit cursor-pointer select-none">查看价格</summary>
          <p className="pt-1">{priceDescription(soleAvailableOption)}</p>
        </details>
      ) : null}
      {unavailableReason && current !== null ? (
        <p className="text-xs text-[var(--color-destructive)]" role="status">
          {unavailableReason}
        </p>
      ) : null}
      {error ? (
        <div
          className="flex items-center justify-between gap-3 text-xs text-[var(--color-destructive)]"
          role="alert"
        >
          <span>{errorMessage}</span>
          <Button disabled={loading} onClick={() => void retry()} size="sm" variant="ghost">
            重试
          </Button>
        </div>
      ) : null}
      {!error && (loading || refreshing) ? (
        <p className="text-xs text-[var(--color-muted-foreground)]" role="status">
          {loading ? '正在加载模型…' : '正在更新模型…'}
        </p>
      ) : null}
      {available && selectedOption ? (
        <p className="sr-only" aria-live="polite">
          已选择 {selectedOption.group.name} 中的 {selectedOption.modelId}
        </p>
      ) : null}
    </section>
  );
}
