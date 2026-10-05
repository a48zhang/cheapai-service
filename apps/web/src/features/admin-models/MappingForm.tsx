import type { ModelMappingView, Protocol } from '@cheapai/api-client/mappings';
import type { ApiClient } from '@cheapai/api-client/types';
import { Controller } from 'react-hook-form';
import { ChannelPicker } from '../../shared/catalog/ChannelPicker';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';
import { Select } from '../../shared/ui/Select';
import { Button } from '../../shared/ui/Button';
import { CapabilityFields } from './CapabilityFields';
import type { CapabilityFieldErrors } from './CapabilityFields';
import { mappingKey } from './mapping-form-model';
import { useMappingForm } from './useMappingForm';

export interface MappingFormProps {
  readonly client: ApiClient;
  readonly actorId: string;
  readonly sessionEpoch: number;
  readonly publicModelId: string;
  /** Opens a specific mapping when a parent detail panel has already identified it. */
  readonly initialMapping?: ModelMappingView | undefined;
  readonly onSaved?: ((mapping: ModelMappingView) => void) | undefined;
  readonly onCancel?: (() => void) | undefined;
}

const protocols = [
  { value: 'chat', label: 'Chat Completions' },
  { value: 'responses', label: 'Responses' },
  { value: 'messages', label: 'Messages' },
] as const;

function issueText(value: unknown, seen = new WeakSet<object>()): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if ('message' in value && typeof value.message === 'string') return value.message;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'ref') continue;
    const message = issueText(child, seen);
    if (message) return message;
  }
  return undefined;
}

function capabilityErrors(value: unknown): CapabilityFieldErrors {
  if (typeof value !== 'object' || value === null) return {};
  const fields = value as Record<string, unknown>;
  return {
    features: issueText(fields.features),
    maxOutputTokens: issueText(fields.maxOutputTokens),
    reasoningEfforts: issueText(fields.reasoningEfforts),
    cacheTtls: issueText(fields.cacheTtls),
    nativeExtensions: issueText(fields.nativeExtensions),
  };
}

function protocolLabel(protocol: Protocol): string {
  return protocols.find((item) => item.value === protocol)?.label ?? protocol;
}

