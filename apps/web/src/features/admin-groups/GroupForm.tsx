import { Controller } from 'react-hook-form';
import type { GroupView } from '@cheapai/api-client/groups';
import type { ApiClient } from '@cheapai/api-client/types';
import { ChannelPicker } from '../../shared/catalog/ChannelPicker';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';
import { Field } from '../../shared/ui/Field';
import { Input } from '../../shared/ui/Input';
import { Select } from '../../shared/ui/Select';
import { Button } from '../../shared/ui/Button';
import { useGroupForm } from './useGroupForm';

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

/** Group settings keep exact multiplier text and the existing channel IDs across candidate retries. */
export function GroupForm({
  client,
  actorId,
  sessionEpoch,
  group,
  onSaved,
  onCancel,
}: GroupFormProps) {
  const {
    form,
    groupQuery,
    channelQuery,
    channelSnapshot,
    channelsComplete,
    latestGroup,
    baseline,
    versionChanged,
    canSave,
    saving,
    needsRefresh,
    saveError,
    feedback,
    status,
    selectedChannelIds,
    groupError,
    submit,
    refreshGroup,
    adoptLatestVersion,
    setChannelPickerVisibility,
  } = useGroupForm({ client, actorId, sessionEpoch, group, onSaved });

  return (
    <form className="grid gap-5" noValidate onSubmit={form.handleSubmit(submit)}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="访问组名称"
          required
          error={form.formState.errors.name?.message}
          description="用于管理和识别访问规则。"
        >
          <Input
            {...form.register('name')}
            required
            maxLength={128}
            autoComplete="off"
            placeholder="例如：团队计划"
          />
        </Field>
        <Field
          label="计费倍率"
          required
          error={form.formState.errors.billingMultiplier?.message}
          description="保存精确十进制文本，不做浮点换算；例如 1 或 0.2。"
        >
          <Input
            {...form.register('billingMultiplier')}
            required
            maxLength={64}
            inputMode="decimal"
            autoComplete="off"
            placeholder="1"
          />
        </Field>
        <div className="grid gap-1.5">
          <label
            htmlFor="group-status"
            className="text-sm font-medium text-[var(--color-foreground)]"
          >
            组状态
          </label>
          <Controller
            name="status"
            control={form.control}
            render={({ field }) => (
              <Select
                id="group-status"
                aria-label="组状态"
                value={field.value}
                items={statusOptions}
                disabled={saving || needsRefresh}
                onValueChange={field.onChange}
              />
            )}
          />
          <span className="text-xs text-[var(--color-muted-foreground)]">
            {status === 'active'
              ? '启用组保留其当前用户和渠道关联。'
              : '停用组不再作为有效访问组；服务端会保护最后管理员。'}
          </span>
        </div>
      </div>

      <div className="rounded-lg border border-[var(--color-border)] p-4">
        <h3 className="font-medium">渠道关联</h3>
        <p className="mb-3 mt-1 text-xs leading-5 text-[var(--color-muted-foreground)]">
          选择此组可关联的渠道。服务端根据组状态、用户归属、模型映射和其他规则决定请求准入；此表单不提供最终授权预览。
        </p>
        <Controller
          name="channelIds"
          control={form.control}
          render={({ field }) => (
            <ChannelPicker
              value={field.value}
              onValueChange={(ids) => field.onChange([...ids])}
              onOpenChange={setChannelPickerVisibility}
              candidates={channelSnapshot}
              loading={channelQuery.isPending || channelQuery.isFetching}
              {...(channelQuery.isError ? { error: channelQuery.error } : {})}
              onRetry={() => {
                void channelQuery.refetch();
              }}
              label="关联渠道"
              disabled={saving}
            />
          )}
        />
        <p className="mt-3 text-xs text-[var(--color-muted-foreground)]">
          已选择 {selectedChannelIds.length} 个渠道，包括可能已停用或不存在的历史
          ID。完整候选成功前不能应用新的关系。
        </p>
      </div>

      {groupError && (
        <ApiErrorNotice
          error={groupError}
          onRetry={() => {
            void refreshGroup();
          }}
        />
      )}
      {channelQuery.isError && (
        <ApiErrorNotice
          error={channelQuery.error}
          onRetry={() => {
            void channelQuery.refetch();
          }}
        />
      )}
      {needsRefresh && (
        <ApiErrorNotice
          error={saveError ?? new Error('请重新读取配置后继续保存。')}
          {...(group
            ? {
                onRetry: () => {
                  void refreshGroup();
                },
              }
            : {})}
        />
      )}
      {!needsRefresh && saveError && <ApiErrorNotice error={saveError} />}
      {versionChanged && latestGroup && (
        <div
          className="grid gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
          role="alert"
        >
          <p>
            服务端已将访问组更新到 v{latestGroup.version}
            ；表单保留当前输入。明确采用新版本后才能保存，请先检查渠道和倍率的变更。
          </p>
          <Button
            size="sm"
            variant="secondary"
            disabled={saving || groupQuery.isFetching}
            onClick={adoptLatestVersion}
          >
            采用 v{latestGroup.version}，保留输入
          </Button>
        </div>
      )}
      {feedback && (
        <p role="status" className="text-sm text-[var(--color-muted-foreground)]">
          {feedback}
        </p>
      )}
      {group && (
        <p className="text-xs text-[var(--color-muted-foreground)]">
          当前配置版本：v{baseline?.version ?? group.version}
          。关联用户归属由独立的用户管理接口维护。
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-3">
        {onCancel && (
          <Button variant="outline" disabled={saving} onClick={onCancel}>
            取消
          </Button>
        )}
        <Button type="submit" busy={saving} disabled={!canSave}>
          {baseline ? '保存访问组' : '创建访问组'}
        </Button>
      </div>
      {!channelsComplete && !channelQuery.isError && (
        <p role="status" className="text-xs text-[var(--color-muted-foreground)]">
          全部渠道候选读取成功后才能保存组关联。
        </p>
      )}
    </form>
  );
}
