import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { ApiClientError } from '@cheapai/api-client/errors';
import type { GroupInput, GroupStatus, GroupView } from '@cheapai/api-client/groups';
import { createGroupsApi } from '@cheapai/api-client/groups';
import type { ApiClient } from '@cheapai/api-client/types';
import { billingMultiplierSchema, groupInputSchema, groupStatusSchema } from '@cheapai/contracts/groups';
import { ChannelPicker } from '../../shared/catalog/ChannelPicker';
import { channelOptionsQueryKey, channelOptionsQueryOptions } from '../../shared/catalog/channel-options';
import type { ChannelOptionsSnapshot } from '../../shared/catalog/channel-options';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';
import { Select } from '../../shared/ui/Select';
import { Button } from '../../shared/ui/Button';
import { groupDetailQueryOptions, invalidateAdminGroups } from './api';

const requiredGroupInputSchema = groupInputSchema.extend({
  status: groupStatusSchema,
  channelIds: groupInputSchema.shape.channelIds.unwrap(),
  billingMultiplier: billingMultiplierSchema,
});

const groupDraftSchema = z.object({
  name: z.string().min(1).max(128).transform(value => value.trim()).pipe(z.string().min(1).max(128)),
  status: groupStatusSchema,
  billingMultiplier: billingMultiplierSchema,
  channelIds: z.array(z.string().min(1).max(128)).max(100),
}).transform(value => requiredGroupInputSchema.parse({
  ...value,
  channelIds: [...new Set(value.channelIds)].sort(),
}));

type GroupFormValues = z.input<typeof groupDraftSchema>;
type GroupFormOutput = z.output<typeof groupDraftSchema>;

export interface GroupFormProps {
  readonly client: ApiClient;
  readonly actorId: string;
  readonly sessionEpoch: number;
  readonly group?: GroupView | undefined;
  readonly onSaved: (group: GroupView) => void;
  readonly onCancel?: (() => void) | undefined;
}

const statusOptions = [
  { value: 'active', label: '已启用' },
  { value: 'disabled', label: '已停用' },
] as const;

function initialValues(group?: GroupView): GroupFormValues {
  return {
    name: group?.name ?? '',
    status: group?.status ?? 'active',
    billingMultiplier: group?.billingMultiplier ?? '1',
    channelIds: group ? [...group.channelIds] : [],
  };
}

