import { useQuery } from '@tanstack/react-query';
import { createAdminRegistrationApi } from '@cheapai/api-client/registration-admin';
import { useSession } from '../../features/session/useSession';
import { registrationSettingsQuery } from '../../features/admin-registration/api';
import { SettingsForm } from '../../features/admin-registration/SettingsForm';
import { PageHeader } from '../../shared/patterns/PageHeader';
import { ApiErrorNotice } from '../../shared/patterns/ApiErrorNotice';

export default function RegistrationSettingsPage() {
  const { client, user, queryClient } = useSession();
  const options = registrationSettingsQuery(client, user!.id);
  const query = useQuery(options);
  return (
    <>
      <PageHeader heading="注册设置" description="控制账户注册与邮箱验证。" />
      {query.isPending ? (
        <p role="status">正在读取注册策略…</p>
      ) : query.data ? (
        <SettingsForm
          settings={query.data}
          onSave={async (version, mode, verification) => {
            const next = await createAdminRegistrationApi(client).updateSettings(
              version,
              mode,
              verification,
            );
            queryClient.setQueryData(options.queryKey, next);
          }}
        />
      ) : (
        <ApiErrorNotice error={query.error} onRetry={() => void query.refetch()} />
      )}
    </>
  );
}
