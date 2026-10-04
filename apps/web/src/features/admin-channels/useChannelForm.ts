import { useEffect, useState } from 'react';
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
  const [creationUncertain, setCreationUncertain] = useState(false);
  const creating = channel === null;

  useEffect(() => {
    if (!open || creationUncertain) return;
    setDraft(createChannelDraft(channel));
    setErrors({});
    setSaveError(null);
  }, [open, channel, creationUncertain]);

  const updateDraft = <K extends keyof ChannelDraft>(key: K, value: ChannelDraft[K]) => {
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

    setSaving(true);
    setSaveError(null);
    try {
      const saved =
        channel === null
          ? await api.create(buildChannelInput(draft))
          : await api.update(channel.id, channel.configVersion, buildChannelPatch(draft));
      onSaved(saved);
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
    creationUncertain,
    creating,
    updateDraft,
    handleOpenChange,
    submit,
  };
}