function channelIdsMatch(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

/** Group settings keep exact multiplier text and the existing channel IDs across candidate retries. */
export function GroupForm({ client, actorId, sessionEpoch, group, onSaved, onCancel }: GroupFormProps) {
  const queryClient = useQueryClient();
  const api = useMemo(() => createGroupsApi(client), [client]);
  const [channelPickerOpen, setChannelPickerOpen] = useState(false);
  const groupQuery = useQuery({
    ...groupDetailQueryOptions({ client, actorId }, group?.id ?? ''),
    enabled: group !== undefined,
  });
  const channelQuery = useQuery(channelOptionsQueryOptions(client, actorId, sessionEpoch, channelPickerOpen));
  const [baseline, setBaseline] = useState<GroupView | null>(group ?? null);
  const [saving, setSaving] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [saveError, setSaveError] = useState<Error | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const form = useForm<GroupFormValues, unknown, GroupFormOutput>({
    resolver: zodResolver<GroupFormValues, unknown, GroupFormOutput>(groupDraftSchema),
    defaultValues: initialValues(group),
  });
  const channelsComplete = channelQuery.isSuccess && !channelQuery.isFetching && !channelQuery.isError;
  const latestGroup = groupQuery.data ?? group ?? null;
  const versionChanged = baseline !== null && latestGroup !== null && latestGroup.version !== baseline.version;
  const canSave = channelsComplete && !saving && !needsRefresh && !versionChanged && (group === undefined || (groupQuery.isSuccess && !groupQuery.isError));

  async function refreshGroup() {
    if (!group) return;
    const result = await groupQuery.refetch();
    if (result.isSuccess) {
      setNeedsRefresh(false);
      setSaveError(null);
      setFeedback('已重新读取访问组。表单输入已保留；如配置版本变化，请核对后明确采用新版本。');
    }
  }

  function adoptLatestVersion() {
    if (!versionChanged || !latestGroup) return;
    setBaseline(latestGroup);
    setNeedsRefresh(false);
    setSaveError(null);
    setFeedback(`已采用服务端 v${latestGroup.version} 并保留当前输入；保存前请核对配置变更。`);
  }

  async function submit(values: GroupFormOutput) {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    setFeedback(null);
    try {
      let saved: GroupView;
      if (baseline) {
        const patch: { name?: string; status?: GroupStatus; channelIds?: string[]; billingMultiplier?: string } = {};
        if (baseline.name !== values.name) patch.name = values.name;
        if (baseline.status !== values.status) patch.status = values.status;
        if (!channelIdsMatch(baseline.channelIds, values.channelIds)) patch.channelIds = values.channelIds;
        if (baseline.billingMultiplier !== values.billingMultiplier) patch.billingMultiplier = values.billingMultiplier;
        if (Object.keys(patch).length === 0) {
          setFeedback('没有需要保存的更改。');
          return;
        }
        saved = await api.update(baseline.id, baseline.version, patch);
      } else {
        const input: GroupInput = values;
        saved = await api.create(input);
      }
      setBaseline(saved);
      setNeedsRefresh(false);
      setFeedback(baseline ? `访问组已保存，配置版本为 v${saved.version}。` : `访问组已创建，配置版本为 v${saved.version}。`);
      form.reset(initialValues(saved));
      await invalidateAdminGroups(queryClient, actorId);
      onSaved(saved);
    } catch (error) {
      setNeedsRefresh(true);
      const conflict = error instanceof ApiClientError && error.status === 409;
      setSaveError(new Error(conflict
        ? '访问组配置版本已变化，或此更改会破坏最后管理员保护。请重新读取后核对；输入已保留。'
        : error instanceof Error ? `${error.message} 保存结果可能未确认；请重新读取访问组后再继续。输入已保留。`
          : '保存结果未确认；请重新读取访问组后再继续。输入已保留。'));
    } finally {
      setSaving(false);
    }
  }

  const status = form.watch('status');
  const selectedChannelIds = form.watch('channelIds');
  const channelSnapshot = channelQuery.data as ChannelOptionsSnapshot | undefined;
  const groupError = groupQuery.isError ? groupQuery.error : null;

  function setChannelPickerVisibility(open: boolean) {
    setChannelPickerOpen(open);
    if (!open) void queryClient.cancelQueries({ queryKey: channelOptionsQueryKey(actorId, sessionEpoch), exact: true });
  }

  return <form className="grid gap-5" noValidate onSubmit={form.handleSubmit(submit)}>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="访问组名称" required error={form.formState.errors.name?.message} description="用于管理和识别访问规则。">
        <Input {...form.register('name')} required maxLength={128} autoComplete="off" placeholder="例如：团队计划" />
      </Field>
      <Field label="计费倍率" required error={form.formState.errors.billingMultiplier?.message} description="保存精确十进制文本，不做浮点换算；例如 1 或 0.2。">
        <Input {...form.register('billingMultiplier')} required maxLength={64} inputMode="decimal" autoComplete="off" placeholder="1" />
      </Field>
      <div className="grid gap-1.5">
        <label htmlFor="group-status" className="text-sm font-medium text-[var(--color-foreground)]">组状态</label>
        <Controller name="status" control={form.control} render={({ field }) => <Select
          id="group-status"
          aria-label="组状态"
          value={field.value}
          items={statusOptions}
          disabled={saving || needsRefresh}
          onValueChange={field.onChange}
        />} />
        <span className="text-xs text-[var(--color-muted-foreground)]">{status === 'active' ? '启用组保留其当前用户和渠道关联。' : '停用组不再作为有效访问组；服务端会保护最后管理员。'}</span>
      </div>
    </div>

    <div className="rounded-lg border border-[var(--color-border)] p-4">
      <h3 className="font-medium">渠道关联</h3>
      <p className="mb-3 mt-1 text-xs leading-5 text-[var(--color-muted-foreground)]">
        选择此组可关联的渠道。服务端根据组状态、用户归属、模型映射和其他规则决定请求准入；此表单不提供最终授权预览。
      </p>
      <Controller name="channelIds" control={form.control} render={({ field }) => <ChannelPicker
        value={field.value}
        onValueChange={ids => field.onChange([...ids])}
        onOpenChange={setChannelPickerVisibility}
        candidates={channelSnapshot}
        loading={channelQuery.isPending || channelQuery.isFetching}
        {...(channelQuery.isError ? { error: channelQuery.error } : {})}
        onRetry={() => { void channelQuery.refetch(); }}
        label="关联渠道"
        disabled={saving}
      />} />
      <p className="mt-3 text-xs text-[var(--color-muted-foreground)]">已选择 {selectedChannelIds.length} 个渠道，包括可能已停用或不存在的历史 ID。完整候选成功前不能应用新的关系。</p>
    </div>

    {groupError && <ApiErrorNotice error={groupError} onRetry={() => { void refreshGroup(); }} />}
    {channelQuery.isError && <ApiErrorNotice
      error={channelQuery.error}
      onRetry={() => { void channelQuery.refetch(); }}
    />}
    {needsRefresh && <ApiErrorNotice
      error={saveError ?? new Error('请重新读取配置后继续保存。')}
      {...(group ? { onRetry: () => { void refreshGroup(); } } : {})}
    />}
    {!needsRefresh && saveError && <ApiErrorNotice error={saveError} />}
    {versionChanged && latestGroup && <div className="grid gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" role="alert">
      <p>服务端已将访问组更新到 v{latestGroup.version}；表单保留当前输入。明确采用新版本后才能保存，请先检查渠道和倍率的变更。</p>
      <Button size="sm" variant="secondary" disabled={saving || groupQuery.isFetching} onClick={adoptLatestVersion}>采用 v{latestGroup.version}，保留输入</Button>
    </div>}
    {feedback && <p role="status" className="text-sm text-[var(--color-muted-foreground)]">{feedback}</p>}
    {group && <p className="text-xs text-[var(--color-muted-foreground)]">当前配置版本：v{baseline?.version ?? group.version}。关联用户归属由独立的用户管理接口维护。</p>}
    <div className="flex flex-wrap justify-end gap-3">
      {onCancel && <Button variant="outline" disabled={saving} onClick={onCancel}>取消</Button>}
      <Button type="submit" busy={saving} disabled={!canSave}>{baseline ? '保存访问组' : '创建访问组'}</Button>
    </div>
    {!channelsComplete && !channelQuery.isError && <p role="status" className="text-xs text-[var(--color-muted-foreground)]">全部渠道候选读取成功后才能保存组关联。</p>}
  </form>;
}
