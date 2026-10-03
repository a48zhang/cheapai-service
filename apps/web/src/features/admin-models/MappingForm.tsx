import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { ApiClientError } from '@cheapai/api-client/errors';
import type { ChannelCapabilities, ModelMappingView, Protocol } from '@cheapai/api-client/mappings';
import { createMappingsApi } from '@cheapai/api-client/mappings';
import type { ApiClient } from '@cheapai/api-client/types';
import { CAPABILITY_FEATURES, capabilityFeatureSchema, modelMappingInputSchema, protocolSchema } from '@cheapai/contracts/mappings';
import { builtinModel } from '@cheapai/model-catalog';
import { ChannelPicker } from '../../shared/catalog/ChannelPicker';
import { channelOptionsQueryKey, channelOptionsQueryOptions } from '../../shared/catalog/channel-options';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';
import { Select } from '../../shared/ui/Select';
import { Button } from '../../shared/ui/Button';
import { CapabilityFields } from './CapabilityFields';
import type { CapabilityFieldErrors, CapabilityFieldValues } from './CapabilityFields';
import { invalidateModelMappings, modelMappingsQueryOptions } from './mapping-api';

const capabilityDraftSchema = z.object({
  features: z.array(capabilityFeatureSchema).max(CAPABILITY_FEATURES.length),
  maxOutputTokens: z.string().max(16).refine(value => value === '' || (/^[1-9][0-9]*$/u.test(value) && Number.isSafeInteger(Number(value)))),
  reasoningEfforts: z.string().max(512),
  cacheTtls: z.array(z.enum(['5m', '1h'])).max(2),
  nativeExtensions: z.string().max(2200),
});

const mappingDraftSchema = z.object({
  channelId: z.string().max(128),
  protocol: protocolSchema,
  upstreamModel: z.string().max(128).refine(value => value.trim().length > 0),
  capabilities: capabilityDraftSchema,
}).transform(value => {
  const maxOutputTokens = value.capabilities.maxOutputTokens === '' ? undefined : Number(value.capabilities.maxOutputTokens);
  const reasoningEfforts = value.capabilities.reasoningEfforts.split(/[\s,]+/u).filter(Boolean);
  const extensions = value.capabilities.nativeExtensions.split(/\r?\n/u).map(line => line.trim()).filter(Boolean).map(line => {
    const separator = line.indexOf(':');
    return separator < 0
      ? { scope: line, name: '' }
      : { scope: line.slice(0, separator), name: line.slice(separator + 1) };
  });
  const capabilities = {
    protocol: value.protocol,
    features: value.capabilities.features,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(reasoningEfforts.length === 0 ? {} : { reasoningEfforts }),
    ...(value.capabilities.cacheTtls.length === 0 ? {} : { cacheTtls: value.capabilities.cacheTtls }),
    ...(extensions.length === 0 ? {} : { nativeExtensions: extensions }),
  };
  return modelMappingInputSchema.parse({
    channelId: value.channelId,
    protocol: value.protocol,
    upstreamModel: value.upstreamModel.trim(),
    capabilities,
  });
});

type MappingFormValues = z.input<typeof mappingDraftSchema>;
type MappingFormOutput = z.output<typeof mappingDraftSchema>;

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

function emptyCapabilities(features: CapabilityFieldValues['features'] = []): CapabilityFieldValues {
  return { features: [...features], maxOutputTokens: '', reasoningEfforts: '', cacheTtls: [], nativeExtensions: '' };
}

function initialValues(publicModelId: string, mapping?: ModelMappingView): MappingFormValues {
  const reference = mapping ? undefined : builtinModel(publicModelId);
  const capabilities = mapping?.capabilities;
  return {
    channelId: mapping?.channelId ?? '',
    protocol: mapping?.protocol ?? reference?.protocol ?? 'chat',
    upstreamModel: mapping?.upstreamModel ?? reference?.id ?? publicModelId,
    capabilities: capabilities ? {
      features: [...capabilities.features],
      maxOutputTokens: capabilities.maxOutputTokens === undefined ? '' : String(capabilities.maxOutputTokens),
      reasoningEfforts: capabilities.reasoningEfforts?.join(', ') ?? '',
      cacheTtls: [...(capabilities.cacheTtls ?? [])],
      nativeExtensions: capabilities.nativeExtensions?.map(extension => `${extension.scope}:${extension.name}`).join('\n') ?? '',
    } : emptyCapabilities(reference ? ['tools'] : []),
  };
}