/** Mapping editor keeps the current input across independent mapping and channel reloads. */
export function MappingForm({
  client,
  actorId,
  sessionEpoch,
  publicModelId,
  initialMapping,
  onSaved,
  onCancel,
}: MappingFormProps) {
  const {
    form,
    mappings,
    channels,
    rows,
    selected,
    selectedKey,
    latestSelected,
    versionChanged,
    duplicate,
    saving,
    needsRefresh,
    message,
    saveError,
    canSave,
    submit,
    startCreate,
    chooseMapping,
    retryMappings,
    retainDraftOnLatestVersion,
    setChannelPickerVisibility,
  } = useMappingForm({ client, actorId, sessionEpoch, publicModelId, initialMapping, onSaved });
  const watchedProtocol = form.watch('protocol');
  const mappingError = mappings.isError
    ? mappings.error instanceof Error
      ? mappings.error.message
      : '映射列表读取失败。'
    : null;
  const optionsSnapshot = channels.data;

  return (
    <section className="grid gap-5 xl:grid-cols-[minmax(15rem,0.8fr)_minmax(0,1.6fr)]">
      <aside className="grid content-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">渠道映射</h3>
            <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">{rows.length} 项</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={saving || mappings.isFetching}
            onClick={startCreate}
          >
            新建
          </Button>
        </div>
        {mappings.isPending && (
          <p role="status" className="text-sm text-[var(--color-muted-foreground)]">
            正在读取模型映射…
          </p>
        )}
        {mappingError && (
          <div className="grid gap-2" role="alert">
            <p className="text-sm text-[var(--color-destructive)]">
              映射列表暂不可用，保存已暂停。{mappingError}
            </p>
            <Button
              size="sm"
              variant="secondary"
              disabled={mappings.isFetching}
              onClick={() => {
                void retryMappings();
              }}
            >
              重试读取映射
            </Button>
          </div>
        )}
        {mappings.isSuccess && rows.length === 0 && (
          <p className="text-sm text-[var(--color-muted-foreground)]">此模型尚无渠道映射。</p>
        )}
        {rows.length > 0 && (
          <ul className="grid gap-2" aria-label="现有模型映射">
            {rows.map((mapping) => (
              <li key={mappingKey(mapping)}>
                <button
                  type="button"
                  disabled={saving || mappings.isFetching}
                  aria-current={selectedKey === mappingKey(mapping) ? 'true' : undefined}
                  onClick={() => chooseMapping(mapping)}
                  className={`grid w-full gap-1 rounded-lg border px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] ${selectedKey === mappingKey(mapping) ? 'border-[var(--color-primary)] bg-[var(--color-accent-soft)]' : 'border-[var(--color-border)] hover:bg-[var(--color-muted)]'}`}
                >
                  <span className="break-all font-mono text-xs">{mapping.channelId}</span>
                  <span>
                    {protocolLabel(mapping.protocol)} · v{mapping.configVersion}
                  </span>
                  <span className="truncate text-xs text-[var(--color-muted-foreground)]">
                    上游：{mapping.upstreamModel}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {mappings.isSuccess && (
          <Button
            size="sm"
            variant="ghost"
            disabled={mappings.isFetching || saving}
            onClick={() => {
              void retryMappings();
            }}
          >
            重新读取映射
          </Button>
        )}
        {versionChanged && latestSelected && (
          <div
            className="grid gap-2 rounded-lg border border-[var(--color-warning-line)] bg-[var(--color-warning-soft)] p-3 text-sm text-[var(--color-warning)]"
            role="alert"
          >
            <p>
              此映射已更新到 v{latestSelected.configVersion}
              ；表单仍保留当前输入。检查两边的字段后，可明确采用新版本并保留当前输入。
            </p>
            <Button
              size="sm"
              variant="secondary"
              disabled={saving || mappings.isFetching}
              onClick={retainDraftOnLatestVersion}
            >
              采用 v{latestSelected.configVersion}，保留输入
            </Button>
          </div>
        )}
        {channels.isError && (
          <ApiErrorNotice
            error={channels.error}
            onRetry={() => {
              void channels.refetch();
            }}
          />
        )}
      </aside>

      <form
        className="grid content-start gap-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
        noValidate
        onSubmit={form.handleSubmit(submit)}
      >
        <div>
          <h3 className="font-semibold">{selected ? '编辑渠道映射' : '创建渠道映射'}</h3>
          <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
            关联目标渠道与协议，再声明该渠道可路由的上游模型和能力。
          </p>
        </div>
        <fieldset
          disabled={saving || mappings.isPending || mappings.isError || mappings.isFetching}
          className="grid gap-5"
        >
          <Controller
            name="channelId"
            control={form.control}
            render={({ field }) => (
              <ChannelPicker
                label="关联渠道"
                value={field.value ? [field.value] : []}
                onValueChange={(ids) => field.onChange(ids[0] ?? '')}
                onOpenChange={setChannelPickerVisibility}
                candidates={optionsSnapshot}
                loading={channels.isPending || channels.isFetching}
                {...(channels.isError ? { error: channels.error } : {})}
                onRetry={() => {
                  void channels.refetch();
                }}
                maxSelected={1}
                disabled={Boolean(selected) || saving || needsRefresh}
              />
            )}
          />
          <div className="grid gap-1.5">
            <label
              htmlFor="mapping-protocol"
              className="text-sm font-medium text-[var(--color-foreground)]"
            >
              协议{' '}
              <span aria-hidden="true" className="text-[var(--color-destructive)]">
                *
              </span>
            </label>
            <Controller
              name="protocol"
              control={form.control}
              render={({ field }) => (
                <Select
                  id="mapping-protocol"
                  value={field.value}
                  items={protocols}
                  required
                  disabled={Boolean(selected) || saving || needsRefresh}
                  onValueChange={field.onChange}
                  aria-label="协议"
                  aria-invalid={Boolean(form.formState.errors.protocol)}
                />
              )}
            />
            <p className="text-xs text-[var(--color-muted-foreground)]">更换协议需新建映射。</p>
            {form.formState.errors.protocol?.message && (
              <p role="alert" className="text-xs text-[var(--color-destructive)]">
                {form.formState.errors.protocol.message}
              </p>
            )}
          </div>
          <Field
            label="上游模型名称"
            required
            error={form.formState.errors.upstreamModel?.message}
            description="填写此渠道实际接受的上游模型 ID。"
          >
            <Input
              {...form.register('upstreamModel')}
              required
              autoComplete="off"
              maxLength={128}
              placeholder="例如 vendor-model-v2"
            />
          </Field>
          <Controller
            name="capabilities"
            control={form.control}
            render={({ field, fieldState }) => (
              <CapabilityFields
                protocol={watchedProtocol}
                value={field.value}
                errors={capabilityErrors(fieldState.error)}
                disabled={saving || needsRefresh}
                onChange={field.onChange}
              />
            )}
          />
        </fieldset>
        {duplicate && (
          <p role="alert" className="text-sm text-[var(--color-destructive)]">
            此渠道与协议已存在映射。请从左侧选择现有映射进行编辑。
          </p>
        )}
        {needsRefresh && (
          <ApiErrorNotice
            error={saveError ?? new Error('请重新读取映射；读取成功后才能再次提交。')}
          />
        )}
        {!needsRefresh && saveError && <ApiErrorNotice error={saveError} />}
        {message && (
          <p role="status" className="text-sm text-[var(--color-muted-foreground)]">
            {message}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-3">
          {onCancel && (
            <Button variant="outline" disabled={saving} onClick={onCancel}>
              返回
            </Button>
          )}
          <Button type="submit" busy={saving} disabled={!canSave}>
            {selected ? '保存映射' : '创建映射'}
          </Button>
        </div>
        {!mappings.isSuccess && !mappingError && (
          <p role="status" className="text-xs text-[var(--color-muted-foreground)]">
            正在加载映射，加载后可保存。
          </p>
        )}
        {duplicate && <span className="sr-only">请勿创建重复的渠道协议映射。</span>}
      </form>
    </section>
  );
}
