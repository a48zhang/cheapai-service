import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { ChannelView } from '@cheapai/api-client/channels';
import { ApiClientError } from '@cheapai/api-client/errors';
import { Button } from '../../shared/ui/Button';
import { ConfirmAction } from '../../shared/ui/ConfirmAction';
import { withErrorContext } from '../../shared/lib/api-error';
import { invalidateAdminChannels, recordChannelDeleted } from './api';
import type { AdminChannelsApi } from './api';

export function DeleteChannelAction({
  channel,
  api,
  actorId,
  epoch,
  busy,
  onBusyChange,
  onDeleted,
}: {
  channel: ChannelView;
  api: AdminChannelsApi;
  actorId: string;
  epoch: number;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return (
    <ConfirmAction
      trigger={
        <Button variant="danger" disabled={busy}>
          删除渠道
        </Button>
      }
      title={`删除渠道「${channel.name}」？`}
      description="删除后，此渠道及其模型映射将不再用于新请求，并从所属分组中移除。全局模型、历史请求和账单会保留。"
      confirmLabel="删除渠道"
      onConfirm={async () => {
        onBusyChange(true);
        try {
          await api.delete(channel.id, channel.configVersion);
        } catch (error) {
          if (error instanceof ApiClientError && (error.status === 409 || error.status === 404)) {
            void invalidateAdminChannels(queryClient, actorId, epoch);
            throw withErrorContext(error, '渠道已被修改或删除，请关闭确认框，重新读取后再操作。');
          }
          throw error;
        } finally {
          onBusyChange(false);
        }
        onDeleted();
        navigate('/admin/channels', {
          replace: true,
          state: { notice: '渠道已删除，历史请求和账单已保留。' },
        });
        await recordChannelDeleted(queryClient, actorId, epoch, channel.id);
      }}
    />
  );
}
