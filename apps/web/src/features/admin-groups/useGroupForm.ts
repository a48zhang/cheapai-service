import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { ApiClientError } from '@cheapai/api-client/errors';
import { createGroupsApi } from '@cheapai/api-client/groups';
import type { GroupView } from '@cheapai/api-client/groups';
import type { ApiClient } from '@cheapai/api-client/types';
import { withErrorContext } from '../../shared/lib/api-error';
import {
  channelOptionsQueryKey,
  channelOptionsQueryOptions,
} from '../../shared/catalog/channel-options';
import { createGroupPatch, groupDraftSchema, initialGroupFormValues } from './group-form-model';
import type { GroupFormOutput, GroupFormValues } from './group-form-model';
import { groupDetailQueryOptions } from './api';

export interface UseGroupFormProps {
  readonly client: ApiClient;
  readonly actorId: string;
  readonly sessionEpoch: number;
  readonly group?: GroupView | undefined;
  readonly onSaved: (group: GroupView) => void;
}

/** Group reads, version baseline, channel readiness, conflict handling, and save lifecycle. */
export function useGroupForm({ client, actorId, sessionEpoch, group, onSaved }: UseGroupFormProps) {
  const queryClient = useQueryClient();
  const api = useMemo(() => createGroupsApi(client), [client]);
  const [channelPickerOpen, setChannelPickerOpen] = useState(false);
  const groupQuery = useQuery({
    ...groupDetailQueryOptions({ client, actorId }, group?.id ?? ''),
    enabled: group !== undefined,
  });
  const channelQuery = useQuery(
    channelOptionsQueryOptions(client, actorId, sessionEpoch, channelPickerOpen),
  );
  const [baseline, setBaseline] = useState<GroupView | null>(group ?? null);
  const [saving, setSaving] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [saveError, setSaveError] = useState<Error | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const form = useForm<GroupFormValues, unknown, GroupFormOutput>({
    resolver: zodResolver<GroupFormValues, unknown, GroupFormOutput>(groupDraftSchema),
    defaultValues: initialGroupFormValues(group),
  });

  const channelsComplete =
    channelQuery.isSuccess && !channelQuery.isFetching && !channelQuery.isError;
  const latestGroup = groupQuery.data ?? group ?? null;
  const versionChanged =
    baseline !== null && latestGroup !== null && latestGroup.version !== baseline.version;
  const canSave =
    channelsComplete &&
    !saving &&
    !needsRefresh &&
    !versionChanged &&
    (group === undefined || (groupQuery.isSuccess && !groupQuery.isError));
  const status = form.watch('status');
  const selectedChannelIds = form.watch('channelIds');
  const groupError = groupQuery.isError ? groupQuery.error : null;

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
        const patch = createGroupPatch(baseline, values);
        if (!patch) {
          setFeedback('没有需要保存的更改。');
          return;
        }
        saved = await api.update(baseline.id, baseline.version, patch);
      } else {
        saved = await api.create(values);
      }
      setBaseline(saved);
      setNeedsRefresh(false);
      setFeedback(
        baseline
          ? `访问组已保存，配置版本为 v${saved.version}。`
          : `访问组已创建，配置版本为 v${saved.version}。`,
      );
      form.reset(initialGroupFormValues(saved));
      onSaved(saved);
    } catch (error) {
      setNeedsRefresh(true);
      const conflict = error instanceof ApiClientError && error.status === 409;
      const context = conflict
        ? '访问组配置版本已变化，或此更改会破坏最后管理员保护。请重新读取后核对；输入已保留。'
        : error instanceof Error
          ? `${error.message} 保存结果可能未确认；请重新读取访问组后再继续。输入已保留。`
          : '保存结果未确认；请重新读取访问组后再继续。输入已保留。';
      setSaveError(withErrorContext(error, context));
    } finally {
      setSaving(false);
    }
  }

  function setChannelPickerVisibility(open: boolean) {
    setChannelPickerOpen(open);
    if (!open)
      void queryClient.cancelQueries({
        queryKey: channelOptionsQueryKey(actorId, sessionEpoch),
        exact: true,
      });
  }

  return {
    form,
    groupQuery,
    channelQuery,
    channelSnapshot: channelQuery.data,
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
  };
}
