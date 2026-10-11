import { useState } from 'react';
import type { ModelMappingView, Protocol } from '@cheapai/api-client/mappings';
import type { ApiClient } from '@cheapai/api-client/types';
import { Controller } from 'react-hook-form';
import { ChannelPicker } from '../../shared/catalog/ChannelPicker';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';
import { Select } from '../../shared/ui/Select';
import { Button } from '../../shared/ui/Button';
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
  const [editorOpen, setEditorOpen] = useState(false);
  const showEditor =
    Boolean(initialMapping) || editorOpen || (mappings.isSuccess && rows.length === 0);
  const mappingError = mappings.isError
    ? mappings.error instanceof Error
      ? mappings.error.message
      : '映射列表读取失败。'
    : null;
  const optionsSnapshot = channels.data;

  return (
    <section
      className={`grid gap-5 ${showEditor ? 'xl:grid-cols-[minmax(15rem,0.8fr)_minmax(0,1.6fr)]' : ''}`}
    >
      <aside className="grid content-start gap-3 rounded-xl bg-[var(--color-muted)]/40 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">已配置渠道</h3>
            <p className="mt-1 console-muted">{rows.length} 项</p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={saving || mappings.isFetching}
            onClick={() => {
              startCreate();
              setEditorOpen(true);
            }}
          >
            新建
          </Button>
        </div>
        {mappings.isPending && (
          <p role="status" className="console-muted">
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
          <p className="console-muted">此模型尚无渠道映射。</p>
        )}
        {rows.length > 0 && (
          <ul className="grid gap-2" aria-label="现有模型映射">
            {rows.map((mapping) => (
              <li key={mappingKey(mapping)}>
                <button
                  type="button"
                  disabled={saving || mappings.isFetching}
                  aria-current={selectedKey === mappingKey(mapping) ? 'true' : undefined}
                  onClick={() => {
                    chooseMapping(mapping);
                    setEditorOpen(true);
                  }}
                  title={`渠道 ID：${mapping.channelId}`}
                  className={`grid w-full gap-1 rounded-lg border px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] ${selectedKey === mappingKey(mapping) ? 'border-[var(--color-primary)] bg-[var(--color-accent-soft)]' : 'border-[var(--color-border)] hover:bg-[var(--color-muted)]'}`}
                >
                  <span className="break-words font-medium">
                    {optionsSnapshot?.items.find((channel) => channel.id === mapping.channelId)
                      ?.name ??
                      (channels.isError
                        ? '渠道名称读取失败'
                        : channels.isSuccess
                          ? '渠道已删除'
                          : '正在读取渠道名称…')}
                  </span>
                  <span>{protocolLabel(mapping.protocol)}</span>
                  <span className="truncate console-muted">上游：{mapping.upstreamModel}</span>
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

      {showEditor && (
        <form
          className="grid content-start gap-5 min-w-0"
          noValidate
          onSubmit={form.handleSubmit(submit)}
        >
          <div>
            <h3 className="font-semibold">{selected ? '编辑渠道映射' : '创建渠道映射'}</h3>
            <p className="mt-1 console-muted">选择渠道与协议，并填写上游模型名称。</p>
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
              <p className="console-muted">更换协议需新建映射。</p>
              {form.formState.errors.protocol?.message && (
                <p role="alert" className="text-sm text-[var(--color-destructive)]">
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
            <p role="status" className="console-muted">
              {message}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-3">
            {(onCancel || rows.length > 0) && (
              <Button
                variant="outline"
                disabled={saving}
                onClick={() => {
                  if (onCancel) onCancel();
                  else setEditorOpen(false);
                }}
              >
                {onCancel ? '返回' : '取消'}
              </Button>
            )}
            <Button type="submit" busy={saving} disabled={!canSave}>
              {selected ? '保存映射' : '创建映射'}
            </Button>
          </div>
          {!mappings.isSuccess && !mappingError && (
            <p role="status" className="console-muted">
              正在加载映射，加载后可保存。
            </p>
          )}
          {duplicate && <span className="sr-only">请勿创建重复的渠道协议映射。</span>}
        </form>
      )}
    </section>
  );
}