function issueText(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('message' in value)) return undefined;
  return typeof value.message === 'string' ? value.message : undefined;
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

function mappingKey(mapping: Pick<ModelMappingView, 'channelId' | 'protocol'>): string {
  return `${mapping.channelId}\u0000${mapping.protocol}`;
}

function protocolLabel(protocol: Protocol): string {
  return protocols.find(item => item.value === protocol)?.label ?? protocol;
}

/** Mapping editor keeps the current input across independent mapping and channel reloads. */
export function MappingForm({ client, actorId, sessionEpoch, publicModelId, initialMapping, onSaved, onCancel }: MappingFormProps) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<ModelMappingView | null>(initialMapping ?? null);
  const initializedMappingKey = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [channelPickerOpen, setChannelPickerOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<Error | null>(null);
  const api = useMemo(() => createMappingsApi(client), [client]);
  const mappings = useQuery(modelMappingsQueryOptions({ client, actorId }, publicModelId));
  const channels = useQuery(channelOptionsQueryOptions(client, actorId, sessionEpoch, channelPickerOpen));
  const rows = useMemo(() => mappings.data?.items ?? [], [mappings.data]);
  const form = useForm<MappingFormValues, unknown, MappingFormOutput>({
    resolver: zodResolver<MappingFormValues, unknown, MappingFormOutput>(mappingDraftSchema),
    defaultValues: initialValues(publicModelId, initialMapping),
  });
  useEffect(() => {
    if (!initialMapping) return;
    const initialKey = mappingKey(initialMapping);
    const key = `${publicModelId}\u0000${initialKey}`;
    if (initializedMappingKey.current === key) return;
    const current = rows.find(item => mappingKey(item) === initialKey);
    if (!current) return;
    initializedMappingKey.current = key;
    setSelected(current);
    setNeedsRefresh(false);
    setSaveError(null);
    form.reset(initialValues(publicModelId, current));
  }, [form, initialMapping, publicModelId, rows]);
  const watchedProtocol = form.watch('protocol');
  const selectedKey = selected ? mappingKey(selected) : null;
  const latestSelected = selectedKey === null ? null : rows.find(item => mappingKey(item) === selectedKey) ?? null;
  const versionChanged = latestSelected !== null && selected !== null && latestSelected.configVersion !== selected.configVersion;
  const currentChannelId = form.watch('channelId');
  const duplicate = !selected && currentChannelId.length > 0 && rows.some(item => item.channelId === currentChannelId && item.protocol === watchedProtocol);
  const channelsComplete = channels.isSuccess && !channels.isFetching && !channels.isError;
  const canSave = mappings.isSuccess && !mappings.isFetching && !mappings.isError
    && (selected !== null || channelsComplete) && !saving && !needsRefresh && !versionChanged && !duplicate;

  function setChannelPickerVisibility(open: boolean) {
    setChannelPickerOpen(open);
    if (!open) void queryClient.cancelQueries({ queryKey: channelOptionsQueryKey(actorId, sessionEpoch), exact: true });
  }

  function startCreate() {
    if (saving) return;
    setSelected(null);
    setNeedsRefresh(false);
    setSaveError(null);
    setMessage(null);
    form.reset(initialValues(publicModelId));
  }

  function chooseMapping(mapping: ModelMappingView) {
    if (saving) return;
    setSelected(mapping);
    setNeedsRefresh(false);
    setSaveError(null);
    setMessage(null);
    form.reset(initialValues(publicModelId, mapping));
  }

  async function retryMappings() {
    const result = await mappings.refetch();
    if (result.isSuccess) {
      setNeedsRefresh(false);
      setSaveError(null);
      setMessage('已重新读取映射。输入内容已保留；如版本改变，请核对后明确选择新版本。');
    }
  }

  async function submit(values: MappingFormOutput) {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    setMessage(null);
    try {
      let saved: ModelMappingView;
      if (selected) {
        if (selected.protocol !== values.protocol || selected.channelId !== values.channelId) {
          throw new TypeError('编辑现有映射时不能变更渠道或协议。');
        }
        const baseline = latestSelected ?? selected;
        const patch: { upstreamModel?: string; capabilities?: ChannelCapabilities } = {};
        if (baseline.upstreamModel !== values.upstreamModel) patch.upstreamModel = values.upstreamModel;
        if (JSON.stringify(baseline.capabilities) !== JSON.stringify(values.capabilities)) patch.capabilities = values.capabilities;
        if (Object.keys(patch).length === 0) {
          setMessage('没有需要保存的更改。');
          return;
        }
        saved = await api.updateMapping(publicModelId, selected.channelId, selected.protocol, selected.configVersion, patch);
      } else {
        saved = await api.createMapping(publicModelId, values);
      }
      setSelected(saved);
      setNeedsRefresh(false);
      setMessage('模型映射已保存。');
      form.reset(initialValues(publicModelId, saved));
      await invalidateModelMappings(queryClient, actorId, publicModelId);
      onSaved?.(saved);
    } catch (error) {
      setNeedsRefresh(true);
      const conflict = error instanceof ApiClientError && error.status === 409;
      setSaveError(new Error(conflict
        ? '映射配置版本已变化。请重新读取映射并核对；当前输入已保留。'
        : error instanceof Error ? `${error.message} 保存结果可能未确认；请重新读取映射后再继续。当前输入已保留。`
          : '保存结果未确认；请重新读取映射后再继续。当前输入已保留。'));
    } finally {
      setSaving(false);
    }
  }

  function retainDraftOnLatestVersion() {
    if (!latestSelected || !versionChanged) return;
    setSelected(latestSelected);
    setNeedsRefresh(false);
    setSaveError(null);
    setMessage(`已选用服务端映射 v${latestSelected.configVersion}，并保留当前输入。请确认上方字段后保存。`);
  }

  const mappingError = mappings.isError
    ? mappings.error instanceof Error ? mappings.error.message : '映射列表读取失败。'
    : null;
  const optionsSnapshot = channels.data;

  return <section className="grid gap-5 xl:grid-cols-[minmax(15rem,0.8fr)_minmax(0,1.6fr)]">
    <aside className="grid content-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">渠道映射</h3>
          <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">{rows.length} 项 · 映射配置有独立版本</p>
        </div>
        <Button size="sm" variant="outline" disabled={saving || mappings.isFetching} onClick={startCreate}>新建</Button>
      </div>
      {mappings.isPending && <p role="status" className="text-sm text-[var(--color-muted-foreground)]">正在读取模型映射…</p>}
      {mappingError && <div className="grid gap-2" role="alert">
        <p className="text-sm text-[var(--color-destructive)]">映射列表暂不可用，保存已暂停。{mappingError}</p>
        <Button size="sm" variant="secondary" disabled={mappings.isFetching} onClick={() => { void retryMappings(); }}>重试读取映射</Button>
      </div>}
      {mappings.isSuccess && rows.length === 0 && <p className="text-sm text-[var(--color-muted-foreground)]">此模型尚无渠道映射。</p>}
      {rows.length > 0 && <ul className="grid gap-2" aria-label="现有模型映射">
        {rows.map(mapping => <li key={mappingKey(mapping)}>
          <button
            type="button"
            disabled={saving || mappings.isFetching}
            aria-current={selectedKey === mappingKey(mapping) ? 'true' : undefined}
            onClick={() => chooseMapping(mapping)}
            className={`grid w-full gap-1 rounded-lg border px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] ${selectedKey === mappingKey(mapping) ? 'border-[var(--color-primary)] bg-[var(--color-accent-soft)]' : 'border-[var(--color-border)] hover:bg-[var(--color-muted)]'}`}
          >
            <span className="break-all font-mono text-xs">{mapping.channelId}</span>
            <span>{protocolLabel(mapping.protocol)} · v{mapping.configVersion}</span>
            <span className="truncate text-xs text-[var(--color-muted-foreground)]">上游：{mapping.upstreamModel}</span>
          </button>
        </li>)}
      </ul>}
      {mappings.isSuccess && <Button size="sm" variant="ghost" disabled={mappings.isFetching || saving} onClick={() => { void retryMappings(); }}>重新读取映射</Button>}
      {versionChanged && latestSelected && <div className="grid gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" role="alert">
        <p>此映射已更新到 v{latestSelected.configVersion}；表单仍保留当前输入。检查两边的字段后，可明确采用新版本并保留当前输入。</p>
        <Button size="sm" variant="secondary" disabled={saving || mappings.isFetching} onClick={retainDraftOnLatestVersion}>采用 v{latestSelected.configVersion}，保留输入</Button>
      </div>}
      {channels.isError && <ApiErrorNotice
        error={channels.error}
        onRetry={() => { void channels.refetch(); }}
      />}
    </aside>

    <form className="grid content-start gap-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5" noValidate onSubmit={form.handleSubmit(submit)}>
      <div>
        <h3 className="font-semibold">{selected ? '编辑渠道映射' : '创建渠道映射'}</h3>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">关联目标渠道与协议，再声明该渠道可路由的上游模型和能力。</p>
      </div>
      <fieldset disabled={saving || mappings.isPending || mappings.isError || mappings.isFetching} className="grid gap-5">
        <Controller
          name="channelId"
          control={form.control}
          render={({ field }) => <ChannelPicker
            label="关联渠道"
            value={field.value ? [field.value] : []}
            onValueChange={ids => field.onChange(ids[0] ?? '')}
            onOpenChange={setChannelPickerVisibility}
            candidates={optionsSnapshot}
            loading={channels.isPending || channels.isFetching}
            {...(channels.isError ? { error: channels.error } : {})}
            onRetry={() => { void channels.refetch(); }}
            maxSelected={1}
            disabled={Boolean(selected) || saving || needsRefresh}
          />}
        />
        <div className="grid gap-1.5">
          <label htmlFor="mapping-protocol" className="text-sm font-medium text-[var(--color-foreground)]">协议 <span aria-hidden="true" className="text-[var(--color-destructive)]">*</span></label>
          <Controller
            name="protocol"
            control={form.control}
            render={({ field }) => <Select
              id="mapping-protocol"
              value={field.value}
              items={protocols}
              required
              disabled={Boolean(selected) || saving || needsRefresh}
              onValueChange={field.onChange}
              aria-label="协议"
              aria-invalid={Boolean(form.formState.errors.protocol)}
            />}
          />
          <p className="text-xs text-[var(--color-muted-foreground)]">协议不可在编辑现有映射时更换；如需另一协议，请新建独立映射。</p>
          {form.formState.errors.protocol?.message && <p role="alert" className="text-xs text-[var(--color-destructive)]">{form.formState.errors.protocol.message}</p>}
        </div>
        <Field label="上游模型名称" required error={form.formState.errors.upstreamModel?.message} description="填写此渠道实际接受的上游模型 ID。">
          <Input {...form.register('upstreamModel')} required autoComplete="off" maxLength={128} placeholder="例如 vendor-model-v2" />
        </Field>
        <Controller
          name="capabilities"
          control={form.control}
          render={({ field, fieldState }) => <CapabilityFields
            protocol={watchedProtocol}
            value={field.value}
            errors={capabilityErrors(fieldState.error)}
            disabled={saving || needsRefresh}
            onChange={field.onChange}
          />}
        />
      </fieldset>
      {duplicate && <p role="alert" className="text-sm text-[var(--color-destructive)]">此渠道与协议已存在映射。请从左侧选择现有映射进行编辑。</p>}
      {needsRefresh && <ApiErrorNotice error={saveError ?? new Error('请重新读取映射；读取成功后才能再次提交。')} />}
      {!needsRefresh && saveError && <ApiErrorNotice error={saveError} />}
      {message && <p role="status" className="text-sm text-[var(--color-muted-foreground)]">{message}</p>}
      <div className="flex flex-wrap justify-end gap-3">
        {onCancel && <Button variant="outline" disabled={saving} onClick={onCancel}>返回</Button>}
        <Button type="submit" busy={saving} disabled={!canSave}>{selected ? '保存映射' : '创建映射'}</Button>
      </div>
      {!mappings.isSuccess && !mappingError && <p role="status" className="text-xs text-[var(--color-muted-foreground)]">首次读取模型映射成功前，不能提交配置。</p>}
      {channels.isError && <p className="text-xs text-[var(--color-muted-foreground)]">渠道候选读取失败不会清空当前渠道，也不会影响映射列表的独立重试。</p>}
      {selected && <p className="text-xs text-[var(--color-muted-foreground)]">当前映射版本：configVersion v{selected.configVersion}。渠道与协议保持不变。</p>}
      {duplicate && <span className="sr-only">请勿创建重复的渠道协议映射。</span>}
    </form>
  </section>;
}
