import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiClientError } from '@cheapai/api-client/errors';
import type { ChannelView } from '@cheapai/api-client/channels';
import { withErrorContext } from '../../shared/lib/api-error';
import type { AdminChannelsApi } from './api';
import { channelCreationMayHaveSucceeded, uncertainChannelCreationMessage } from './create-outcome';
import {
  buildChannelInput,
  buildChannelPatch,
  createChannelDraft,
  validateChannelDraft,
} from './channel-form-model';
import type { ChannelDraft, ChannelFormErrors } from './channel-form-model';

export interface UseChannelFormOptions {
  readonly open: boolean;
  readonly channel: ChannelView | null;
  readonly api: AdminChannelsApi;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved: (channel: ChannelView) => void;
}

export function useChannelForm({
  open,
  channel,
  api,
  onOpenChange,
  onSaved,
}: UseChannelFormOptions) {
  const [draft, setDraft] = useState<ChannelDraft>(() => createChannelDraft(channel));
  const [errors, setErrors] = useState<ChannelFormErrors>({});
  const [saveError, setSaveError] = useState<Error | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [creationUncertain, setCreationUncertain] = useState(false);
  const creating = channel === null;
  const previous = useRef({ open: false, channel });

  useEffect(() => {
    const prior = previous.current;
    previous.current = { open, channel };
    if (!open || creationUncertain) return;
    const latest = createChannelDraft(channel);
    if (prior.open && prior.channel && channel && prior.channel.id === channel.id) {
      const baseline = createChannelDraft(prior.channel);
      setDraft((current) => {
        // Refresh untouched fields and the submit version without losing local edits.
        const merged = { ...latest };
        for (const field of Object.keys(current) as (keyof ChannelDraft)[]) {
          if (current[field] !== baseline[field])
            Object.assign(merged, { [field]: current[field] });
        }
        // Limit mode and value form one edit, even if only one input changed.
        for (const limit of ['concurrency', 'rpm'] as const) {
          const mode = `${limit}Mode` as const;
          const value = `${limit}Value` as const;
          if (current[mode] !== baseline[mode] || current[value] !== baseline[value]) {
            merged[mode] = current[mode];
            merged[value] = current[value];
          }
        }
        return merged;
      });
    } else setDraft(latest);
    setErrors({});
    setSaveError(null);
  }, [open, channel, creationUncertain]);

  const updateDraft = <K extends keyof ChannelDraft>(key: K, value: ChannelDraft[K]) => {
    setSaved(false);
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    if (!creationUncertain) setSaveError(null);
  };

  function handleOpenChange(value: boolean) {
    if (!saving && !creationUncertain) onOpenChange(value);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || creationUncertain) return;

    const nextErrors = validateChannelDraft(draft, creating);
    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) return;

    setSaved(false);
    setSaving(true);
    setSaveError(null);
    try {
      const saved =
        channel === null
          ? await api.create(buildChannelInput(draft))
          : await api.update(channel.id, channel.configVersion, buildChannelPatch(draft));
      setDraft(createChannelDraft(saved));
      onSaved(saved);
      setSaved(true);
    } catch (cause) {
      const conflict =
        cause instanceof ApiClientError && (cause.status === 409 || cause.code === 'conflict');
      const uncertain = creating && channelCreationMayHaveSucceeded(cause);
      if (uncertain) setCreationUncertain(true);
      const message = uncertain
        ? uncertainChannelCreationMessage
        : conflict
          ? '此渠道已被其他操作修改。你的输入仍保留，请关闭后重新打开最新配置，再合并后保存。'
          : cause instanceof Error
            ? cause.message
            : '渠道配置未能保存，请重试。';
      setSaveError(withErrorContext(cause, message));
    } finally {
      setSaving(false);
    }
  }

  return {
    draft,
    errors,
    saveError,
    saving,
    saved,
    creationUncertain,
    creating,
    updateDraft,
    handleOpenChange,
    submit,
  };
}
