import { Button } from '../../../shared/ui/Button';
import { Field } from '../../../shared/ui/Field';
import { Select } from '../../../shared/ui/Select';
import type { SelectOption } from '../../../shared/ui/Select';
import type { useModelSelection } from '../hooks/useModelSelection';

export interface ModelPickerProps {
  readonly selection: ReturnType<typeof useModelSelection>;
  readonly disabled?: boolean;
}

/** Authorized model controls with a visible explanation when a saved choice has expired. */
export function ModelPicker({ selection, disabled = false }: ModelPickerProps) {
  const {
    groups,
    selection: current,
    selectedGroup,
    selectedModel,
    available,
    unavailableReason,
    loading,
    refreshing,
    error,
    errorMessage,
    retry,
    selectGroup,
    selectModel,
  } = selection;
  const groupItems: SelectOption[] = groups.map(group => ({ value: group.id, label: group.name }));
  if (current?.groupId && !groups.some(group => group.id === current.groupId)) {
    groupItems.push({ value: current.groupId, label: `${current.groupId}（不可用）`, disabled: true });
  }
  const seenModelIds = new Set<string>();
  const modelItems: SelectOption[] = (selectedGroup?.models ?? []).flatMap(model => {
    if (seenModelIds.has(model.publicModelId)) return [];
    seenModelIds.add(model.publicModelId);
    return [{ value: model.publicModelId, label: model.publicModelId }];
  });
  if (current?.modelId && !modelItems.some(model => model.value === current.modelId)) {
    modelItems.push({ value: current.modelId, label: `${current.modelId}（不可用）`, disabled: true });
  }

  return (
    <section aria-label="模型选择" className="grid w-full min-w-0 grid-cols-2 gap-3 rounded-xl border border-[var(--color-line)] bg-white/70 p-3 sm:grid-cols-[minmax(10rem,0.8fr)_minmax(12rem,1.2fr)]">
      <Field className="min-w-0" label="模型组" {...(selectedGroup ? { description: `计费倍率 ${selectedGroup.billingMultiplier}×` } : {})}>
        <Select
          aria-label="模型组"
          className="min-w-0"
          disabled={disabled || loading || groupItems.length === 0}
          items={groupItems}
          onValueChange={selectGroup}
          placeholder={loading ? '正在读取模型…' : '选择模型组'}
          {...(current?.groupId ? { value: current.groupId } : {})}
        />
      </Field>
      <Field className="min-w-0" label="模型" {...(selectedModel ? {
        description: selectedModel.maxOutputTokens === undefined
          ? '最大输出由服务端策略决定'
          : `最大输出 ${selectedModel.maxOutputTokens.toLocaleString()} tokens`,
      } : {})}>
        <Select
          aria-label="模型"
          className="min-w-0"
          disabled={disabled || loading || !selectedGroup || modelItems.length === 0}
          items={modelItems}
          onValueChange={selectModel}
          placeholder={selectedGroup ? '选择模型' : '请先选择模型组'}
          {...(current?.modelId ? { value: current.modelId } : {})}
        />
      </Field>
      {unavailableReason && current !== null ? (
        <p className="col-span-2 text-xs text-[var(--color-destructive)] sm:col-span-2" role="status">
          {unavailableReason}
        </p>
      ) : null}
      {error ? (
        <div className="col-span-2 flex items-center justify-between gap-3 text-xs text-[var(--color-destructive)] sm:col-span-2" role="alert">
          <span>{errorMessage}</span>
          <Button disabled={loading} onClick={() => void retry()} size="sm" variant="ghost">
            重试
          </Button>
        </div>
      ) : null}
      {!error && (loading || refreshing) ? (
        <p className="col-span-2 text-xs text-[var(--color-muted-foreground)] sm:col-span-2" role="status">
          {loading ? '正在读取授权模型…' : '正在更新授权模型…'}
        </p>
      ) : null}
      {available && selectedModel ? (
        <p className="sr-only" aria-live="polite">
          已选择 {selectedGroup?.name} 中的 {selectedModel.publicModelId}
        </p>
      ) : null}
    </section>
  );
}
