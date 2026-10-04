import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { ApiClientError } from '@cheapai/api-client/errors';
import { createMappingsApi } from '@cheapai/api-client/mappings';
import type { ModelMappingView } from '@cheapai/api-client/mappings';
import type { ApiClient } from '@cheapai/api-client/types';
import { withErrorContext } from '../../shared/lib/api-error';
import {
  channelOptionsQueryKey,
  channelOptionsQueryOptions,
} from '../../shared/catalog/channel-options';
import {
  createMappingPatch,
  initialMappingFormValues,
  mappingDraftSchema,
  mappingKey,
} from './mapping-form-model';
import type { MappingFormOutput, MappingFormValues } from './mapping-form-model';
import { recordMappingSaved, modelMappingsQueryOptions } from './mapping-api';

export interface UseMappingFormProps {
  readonly client: ApiClient;
  readonly actorId: string;
  readonly sessionEpoch: number;
  readonly publicModelId: string;
  readonly initialMapping?: ModelMappingView | undefined;
  readonly onSaved?: ((mapping: ModelMappingView) => void) | undefined;
}

/** Mapping reads, selected baseline, conflict handling, and save lifecycle for the editor. */
export function useMappingForm({
  client,
  actorId,
  sessionEpoch,
  publicModelId,
  initialMapping,
  onSaved,
}: UseMappingFormProps) {
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
  const channels = useQuery(
    channelOptionsQueryOptions(client, actorId, sessionEpoch, channelPickerOpen),
  );
  const rows = useMemo(() => mappings.data?.items ?? [], [mappings.data]);
  const form = useForm<MappingFormValues, unknown, MappingFormOutput>({
    resolver: zodResolver<MappingFormValues, unknown, MappingFormOutput>(mappingDraftSchema),
    defaultValues: initialMappingFormValues(publicModelId, initialMapping),
  });
  const { reset } = form;

  useEffect(() => {
    if (!initialMapping) return;
    const initialKey = mappingKey(initialMapping);
    const key = `${publicModelId}\u0000${initialKey}`;
    if (initializedMappingKey.current === key) return;
    const current = rows.find((item) => mappingKey(item) === initialKey);
    if (!current) return;
    initializedMappingKey.current = key;
    setSelected(current);
    setNeedsRefresh(false);
    setSaveError(null);
    reset(initialMappingFormValues(publicModelId, current));
  }, [initialMapping, publicModelId, reset, rows]);

  const watchedProtocol = form.watch('protocol');
  const currentChannelId = form.watch('channelId');
  const selectedKey = selected ? mappingKey(selected) : null;
  const latestSelected =
    selectedKey === null ? null : (rows.find((item) => mappingKey(item) === selectedKey) ?? null);
  const versionChanged =
    latestSelected !== null &&
    selected !== null &&
    latestSelected.configVersion !== selected.configVersion;
  const duplicate =
    !selected &&
    currentChannelId.length > 0 &&
    rows.some((item) => item.channelId === currentChannelId && item.protocol === watchedProtocol);
  const channelsComplete = channels.isSuccess && !channels.isFetching && !channels.isError;
  const canSave =
    mappings.isSuccess &&
    !mappings.isFetching &&
    !mappings.isError &&
    (selected !== null || channelsComplete) &&
    !saving &&
    !needsRefresh &&
    !versionChanged &&
    !duplicate;

  function setChannelPickerVisibility(open: boolean) {
    setChannelPickerOpen(open);
    if (!open)
      void queryClient.cancelQueries({
        queryKey: channelOptionsQueryKey(actorId, sessionEpoch),
        exact: true,
      });
  }

  function startCreate() {
    if (saving) return;
    setSelected(null);
    setNeedsRefresh(false);
    setSaveError(null);
    setMessage(null);
    reset(initialMappingFormValues(publicModelId));
  }

  function chooseMapping(mapping: ModelMappingView) {
    if (saving) return;
    setSelected(mapping);
    setNeedsRefresh(false);
    setSaveError(null);
    setMessage(null);
    reset(initialMappingFormValues(publicModelId, mapping));
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
        const patch = createMappingPatch(baseline, values);
        if (!patch) {
          setMessage('没有需要保存的更改。');
          return;
        }
        const configVersion = selected.configVersion;
        saved = await api.updateMapping(
          publicModelId,
          selected.channelId,
          selected.protocol,
          configVersion,
          patch,
        );
      } else {
        saved = await api.createMapping(publicModelId, values);
      }
      setSelected(saved);
      setNeedsRefresh(false);
      setMessage('模型映射已保存。');
      reset(initialMappingFormValues(publicModelId, saved));
      await recordMappingSaved(queryClient, actorId, saved);
      onSaved?.(saved);
    } catch (error) {
      setNeedsRefresh(true);
      const conflict = error instanceof ApiClientError && error.status === 409;
      const context = conflict
        ? '映射配置版本已变化。请重新读取映射并核对；当前输入已保留。'
        : error instanceof Error
          ? `${error.message} 保存结果可能未确认；请重新读取映射后再继续。当前输入已保留。`
          : '保存结果未确认；请重新读取映射后再继续。当前输入已保留。';
      setSaveError(withErrorContext(error, context));
    } finally {
      setSaving(false);
    }
  }

  function retainDraftOnLatestVersion() {
    if (!latestSelected || !versionChanged) return;
    setSelected(latestSelected);
    setNeedsRefresh(false);
    setSaveError(null);
    setMessage(
      `已选用服务端映射 v${latestSelected.configVersion}，并保留当前输入。请确认上方字段后保存。`,
    );
  }

  return {
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
  };
}
